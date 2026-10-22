//! The WebDAV requests behind the backend's operations: PROPFIND, PUT with
//! its rate limit, MKCOL, MOVE, and what a reply to a change means.
use super::*;

impl WebDavBackend {
    pub(super) async fn propfind(
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
            let refusal =
                crate::ipc::CommandError::new(ErrorCode::WebdavRedirect, location.clone());
            return Err(anyhow::Error::new(CrossOriginRedirect(location)).context(refusal));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(crate::protocol::fail(
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
                too_large_message(),
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
                    too_large_message(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(body).context("PROPFIND response is not UTF-8")?;
        Ok(text)
    }

    pub(super) async fn send_upload(
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

    pub(super) async fn send_upload_with_limiter(
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
                    _ = tokio::time::sleep(self.idle_timeout) => return Err(crate::protocol::fail(ErrorCode::TimedOut, "WebDAV upload stalled")),
                }
            }
        };
        let (_, response) = tokio::try_join!(produce, send)?;
        Ok(response)
    }

    /// One MKCOL. A collection already at `path` counts as made.
    pub(super) async fn make_collection(&self, path: &str) -> BackendResult<()> {
        self.logger.emit(format!("MKCOL {path}"), LogKind::Command);
        let res = self
            .request_url(
                Method::from_bytes(b"MKCOL").unwrap(),
                self.collection_url(path),
            )?
            .send()
            .await
            .context("MKCOL request failed")?;
        if res.status() == StatusCode::METHOD_NOT_ALLOWED {
            // 405 can also mean MKCOL is disabled or a regular file is in
            // the way. Only an existing collection satisfies mkdir.
            let (user, password) = self.credentials();
            let xml =
                Self::propfind(self.client()?, self.build_url(path), 0, user, password).await?;
            anyhow::ensure!(
                parse_propfind(&xml)?
                    .first()
                    .is_some_and(|entry| entry.is_dir),
                "MKCOL {path}: existing resource is not a collection"
            );
        } else if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), "MKCOL"));
        }
        Ok(())
    }

    /// What stands at `path`: `Some(true)` a collection, `Some(false)` a
    /// file, `None` nothing.
    pub(super) async fn resource_at(&self, path: &str) -> BackendResult<Option<bool>> {
        let client = self.client()?.clone();
        let url = self.build_url(path);
        let (user, password) = self.credentials();
        match Self::propfind(&client, url, 0, user, password).await {
            Ok(xml) => Ok(parse_propfind(&xml)?.first().map(|entry| entry.is_dir)),
            Err(error)
                if crate::ipc::CommandError::from_anyhow(&error).code == ErrorCode::NotFound =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn send_move(
        &self,
        old_path: &str,
        new_path: &str,
        overwrite: bool,
    ) -> BackendResult<reqwest::Response> {
        self.logger
            .emit(format!("MOVE {old_path} -> {new_path}"), LogKind::Command);
        self.request(Method::from_bytes(b"MOVE")?, old_path)?
            .header("Destination", self.build_url(new_path))
            .header("Overwrite", if overwrite { "T" } else { "F" })
            .send()
            .await
            .context("MOVE request failed")
    }

    pub(super) async fn mutation_result(
        mut res: reqwest::Response,
        operation: &str,
    ) -> BackendResult<()> {
        if !res.status().is_success() {
            return Err(response::status_error(res.status().as_u16(), operation));
        }
        if res.status() == StatusCode::MULTI_STATUS {
            let mut body = Vec::new();
            while let Some(chunk) = res.chunk().await? {
                if body.len().saturating_add(chunk.len()) > MAX_PROPFIND_RESPONSE_BYTES {
                    return Err(crate::protocol::fail(
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
