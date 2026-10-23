use self::response::{
    decode_href, href_basename, parse_http_date, parse_propfind, resumed_response_start,
    validate_content_range,
};
use super::backend_logger::{BackendLogger, LogSink};
use super::transfer_file;
use super::{BackendResult, EntryInfo, LogKind, ProgressInfo, ProgressSink, ProtocolBackend};
use crate::ipc::ErrorCode;
use crate::security::connection_guard::is_safe_path_segment;
use anyhow::{Context, bail};
use async_trait::async_trait;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client, Method, StatusCode};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
mod requests;

mod connect;
mod response;

pub const MAX_PROPFIND_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

fn too_large_message() -> String {
    format!(
        "WebDAV XML response exceeds the {} MiB limit",
        MAX_PROPFIND_RESPONSE_BYTES >> 20
    )
}

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

    /// What the server says about the file: its size and a strong ETag or
    /// a modification time.
    async fn source_identity(&mut self, remote_path: &str) -> transfer_file::SourceIdentity {
        let remote_size = self.known_size(remote_path).await;
        let version = match self.request(Method::HEAD, remote_path) {
            Ok(request) => request.send().await.ok(),
            Err(_) => None,
        }
        .filter(|response| response.status().is_success())
        .and_then(|response| resume_version(response.headers()));
        transfer_file::SourceIdentity {
            endpoint: serde_json::json!(["webdav", self.base_url, self.user]).to_string(),
            remote_path: remote_path.to_string(),
            size: remote_size,
            version,
        }
    }

    async fn download_file(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: &ProgressSink,
    ) -> BackendResult<()> {
        let target = transfer_file::DownloadTarget::reserve(local_path).await?;
        // Not connected: say so, rather than read a file the server has nothing about.
        self.client()?;
        let source = self.source_identity(remote_path).await;
        let (remote_size, version) = (source.size, source.version.clone());
        let origin = crate::local_fs::provenance::Origin::for_url(&self.base_url, remote_path);
        let Some(download) = target.prepare(resume, source.clone(), origin).await? else {
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
            self.logger
                .emit(format!("GET {remote_path}{range_note}"), LogKind::Command);
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
                    self.logger.event(
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
        let written =
            transfer_file::unless_changed(written, &source, || self.source_identity(remote_path))
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
}

#[async_trait]
impl ProtocolBackend for WebDavBackend {
    async fn connect(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.open(config).await
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
        self.logger.event(key, params, kind);
    }

    async fn list(&mut self, path: &str) -> BackendResult<Vec<EntryInfo>> {
        let target = if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        };
        self.logger
            .emit(format!("PROPFIND {target} (Depth: 1)"), LogKind::Command);
        let client = self.client()?.clone();
        let url = self.build_url(&target);
        let (user, password) = {
            let (user, password) = self.credentials();
            (user.to_owned(), password.to_owned())
        };
        let xml = match Self::propfind(&client, url, 1, &user, &password).await {
            Ok(xml) => xml,
            Err(err) => {
                self.logger.event(
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
                self.logger.event(
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
        self.logger.event(
            "receivedEntries",
            serde_json::json!({ "count": entries.len() }),
            LogKind::Response,
        );
        Ok(entries)
    }

    async fn mkdir(&mut self, path: &str) -> BackendResult<()> {
        let segments: Vec<&str> = path
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        if segments.is_empty() {
            return Ok(());
        }
        // A folder is nearly always made in one that exists: one MKCOL, not
        // two requests for every ancestor of a deep tree.
        if self
            .make_collection(&format!("/{}", segments.join("/")))
            .await
            .is_ok()
        {
            return Ok(());
        }
        // Otherwise the ancestors are made one by one; servers answer a
        // missing parent differently, and the walk reports the real refusal.
        let mut current = String::new();
        for segment in segments {
            current.push('/');
            current.push_str(segment);
            self.make_collection(&current).await?;
        }
        Ok(())
    }

    async fn create_file(&mut self, path: &str) -> BackendResult<()> {
        self.logger.emit(
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
        if self.resource_at(path).await?.is_some() {
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
        self.logger.emit(format!("DELETE {path}"), LogKind::Command);
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
            if self.resource_at(new_path).await? == Some(false)
                && self.resource_at(old_path).await?.is_some()
            {
                return super::replace_by_setting_aside(self, old_path, new_path).await;
            }
            return Err(response::status_error(status.as_u16(), "MOVE"));
        }
        Self::mutation_result(reply, "MOVE").await
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
            self.logger.event(
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
            self.logger
                .emit(format!("PUT {remote_path}"), LogKind::Command);
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

        transfer_file::report_outcome(&result, &progress);
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
        self.logger
            .emit(format!("GET {remote_path}"), LogKind::Command);
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
        self.logger
            .emit(format!("PUT {remote_path}"), LogKind::Command);
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
