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
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

mod response;

pub const MAX_PROPFIND_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

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
    dav_base_path: String,
    user: String,
    password: String,
    connected: bool,
    logger: BackendLogger,
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

    fn build_proxy(cfg: &super::transport::ProxyConfig) -> BackendResult<reqwest::Proxy> {
        use super::transport::ProxyKind;
        use zeroize::Zeroize;
        let scheme = match cfg.kind {
            ProxyKind::Socks4 => "socks4",
            ProxyKind::Socks5 => "socks5",
            ProxyKind::Http => "http",
        };
        let mut userinfo = match (&cfg.username, &cfg.password) {
            (Some(user), Some(pass)) => format!(
                "{}:{}@",
                utf8_percent_encode(user, NON_ALPHANUMERIC),
                utf8_percent_encode(pass, NON_ALPHANUMERIC)
            ),
            (Some(user), None) => format!("{}@", utf8_percent_encode(user, NON_ALPHANUMERIC)),
            _ => String::new(),
        };
        let mut url = format!("{scheme}://{userinfo}{}:{}", cfg.host, cfg.port);
        let result = reqwest::Proxy::all(&url).context("invalid proxy configuration");
        userinfo.zeroize();
        url.zeroize();
        result
    }

    fn request(&self, method: Method, path: &str) -> BackendResult<reqwest::RequestBuilder> {
        let url = self.build_url(path);
        let client = if method == Method::PUT {
            self.upload_client.as_ref().unwrap_or(self.client()?)
        } else {
            self.client()?
        };
        let mut req = client.request(method, url);
        if !self.user.is_empty() || !self.password.is_empty() {
            req = req.basic_auth(&self.user, Some(self.password.clone()));
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
        if status == StatusCode::NOT_FOUND {
            return Err(super::fail(
                ErrorCode::NotFound,
                "WebDAV resource does not exist",
            ));
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
        if status != StatusCode::MULTI_STATUS && status != StatusCode::OK {
            return Err(response::status_error(status.as_u16(), "PROPFIND"));
        }
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
                    result = &mut request => return result.context("PUT request failed"),
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
        match Self::propfind(&client, url, 0, &self.user, &self.password).await {
            Ok(_) => Ok(true),
            Err(error)
                if crate::ipc::CommandError::from_anyhow(&error).code == ErrorCode::NotFound =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
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
        let ca_cert_path = config.ca_cert_path.clone();
        let timeout_ms = config.common.timeout_ms;

        self.log_key(
            "connecting",
            serde_json::json!({ "addr": &webdav_url }),
            LogKind::Status,
        );

        let dav_base_path = reqwest::Url::parse(&webdav_url)
            .context("invalid server URL")?
            .path()
            .trim_end_matches('/')
            .to_string();

        let idle = Duration::from_millis(if timeout_ms == 0 { 60_000 } else { timeout_ms });
        let build_client = |read_timeout: bool| -> BackendResult<Client> {
            let mut builder = Client::builder();
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
            if let Some(proxy_cfg) = &config.common.proxy {
                builder = builder.proxy(Self::build_proxy(proxy_cfg)?);
            }
            builder.build().context("failed to create HTTP client")
        };
        let client = build_client(true)?;
        let upload_client = build_client(false)?;

        self.log_kind("PROPFIND / (Depth: 0)", LogKind::Command);
        let probe = Self::propfind(&client, format!("{webdav_url}/"), 0, &user, &password);
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
        self.dav_base_path = dav_base_path;
        self.user = user;
        self.password = password;
        self.connected = true;
        Ok(())
    }

    async fn disconnect(&mut self) -> BackendResult<()> {
        self.client = None;
        self.upload_client = None;
        self.connected = false;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn set_log_enabled(&mut self, enabled: bool) {
        self.logger.set_enabled(enabled);
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
        let (user, password) = (self.user.clone(), self.password.clone());
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

        let self_path = format!("{}{}", self.dav_base_path, target);
        let self_path = self_path.trim_end_matches('/');

        let mut entries = Vec::with_capacity(raw_entries.len());
        for raw in raw_entries {
            let decoded = decode_href(&raw.href);
            if decoded.trim_end_matches('/') == self_path {
                continue; // the listed directory itself, not a child entry
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
                .request(Method::from_bytes(b"MKCOL").unwrap(), &current)?
                .send()
                .await
                .context("MKCOL request failed")?;
            // 405 = collection already exists — harmless for recursive mkdir.
            if !res.status().is_success() && res.status() != StatusCode::METHOD_NOT_ALLOWED {
                bail!("MKCOL {current} returned {}", res.status());
            }
        }
        Ok(())
    }

    async fn create_file(&mut self, path: &str) -> BackendResult<()> {
        self.log_kind(
            format!("PUT {path} (creating empty file)"),
            LogKind::Command,
        );
        if self.resource_exists(path).await? {
            let name = path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(path);
            bail!("\"{name}\" already exists");
        }
        let res = self
            .request(Method::PUT, path)?
            .header(reqwest::header::IF_NONE_MATCH, "*")
            .body(Vec::new())
            .timeout(self.idle_timeout)
            .send()
            .await
            .context("PUT request failed")?;
        if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), "PUT"));
        }
        Ok(())
    }

    async fn remove(&mut self, path: &str, _is_dir: bool) -> BackendResult<()> {
        self.log_kind(format!("DELETE {path}"), LogKind::Command);
        let res = self
            .request(Method::DELETE, path)?
            .send()
            .await
            .context("DELETE request failed")?;
        if !res.status().is_success() && res.status() != StatusCode::NOT_FOUND {
            return Err(response::status_error(res.status().as_u16(), "DELETE"));
        }
        Ok(())
    }

    async fn rename(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        self.log_kind(format!("MOVE {old_path} -> {new_path}"), LogKind::Command);
        let dest = self.build_url(new_path);
        let res = self
            .request(Method::from_bytes(b"MOVE").unwrap(), old_path)?
            .header("Destination", dest)
            .header("Overwrite", "T")
            .send()
            .await
            .context("MOVE request failed")?;
        if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), "MOVE"));
        }
        Ok(())
    }

    async fn size(&mut self, path: &str) -> u64 {
        self.known_size(path).await.unwrap_or(0)
    }

    async fn rename_no_replace(&mut self, old_path: &str, new_path: &str) -> BackendResult<()> {
        let response = self
            .request(Method::from_bytes(b"MOVE")?, old_path)?
            .header("Destination", self.build_url(new_path))
            .header("Overwrite", "F")
            .send()
            .await?;
        anyhow::ensure!(
            response.status().is_success(),
            "Conditional MOVE returned {}",
            response.status()
        );
        Ok(())
    }

    async fn known_size(&mut self, path: &str) -> Option<u64> {
        let Ok(client) = self.client().cloned() else {
            return None;
        };
        let url = self.build_url(path);
        let (user, password) = (self.user.clone(), self.password.clone());
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
        let _lease = crate::local_fs::target_reservation::Reservation::acquire(
            &local_path.to_string_lossy(),
        )?;
        let _mutation = crate::local_fs::mutations::guard().lock().await;
        crate::local_fs::mutations::validate_download_name(local_path)?;
        crate::local_fs::filesystem_safety::validate_write_destination(local_path).await?;
        let remote_size = self.known_size(remote_path).await;
        let version = self
            .request(Method::HEAD, remote_path)?
            .send()
            .await
            .ok()
            .and_then(|response| {
                if !response.status().is_success() {
                    return None;
                }
                response
                    .headers()
                    .get(reqwest::header::ETAG)
                    .or_else(|| response.headers().get(reqwest::header::LAST_MODIFIED))
                    .and_then(|v| v.to_str().ok())
                    .filter(|version| !version.starts_with("W/"))
                    .map(str::to_owned)
            });
        let source = super::transfer_file::SourceIdentity {
            endpoint: serde_json::json!(["webdav", self.base_url, self.user]).to_string(),
            remote_path: remote_path.to_string(),
            size: remote_size,
            version: version.clone(),
        };
        let (partial_path, start_at) = transfer_file::prepare(local_path, resume, source).await?;
        transfer_file::validate_resume_offset(start_at, remote_size)?;
        if transfer_file::commit_if_complete(&partial_path, local_path, start_at, remote_size)
            .await?
        {
            progress(ProgressInfo::Done);
            return Ok(());
        }

        let result: BackendResult<()> = async {
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
            let effective_start =
                if resumed_response_start(res.status(), start_at)? == 0 && start_at > 0 {
                    self.log_key(
                        "davResumeUnsupportedServer",
                        serde_json::json!({ "expected": 206, "status": res.status().as_u16() }),
                        LogKind::Status,
                    );
                    0
                } else {
                    if start_at > 0 {
                        validate_content_range(
                            res.headers()
                                .get(reqwest::header::CONTENT_RANGE)
                                .and_then(|v| v.to_str().ok()),
                            start_at,
                            remote_size,
                        )?;
                    }
                    start_at
                };

            let mut file = tokio::fs::File::from_std(super::transfer_file::open_artifact(
                &partial_path,
                false,
            )?);
            if effective_start == 0 {
                file.set_len(0).await?;
            }
            if effective_start > 0 {
                file.seek(std::io::SeekFrom::Start(effective_start))
                    .await
                    .context("seeking local file")?;
            }

            let mut transferred = effective_start;
            let mut res = res;
            while let Some(chunk) = res.chunk().await.context("reading from server")? {
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
            transfer_file::validate_length(transferred, remote_size)?;
            drop(file);
            transfer_file::commit(&partial_path, local_path).await?;
            Ok(())
        }
        .await;

        match &result {
            Ok(()) => progress(ProgressInfo::Done),
            Err(err) => {
                progress(ProgressInfo::failed(err));
                transfer_file::remove_empty_new_partial(&partial_path, start_at).await;
            }
        }
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
