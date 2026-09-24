use self::response::{
    decode_href, href_basename, parse_http_date, parse_propfind, resumed_response_start,
    validate_content_range,
};
use super::backend_logger::{BackendLogger, LogSink};
use super::transfer_file;
use super::{
    BackendResult, EntryInfo, LogKind, LogText, ProgressInfo, ProgressSink, ProtocolBackend,
};
use crate::ipc::ErrorCode;
use crate::security::connection_guard::is_safe_path_segment;
use anyhow::{Context, bail};
use async_trait::async_trait;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client, Method, StatusCode};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod response;

pub const MAX_PROPFIND_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// A redirect the client did not follow: it leads to another origin, where
/// the credentials must not be sent without the user choosing that address.
#[derive(Debug)]
struct CrossOriginRedirect(String);

impl std::fmt::Display for CrossOriginRedirect {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "the server redirects to {}", self.0)
    }
}

impl std::error::Error for CrossOriginRedirect {}

/// Follows redirects within the origin a request was sent to, where its
/// credentials already go, and stops at any other.
fn same_origin_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let Some(first) = attempt.previous().first() else {
            return attempt.follow();
        };
        let same = attempt.url().scheme() == first.scheme()
            && attempt.url().host_str() == first.host_str()
            && attempt.url().port_or_known_default() == first.port_or_known_default();
        if !same {
            attempt.stop()
        } else if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    })
}

/// The address to use instead of `base` when `location` only moves the same
/// host and path from HTTP to HTTPS.
fn https_upgrade(base: &str, location: &str) -> Option<String> {
    let from = reqwest::Url::parse(&format!("{}/", base.trim_end_matches('/'))).ok()?;
    let to = from.join(location).ok()?;
    let same_path = from.path().trim_end_matches('/') == to.path().trim_end_matches('/');
    (from.scheme() == "http"
        && to.scheme() == "https"
        && from.host_str() == to.host_str()
        && same_path
        && to.query().is_none())
    .then(|| to.as_str().trim_end_matches('/').to_owned())
}

/// Whether this address would carry a password in the clear.
fn is_cleartext(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|parsed| parsed.scheme() == "http")
}

/// The version a partial download is tied to: a strong ETag, else
/// Last-Modified. None when the file changed within the second the reply was
/// dated (RFC 9110 8.8.2.2): it can change again in that second without a new
/// Last-Modified, and servers such as nginx build their ETag from that same
/// second, so the version could not tell the new content from the old.
fn resume_version(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let date = |name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_http_date)
    };
    if let (Some(modified), Some(dated)) = (
        date(reqwest::header::LAST_MODIFIED),
        date(reqwest::header::DATE),
    ) && modified >= dated
    {
        return None;
    }
    headers
        .get(reqwest::header::ETAG)
        .or_else(|| headers.get(reqwest::header::LAST_MODIFIED))
        .and_then(|value| value.to_str().ok())
        .filter(|version| !version.starts_with("W/"))
        .map(str::to_owned)
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/></D:prop></D:propfind>"#;

struct UploadBody {
    data: tokio::io::DuplexStream,
    activity: std::sync::Arc<tokio::sync::Notify>,
}
impl tokio::io::AsyncRead for UploadBody {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = std::pin::Pin::new(&mut self.data).poll_read(cx, buffer);
        if buffer.filled().len() > before {
            self.activity.notify_one();
        }
        result
    }
}

#[derive(Default)]
pub struct WebDavBackend {
    client: Option<Client>,
    upload_client: Option<Client>,
    idle_timeout: Duration,
    base_url: String,
    user: String,
    password: super::SensitiveString,
    /// Whether this connection earned the right to carry the password: it is
    /// HTTPS, or the user allowed unencrypted sign-in. It defaults to false,
    /// so a backend that never connected cannot send one either.
    send_credentials: bool,
    connected: bool,
    logger: BackendLogger,
    /// Carries the connection's SOCKS4 proxy, which reqwest cannot speak.
    socks_bridge: Option<super::socks_bridge::SocksBridge>,
}

impl WebDavBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn log_kind(&self, line: impl Into<LogText>, kind: LogKind) {
        self.logger.emit(line, kind);
    }

    // See ftp.rs's identical helper's doc comment — human-authored,
    // translated log line vs. `log`/`log_kind`'s untranslated raw text.
    fn log_key(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.logger.event(key, params, kind);
    }

    fn build_url(&self, path: &str) -> String {
        let encoded: Vec<String> = path
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|seg| utf8_percent_encode(seg, PATH_SEGMENT).to_string())
            .collect();
        format!("{}/{}", self.base_url, encoded.join("/"))
    }

    fn client(&self) -> BackendResult<&Client> {
        self.client.as_ref().ok_or_else(|| {
            super::fail(
                ErrorCode::ConnectionLost,
                "No active connection to the server",
            )
        })
    }

    async fn download_file(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: &ProgressSink,
    ) -> BackendResult<()> {
        let target = transfer_file::DownloadTarget::reserve(local_path).await?;
        let remote_size = self.known_size(remote_path).await;
        let version = self
            .request(Method::HEAD, remote_path)?
            .send()
            .await
            .ok()
            .filter(|response| response.status().is_success())
            .and_then(|response| resume_version(response.headers()));
        let source = transfer_file::SourceIdentity {
            endpoint: serde_json::json!(["webdav", self.base_url, self.user]).to_string(),
            remote_path: remote_path.to_string(),
            size: remote_size,
            version: version.clone(),
        };
        let origin = crate::local_fs::provenance::Origin::for_url(&self.base_url, remote_path);
        let Some(download) = target.prepare(resume, source, origin).await? else {
            return Ok(());
        };

        let start_at = download.start();
        // The length the response promises, once it is known; the metadata
        // size until then.
        let mut expected_length = remote_size;
        let written: BackendResult<u64> = async {
            let range_note = if start_at > 0 {
                format!(" (Range: bytes={start_at}-)")
            } else {
                String::new()
            };
            self.log_kind(format!("GET {remote_path}{range_note}"), LogKind::Command);
            let mut req = self.request(Method::GET, remote_path)?;
            if start_at > 0 {
                req = req.header("Range", format!("bytes={start_at}-"));
                if let Some(version) = &version {
                    req = req.header(reqwest::header::IF_RANGE, version);
                }
            }
            let res = req.send().await.context("GET request failed")?;
            resumed_response_start(res.status(), start_at)?;
            if !res.status().is_success() {
                return Err(response::status_error(res.status().as_u16(), "GET"));
            }
            let range_end = if res.status() == StatusCode::PARTIAL_CONTENT {
                Some(validate_content_range(
                    res.headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|v| v.to_str().ok()),
                    start_at,
                    remote_size,
                )?)
            } else {
                None
            };
            let effective_start =
                if resumed_response_start(res.status(), start_at)? == 0 && start_at > 0 {
                    self.log_key(
                        "davResumeUnsupportedServer",
                        serde_json::json!({ "expected": 206, "status": res.status().as_u16() }),
                        LogKind::Status,
                    );
                    0
                } else {
                    start_at
                };

            let mut file = download.open_at(effective_start).await?;

            let body_end = res
                .content_length()
                .and_then(|length| effective_start.checked_add(length));
            if let (Some(body), Some(range)) = (body_end, range_end) {
                transfer_file::validate_length(body, Some(range))?;
            }
            expected_length = range_end.or(body_end).or(remote_size);
            if let (Some(expected), Some(advertised)) = (expected_length, remote_size) {
                transfer_file::validate_length(expected, Some(advertised))?;
            }
            let mut transferred = effective_start;
            let mut res = res;
            while let Some(chunk) = res.chunk().await.context("reading from server")? {
                transfer_file::validate_resume_offset(
                    transferred
                        .checked_add(chunk.len() as u64)
                        .context("WebDAV size overflow")?,
                    expected_length,
                )?;
                file.write_all(&chunk).await.context("writing local file")?;
                crate::transfer::rate_limiter::acquire_paced(chunk.len() as u64, |slice| {
                    transferred += slice;
                    progress(ProgressInfo::Progress {
                        bytes: transferred,
                        total: remote_size.unwrap_or(0),
                    });
                })
                .await;
            }
            file.flush().await.context("flushing local file")?;
            Ok(transferred)
        }
        .await;
        download.finish(written, expected_length).await
    }

    fn build_proxy(cfg: &super::transport::ProxyConfig) -> BackendResult<reqwest::Proxy> {
        reqwest::Proxy::all(Self::proxy_url(cfg)?).context("invalid proxy configuration")
    }

    fn proxy_url(cfg: &super::transport::ProxyConfig) -> BackendResult<reqwest::Url> {
        use super::transport::ProxyKind;
        use zeroize::Zeroize;
        let scheme = match cfg.kind {
            // The proxy resolves the server's name, as it does for FTP and
            // SFTP: a name only the proxy's network knows still connects.
            // reqwest cannot speak SOCKS4; connect bridges it as SOCKS5.
            ProxyKind::Socks4 => bail!("a SOCKS4 proxy has to go through the SOCKS bridge"),
            ProxyKind::Socks5 => "socks5h",
            ProxyKind::Http => "http",
        };
        // Built field by field rather than as one string, so an IPv6 host gets
        // its brackets and the credentials cannot spill into the authority.
        let mut url = reqwest::Url::parse(&format!("{scheme}://{}", cfg.authority()))
            .context("invalid proxy configuration")?;
        if let Some(user) = &cfg.username {
            url.set_username(&utf8_percent_encode(user, NON_ALPHANUMERIC).to_string())
                .ok()
                .context("invalid proxy user name")?;
        }
        if let (Some(_), Some(password)) = (&cfg.username, &cfg.password) {
            // Encoded first: the URL leaves a `%` as it is, and reqwest would
            // decode `%20` in a password into a space.
            let mut encoded = utf8_percent_encode(password.expose(), NON_ALPHANUMERIC).to_string();
            let set = url.set_password(Some(&encoded));
            encoded.zeroize();
            set.ok().context("invalid proxy password")?;
        }
        Ok(url)
    }

    /// A collection's URL ends in a slash (RFC 4918 section 5.2). Most servers
    /// accept one without it, but nginx answers 409 to MKCOL or DELETE then.
    fn collection_url(&self, path: &str) -> String {
        let mut url = self.build_url(path);
        if !url.ends_with('/') {
            url.push('/');
        }
        url
    }

    /// The credentials this connection is allowed to put on the wire. An
    /// unencrypted connection the user did not mark as allowed sends none.
    fn credentials(&self) -> (&str, &str) {
        if self.send_credentials {
            (self.user.as_str(), self.password.expose())
        } else {
            ("", "")
        }
    }

    fn request(&self, method: Method, path: &str) -> BackendResult<reqwest::RequestBuilder> {
        self.request_url(method, self.build_url(path))
    }

    fn request_url(&self, method: Method, url: String) -> BackendResult<reqwest::RequestBuilder> {
        let client = if method == Method::PUT {
            self.upload_client.as_ref().unwrap_or(self.client()?)
        } else {
            self.client()?
        };
        let mut req = client.request(method, url);
        let (user, password) = self.credentials();
        if !user.is_empty() || !password.is_empty() {
            req = req.basic_auth(user, Some(password.to_owned()));
        }
        Ok(req)
    }

    async fn propfind(
        client: &Client,
        url: String,
        depth: u8,
        user: &str,
        password: &str,
    ) -> BackendResult<String> {
        let mut req = client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), url)
            .header("Depth", depth.to_string())
            .header("Content-Type", "application/xml")
            .body(PROPFIND_BODY);
        if !user.is_empty() || !password.is_empty() {
            req = req.basic_auth(user, Some(password));
        }
        let mut res = req.send().await.context("PROPFIND request failed")?;
        let status = res.status();
        if status.is_redirection() {
            let location = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            return Err(anyhow::Error::new(CrossOriginRedirect(location)).context(
                crate::ipc::CommandError::new(
                    ErrorCode::InvalidInput,
                    "The WebDAV server redirects to another address",
                ),
            ));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(super::fail(
                ErrorCode::NotFound,
                "WebDAV resource does not exist",
            ));
        }
        // Classify errors before reading an arbitrary (possibly stalled or
        // non-UTF-8) error body. It carries no directory metadata.
        if status != StatusCode::MULTI_STATUS && status != StatusCode::OK {
            return Err(response::status_error(status.as_u16(), "PROPFIND"));
        }
        if res
            .content_length()
            .is_some_and(|length| length > MAX_PROPFIND_RESPONSE_BYTES as u64)
        {
            bail!(crate::ipc::CommandError::new(
                crate::ipc::ErrorCode::ResourceLimit,
                "WebDAV XML response exceeds the 8 MiB limit",
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = res
            .chunk()
            .await
            .context("reading PROPFIND response body")?
        {
            if body.len().saturating_add(chunk.len()) > MAX_PROPFIND_RESPONSE_BYTES {
                bail!(crate::ipc::CommandError::new(
                    crate::ipc::ErrorCode::ResourceLimit,
                    "WebDAV XML response exceeds the 8 MiB limit",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(body).context("PROPFIND response is not UTF-8")?;
        Ok(text)
    }

    async fn send_upload(
        &self,
        path: &str,
        reader: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        length: Option<u64>,
        progress: ProgressSink,
    ) -> BackendResult<reqwest::Response> {
        self.send_upload_with_limiter(
            path,
            reader,
            length,
            progress,
            crate::transfer::rate_limiter::shared(),
        )
        .await
    }

    async fn send_upload_with_limiter(
        &self,
        path: &str,
        reader: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        length: Option<u64>,
        progress: ProgressSink,
        limiter: &crate::transfer::rate_limiter::RateLimiter,
    ) -> BackendResult<reqwest::Response> {
        // Sixteen bodies at most: 64 KiB each for producer, pipe and ReaderStream.
        static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
        let _permit = SLOTS.acquire().await?;
        let activity = std::sync::Arc::new(tokio::sync::Notify::new());
        let (mut writer, data) = tokio::io::duplex(64 * 1024);
        let body = UploadBody {
            data,
            activity: activity.clone(),
        };
        let mut request = self.request(Method::PUT, path)?;
        if let Some(length) = length {
            request = request.header(reqwest::header::CONTENT_LENGTH, length);
        }
        let request = request
            .body(reqwest::Body::wrap_stream(
                tokio_util::io::ReaderStream::with_capacity(body, 64 * 1024),
            ))
            .send();
        let produce = async {
            let mut chunk = vec![0; 64 * 1024];
            let mut transferred = 0;
            loop {
                let remaining = length.map(|total| total.saturating_sub(transferred));
                if remaining == Some(0) {
                    break;
                }
                let capacity = limiter.paced_chunk_size(
                    remaining
                        .unwrap_or(chunk.len() as u64)
                        .min(chunk.len() as u64) as usize,
                );
                let n =
                    tokio::time::timeout(self.idle_timeout, reader.read(&mut chunk[..capacity]))
                        .await??;
                if n == 0 {
                    break;
                }
                limiter
                    .acquire_paced(n as u64, |_| {
                        activity.notify_one();
                    })
                    .await;
                tokio::time::timeout(self.idle_timeout, writer.write_all(&chunk[..n])).await??;
                transferred += n as u64;
                progress(ProgressInfo::Progress {
                    bytes: transferred,
                    total: length.unwrap_or(0),
                });
            }
            transfer_file::validate_length(transferred, length)?;
            writer.shutdown().await?;
            Ok::<_, anyhow::Error>(())
        };
        let send = async {
            tokio::pin!(request);
            loop {
                tokio::select! {
                    biased;
                    result = &mut request => {
                        let response = result.context("PUT request failed")?;
                        if !response.status().is_success() {
                            return Err(response::status_error(response.status().as_u16(), "PUT"));
                        }
                        return Ok(response);
                    },
                    _ = activity.notified() => {},
                    _ = tokio::time::sleep(self.idle_timeout) => return Err(super::fail(ErrorCode::TimedOut, "WebDAV upload stalled")),
                }
            }
        };
        let (_, response) = tokio::try_join!(produce, send)?;
        Ok(response)
    }

    async fn resource_exists(&self, path: &str) -> BackendResult<bool> {
        let client = self.client()?.clone();
        let url = self.build_url(path);
        let (user, password) = self.credentials();
        match Self::propfind(&client, url, 0, user, password).await {
            Ok(xml) => Ok(!parse_propfind(&xml)?.is_empty()),
            Err(error)
                if crate::ipc::CommandError::from_anyhow(&error).code == ErrorCode::NotFound =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Whether a file, rather than a collection, stands at `path`.
    async fn file_exists(&self, path: &str) -> BackendResult<bool> {
        let client = self.client()?.clone();
        let url = self.build_url(path);
        let (user, password) = self.credentials();
        match Self::propfind(&client, url, 0, user, password).await {
            Ok(xml) => Ok(parse_propfind(&xml)?
                .first()
                .is_some_and(|entry| !entry.is_dir)),
            Err(error)
                if crate::ipc::CommandError::from_anyhow(&error).code == ErrorCode::NotFound =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    async fn send_move(
        &self,
        old_path: &str,
        new_path: &str,
        overwrite: bool,
    ) -> BackendResult<reqwest::Response> {
        self.log_kind(format!("MOVE {old_path} -> {new_path}"), LogKind::Command);
        self.request(Method::from_bytes(b"MOVE")?, old_path)?
            .header("Destination", self.build_url(new_path))
            .header("Overwrite", if overwrite { "T" } else { "F" })
            .send()
            .await
            .context("MOVE request failed")
    }

    async fn mutation_result(mut res: reqwest::Response, operation: &str) -> BackendResult<()> {
        if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), operation));
        }
        if res.status() == StatusCode::MULTI_STATUS {
            let mut body = Vec::new();
            while let Some(chunk) = res.chunk().await? {
                if body.len().saturating_add(chunk.len()) > MAX_PROPFIND_RESPONSE_BYTES {
                    return Err(super::fail(
                        ErrorCode::ResourceLimit,
                        "WebDAV multi-status response exceeds its byte budget",
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            let entries = parse_propfind(std::str::from_utf8(&body)?)?;
            anyhow::ensure!(
                !entries.is_empty(),
                "WebDAV {operation} returned an empty multi-status response"
            );
        }
        Ok(())
    }
}

#[async_trait]
impl ProtocolBackend for WebDavBackend {
    async fn connect(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.disconnect().await.ok();
        let crate::protocol::config::ConnectionConfig::Webdav(config) = config else {
            bail!("WebDAV backend received a non-WebDAV configuration");
        };
        let webdav_url = config.url.clone();
        let user = config.user.clone();
        let password = config.password.clone();
        let allow_invalid_cert = config.allow_invalid_cert;
        let allow_cleartext_auth = config.allow_cleartext_auth;
        let ca_cert_path = config.ca_cert_path.clone();
        let timeout_ms = config.common.timeout_ms;

        self.log_key(
            "connecting",
            serde_json::json!({ "addr": &webdav_url }),
            LogKind::Status,
        );

        let idle = Duration::from_millis(if timeout_ms == 0 { 60_000 } else { timeout_ms });
        let proxy = match &config.common.proxy {
            Some(proxy) if proxy.kind == super::transport::ProxyKind::Socks4 => {
                let bridge = super::socks_bridge::start(proxy.clone()).await?;
                let proxy = reqwest::Proxy::all(&bridge.url).context("invalid proxy configuration");
                self.socks_bridge = Some(bridge);
                Some(proxy?)
            }
            Some(proxy) => Some(Self::build_proxy(proxy)?),
            None => None,
        };
        let build_client = |read_timeout: bool| -> BackendResult<Client> {
            let mut builder = Client::builder().redirect(same_origin_redirects());
            // reqwest reads HTTP_PROXY/HTTPS_PROXY from the environment by
            // default. A connection configured without a proxy has to take
            // the route the settings describe, not one an inherited variable
            // chooses, so the absence of a proxy is stated rather than left
            // to a default.
            if proxy.is_none() {
                builder = builder.no_proxy();
            }
            if read_timeout {
                builder = builder.read_timeout(idle);
            }
            if allow_invalid_cert {
                // Explicit per-connection opt-in, guarded by connection authorization;
                // the warning below remains visible. Review this exception with that policy.
                // nosemgrep: rust-disabled-tls-verification
                builder = builder.danger_accept_invalid_certs(true);
                self.log_kind(
                "WARNING: TLS certificate verification is disabled for this connection (allowInvalidCert) — the server's identity is not being checked.".to_string(),
                LogKind::Error,
            );
            } else if let Some(path) = &ca_cert_path {
                let pem_bytes = std::fs::read(path)
                    .with_context(|| format!("failed to read CA certificate \"{path}\""))?;
                let certs = reqwest::Certificate::from_pem_bundle(&pem_bytes)
                    .with_context(|| format!("failed to parse CA certificate \"{path}\""))?;
                for cert in certs {
                    builder = builder.add_root_certificate(cert);
                }
            }
            if let Some(proxy) = &proxy {
                builder = builder.proxy(proxy.clone());
            }
            builder.build().context("failed to create HTTP client")
        };
        let client = build_client(true)?;
        let upload_client = build_client(false)?;

        self.log_kind("PROPFIND / (Depth: 0)", LogKind::Command);
        let mut webdav_url = webdav_url;
        // An http:// address does not get the password on the strength of a
        // redirect that has not happened yet. The first request goes out
        // unauthenticated, and only an address that is already HTTPS, or a
        // connection the user marked as allowed to authenticate in the
        // clear, carries credentials.
        let has_credentials = !user.is_empty() || !password.is_empty();
        let mut send_credentials =
            !is_cleartext(&webdav_url) || allow_cleartext_auth || !has_credentials;
        let probe = async {
            let mut upgraded = false;
            loop {
                let (probe_user, probe_password) = if send_credentials {
                    (user.as_str(), password.expose())
                } else {
                    ("", "")
                };
                let reply = Self::propfind(
                    &client,
                    format!("{webdav_url}/"),
                    0,
                    probe_user,
                    probe_password,
                )
                .await;
                // An http:// address the server moves to https:// on the same
                // host is taken as that; the user already chose the host.
                let upgrade = reply.as_ref().err().and_then(|error| {
                    error
                        .chain()
                        .find_map(|cause| cause.downcast_ref::<CrossOriginRedirect>())
                        .and_then(|redirect| https_upgrade(&webdav_url, &redirect.0))
                });
                if let Some(address) = upgrade.filter(|_| !upgraded) {
                    self.log_kind(format!("Redirected to {address}"), LogKind::Status);
                    webdav_url = address;
                    upgraded = true;
                    // The address is HTTPS now, so the credentials can go.
                    send_credentials = true;
                    continue;
                }
                let needs_login = reply.as_ref().err().is_some_and(|error| {
                    error
                        .chain()
                        .any(|cause| cause.is::<response::Unauthorized>())
                });
                // The server wants a password and the connection is still in
                // the clear. Saying so is the point: no silent cleartext
                // fallback, and no password sent to find out.
                if needs_login && !send_credentials {
                    return Err(super::fail(
                        ErrorCode::PermissionDenied,
                        "This WebDAV server asks for a password over an unencrypted connection. Use an https:// address, or allow unencrypted sign-in for this connection.",
                    ));
                }
                let reply = reply.map_err(|error| {
                    if needs_login {
                        super::fail(
                            ErrorCode::AuthFailed,
                            "The WebDAV server rejected the login",
                        )
                    } else {
                        error
                    }
                })?;
                anyhow::ensure!(
                    !parse_propfind(&reply)?.is_empty(),
                    "WebDAV server returned no resource metadata"
                );
                return Ok::<(), anyhow::Error>(());
            }
        };
        let outcome = if timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), probe).await {
                Ok(inner) => inner,
                Err(_) => Err(super::fail(
                    ErrorCode::TimedOut,
                    "Connection attempt timed out",
                )),
            }
        } else {
            probe.await
        };
        if let Err(err) = outcome {
            self.log_key(
                "connectFailed",
                serde_json::json!({ "error": format!("{err}") }),
                LogKind::Error,
            );
            return Err(err);
        }

        self.log_key("connected", serde_json::json!({}), LogKind::Response);
        self.client = Some(client);
        self.upload_client = Some(upload_client);
        self.idle_timeout = idle;
        self.base_url = webdav_url;
        self.user = user;
        self.password = password;
        self.send_credentials = send_credentials;
        self.connected = true;
        Ok(())
    }

    async fn disconnect(&mut self) -> BackendResult<()> {
        self.client = None;
        self.upload_client = None;
        self.socks_bridge = None;
        // The session is over, so its credentials go with it rather than
        // sitting in this struct until something else drops it.
        self.password = super::SensitiveString::default();
        self.user = String::new();
        self.send_credentials = false;
        self.connected = false;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn set_log_sink(&mut self, sink: Option<LogSink>) {
        self.logger.set_sink(sink);
    }

    fn log_event(&self, key: &'static str, params: serde_json::Value, kind: LogKind) {
        self.log_key(key, params, kind);
    }

    async fn list(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        let target = if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        };
        self.log_kind(format!("PROPFIND {target} (Depth: 1)"), LogKind::Command);
        let client = self.client()?.clone();
        let url = self.build_url(&target);
        let (user, password) = {
            let (user, password) = self.credentials();
            (user.to_owned(), password.to_owned())
        };
        let xml = match Self::propfind(&client, url, 1, &user, &password).await {
            Ok(xml) => xml,
            Err(err) => {
                self.log_key(
                    "listFailed",
                    serde_json::json!({ "error": format!("{err:#}") }),
                    LogKind::Error,
                );
                return Err(err);
            }
        };
        let raw_entries = parse_propfind(&xml)?;

        let self_path = decode_href(&self.build_url(&target));
        let self_path = self_path.trim_end_matches('/');

        let mut entries = Vec::with_capacity(raw_entries.len());
        for raw in raw_entries {
            let decoded = decode_href(&raw.href);
            if decoded.trim_end_matches('/') == self_path {
                continue; // the listed directory itself, not a child entry
            }
            let child = decoded
                .trim_end_matches('/')
                .strip_prefix(self_path)
                .and_then(|path| path.strip_prefix('/'));
            if child.is_none_or(|name| name.is_empty() || name.contains('/')) {
                continue;
            }
            let name = href_basename(&decoded);
            if !is_safe_path_segment(&name) {
                self.log_key(
                    "skippedUnsafeEntry",
                    serde_json::json!({ "name": name }),
                    LogKind::Status,
                );
                continue;
            }
            entries.push(EntryInfo {
                name,
                is_directory: raw.is_dir,
                size: raw.size.unwrap_or(0),
                modified_at: raw
                    .last_modified
                    .as_deref()
                    .and_then(parse_http_date)
                    .map(|d| d.to_rfc3339()),
                // WebDAV has no Unix rwx/owner/group concept.
                permissions: None,
                owner: None,
                group: None,
            });
        }
        self.log_key(
            "receivedEntries",
            serde_json::json!({ "count": entries.len() }),
            LogKind::Response,
        );
        Ok(entries)
    }

    async fn mkdir(&mut self, path: &str) -> BackendResult<()> {
        let mut current = String::new();
        for segment in path
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
        {
            current.push('/');
            current.push_str(segment);
            self.log_kind(format!("MKCOL {current}"), LogKind::Command);
            let res = self
                .request_url(
                    Method::from_bytes(b"MKCOL").unwrap(),
                    self.collection_url(&current),
                )?
                .send()
                .await
                .context("MKCOL request failed")?;
            if res.status() == StatusCode::METHOD_NOT_ALLOWED {
                // 405 can also mean MKCOL is disabled or a regular file is in
                // the way. Only an existing collection satisfies mkdir.
                let xml = Self::propfind(
                    self.client()?,
                    self.build_url(&current),
                    0,
                    &self.user,
                    self.credentials().1,
                )
                .await?;
                anyhow::ensure!(
                    parse_propfind(&xml)?
                        .first()
                        .is_some_and(|entry| entry.is_dir),
                    "MKCOL {current}: existing resource is not a collection"
                );
            } else if !res.status().is_success() {
                return Err(response::status_error(res.status().as_u16(), "MKCOL"));
            }
        }
        Ok(())
    }

    async fn create_file(&mut self, path: &str) -> BackendResult<()> {
        self.log_kind(
            format!("PUT {path} (creating empty file)"),
            LogKind::Command,
        );
        let already_exists = || {
            let name = path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(path);
            super::fail(
                ErrorCode::AlreadyExists,
                format!("\"{name}\" already exists"),
            )
        };
        if self.resource_exists(path).await? {
            return Err(already_exists());
        }
        let res = self
            .request(Method::PUT, path)?
            .header(reqwest::header::IF_NONE_MATCH, "*")
            .body(Vec::new())
            .timeout(self.idle_timeout)
            .send()
            .await
            .context("PUT request failed")?;
        // Under If-None-Match: *, 412 is a file that arrived after the PROPFIND.
        if res.status() == StatusCode::PRECONDITION_FAILED {
            return Err(already_exists());
        }
        if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), "PUT"));
        }
        Ok(())
    }

    async fn remove(&mut self, path: &str, is_dir: bool) -> BackendResult<()> {
        self.log_kind(format!("DELETE {path}"), LogKind::Command);
        let url = if is_dir {
            self.collection_url(path)
        } else {
            self.build_url(path)
        };
        let res = self
            .request_url(Method::DELETE, url)?
            .send()
            .await
            .context("DELETE request failed")?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Self::mutation_result(res, "DELETE").await
    }

    /// Some servers turn down replacing an existing file even under
    /// `Overwrite: T`. Refused while both still stand, with a file in the
    /// way, the existing file is set aside so the new one can take its name.
    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let reply = self.send_move(old_path, new_path, true).await?;
        let status = reply.status();
        if matches!(
            status,
            StatusCode::PRECONDITION_FAILED
                | StatusCode::FORBIDDEN
                | StatusCode::METHOD_NOT_ALLOWED
                | StatusCode::CONFLICT
                | StatusCode::NOT_IMPLEMENTED
        ) {
            drop(reply);
            if self.file_exists(new_path).await? && self.resource_exists(old_path).await? {
                return super::replace_by_setting_aside(self, old_path, new_path).await;
            }
            return Err(response::status_error(status.as_u16(), "MOVE"));
        }
        Self::mutation_result(reply, "MOVE").await
    }

    async fn size(&mut self, path: &str) -> u64 {
        self.known_size(path).await.unwrap_or(0)
    }

    async fn rename_no_replace(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let response = self.send_move(old_path, new_path, false).await?;
        // Under Overwrite: F, 412 is the server saying the destination is taken.
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(super::fail(
                ErrorCode::AlreadyExists,
                format!("{new_path} already exists on the server; it was not replaced"),
            ));
        }
        Self::mutation_result(response, "MOVE").await
    }

    async fn known_size(&mut self, path: &str) -> Option<u64> {
        let Ok(client) = self.client().cloned() else {
            return None;
        };
        let url = self.build_url(path);
        let (user, password) = {
            let (user, password) = self.credentials();
            (user.to_owned(), password.to_owned())
        };
        let Ok(xml) = Self::propfind(&client, url, 0, &user, &password).await else {
            return None;
        };
        parse_propfind(&xml)
            .ok()
            .and_then(|v| v.into_iter().next())
            .and_then(|e| e.size)
    }

    async fn upload(
        &mut self,
        local_path: &Path,
        remote_path: &str,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()> {
        if resume {
            self.log_key(
                "davResumeUnsupportedLocal",
                serde_json::json!({}),
                LogKind::Status,
            );
        }

        let result: BackendResult<()> = async {
            let mut file = tokio::fs::File::open(local_path)
                .await
                .context("opening local file")?;
            let total = file
                .metadata()
                .await
                .context("reading local file metadata")?
                .len();
            progress(ProgressInfo::Progress { bytes: 0, total });
            self.log_kind(format!("PUT {remote_path}"), LogKind::Command);
            let res = self
                .send_upload(remote_path, &mut file, Some(total), progress.clone())
                .await?;
            transfer_file::validate_length(file.metadata().await?.len(), Some(total))?;
            if !res.status().is_success() {
                return Err(response::status_error(res.status().as_u16(), "PUT"));
            }
            let actual = self.known_size(remote_path).await;
            transfer_file::validate_length(actual.unwrap_or(total), Some(total))?;
            progress(ProgressInfo::Progress {
                bytes: total,
                total,
            });
            Ok(())
        }
        .await;

        match &result {
            Ok(()) => progress(ProgressInfo::Done),
            Err(err) => progress(ProgressInfo::failed(err)),
        }
        result
    }

    async fn download(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: ProgressSink,
    ) -> BackendResult<()> {
        let result = self
            .download_file(remote_path, local_path, resume, &progress)
            .await;
        transfer_file::report_outcome(&result, &progress);
        result
    }

    async fn download_to_writer(
        &mut self,
        remote_path: &str,
        writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> BackendResult<()> {
        self.log_kind(format!("GET {remote_path}"), LogKind::Command);
        let res = self
            .request(Method::GET, remote_path)?
            .send()
            .await
            .context("GET request failed")?;
        resumed_response_start(res.status(), 0)?;
        if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), "GET"));
        }
        let mut res = res;
        while let Some(chunk) = res.chunk().await.context("reading from server")? {
            tokio::time::timeout(self.idle_timeout, writer.write_all(&chunk))
                .await?
                .context("relaying to target")?;
            crate::transfer::rate_limiter::acquire_paced(chunk.len() as u64, |_| {}).await;
        }
        Ok(())
    }

    async fn upload_from_reader(
        &mut self,
        reader: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        remote_path: &str,
    ) -> BackendResult<()> {
        self.log_kind(format!("PUT {remote_path}"), LogKind::Command);
        let res = self
            .send_upload(remote_path, reader, None, std::sync::Arc::new(|_| {}))
            .await?;
        if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), "PUT"));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "webdav_tests.rs"]
mod protocol_tests;
