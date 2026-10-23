//! Operations on one path: whether a file stands there, a bare rename, why the
//! server refused, downloading a file, and removing a file or a whole tree.
use super::*;

impl FtpBackend {
    /// Whether a file stands at `path`. SIZE answers in one control-channel
    /// round trip, with 550 for a name that is free — or a folder, which a file
    /// cannot be renamed over anyway. A server that does not implement SIZE is
    /// asked for the parent's listing instead.
    pub(super) async fn exists(&mut self, path: &str) -> BackendResult<bool> {
        let probe = path.to_string();
        let size = self
            .with_stream(move |s| Box::pin(async move {
                match s.size(&probe).await {
                    Ok(size) => Ok(Ok(size)),
                    Err(error @ suppaftp::FtpError::UnexpectedResponse(_)) => {
                        if matches!(&error, suppaftp::FtpError::UnexpectedResponse(response) if response.status == Status::NotAvailable) {
                            return Err(error.into());
                        }
                        Ok(Err(error))
                    }
                    Err(error) => Err(error.into()),
                }
            }))
            .await?;
        match size {
            Ok(_) => return Ok(true),
            Err(suppaftp::FtpError::UnexpectedResponse(response))
                if response.status == Status::FileUnavailable =>
            {
                return Ok(false);
            }
            Err(_) => {}
        }
        self.listed(path).await
    }

    /// One RNFR/RNTO. A refusal is returned rather than raised: it is the
    /// server's whole reply, so the connection stays in step for the checks
    /// the caller makes next instead of being thrown away.
    pub(super) async fn rename_once(
        &mut self,
        old_path: &str,
        new_path: &str,
    ) -> BackendResult<Option<suppaftp::FtpError>> {
        let (from, to) = (old_path.to_string(), new_path.to_string());
        let refusal = self
            .with_stream(move |s| {
                Box::pin(async move {
                    match s.rename(&from, &to).await {
                        Ok(()) => Ok(None),
                        Err(error @ suppaftp::FtpError::UnexpectedResponse(_))
                            if !matches!(&error, suppaftp::FtpError::UnexpectedResponse(response) if response.status == Status::NotAvailable) =>
                        {
                            Ok(Some(error))
                        }
                        Err(error) => Err(error.into()),
                    }
                })
            })
            .await?;
        if let Some(error) = &refusal {
            self.logger.emit(format!("{error}"), LogKind::Error);
        }
        Ok(refusal)
    }

    /// Whether the parent lists a name spelled exactly like `path`'s.
    pub(super) async fn listed(&mut self, path: &str) -> BackendResult<bool> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        let parent = if parent.is_empty() { "/" } else { parent };
        Ok(self
            .read_listing(parent)
            .await?
            .0
            .iter()
            .any(|entry| entry.name == name))
    }

    /// Many servers answer a missing file and one they will not open with
    /// the same plain 550 ("Failed to open file"). Whether the parent lists
    /// the name tells the two apart.
    pub(super) async fn explain_refusal(
        &mut self,
        path: &str,
        error: anyhow::Error,
    ) -> anyhow::Error {
        let unexplained =
            refused_by_server(&error) && crate::ipc::CommandError::unexplained(&error);
        if !unexplained {
            return error;
        }
        let trimmed = path.trim_end_matches('/');
        let (parent, name) = trimmed.rsplit_once('/').unwrap_or(("", trimmed));
        // The root has no parent to ask; listing it again explains nothing.
        if name.is_empty() {
            return error;
        }
        let parent = if parent.is_empty() { "/" } else { parent };
        let (code, message) = match self.read_listing(parent).await {
            Ok((entries, _)) if entries.iter().any(|entry| entry.name == name) => {
                (ErrorCode::PermissionDenied, "The server refused access")
            }
            Ok(_) => (ErrorCode::NotFound, "File or folder not found"),
            // Nor is anything inside a folder that is missing itself (IIS
            // answers both with the same plain 550).
            Err(listing) if parent != "/" && refused_by_server(&listing) => {
                let parent_error = Box::pin(self.explain_refusal(parent, listing)).await;
                if crate::ipc::CommandError::from_anyhow(&parent_error).code != ErrorCode::NotFound
                {
                    return error;
                }
                (ErrorCode::NotFound, "File or folder not found")
            }
            Err(_) => return error,
        };
        error.context(crate::ipc::CommandError::new(code, message))
    }

    /// What the server says about the file: its size and MDTM.
    async fn source_identity(
        &mut self,
        remote_path: &str,
    ) -> crate::protocol::transfer_file::SourceIdentity {
        let remote_size = self.known_size(remote_path).await;
        let version_path = remote_path.to_string();
        let version = self
            .with_stream(move |s| {
                Box::pin(async move {
                    match s.mdtm(&version_path).await {
                        Ok(date) => Ok(Some(date.to_string())),
                        Err(suppaftp::FtpError::UnexpectedResponse(response))
                            if response.status != Status::NotAvailable =>
                        {
                            Ok(None)
                        }
                        Err(error) => Err(error.into()),
                    }
                })
            })
            .await
            .ok()
            .flatten();
        crate::protocol::transfer_file::SourceIdentity {
            endpoint: self.endpoint.clone(),
            remote_path: remote_path.to_string(),
            size: remote_size,
            version,
        }
    }

    pub(super) async fn download_file(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        resume: bool,
        progress: &ProgressSink,
    ) -> BackendResult<()> {
        let target = crate::protocol::transfer_file::DownloadTarget::reserve(local_path).await?;
        let source = self.source_identity(remote_path).await;
        let remote_size = source.size;
        let origin = crate::local_fs::provenance::Origin::for_url(&self.origin_base, remote_path);
        let Some(download) = target.prepare(resume, source.clone(), origin).await? else {
            return Ok(());
        };

        let start_at = download.start();
        let file = download.open_at(start_at).await;
        let remote_path_owned = remote_path.to_string();
        let progress_for_op = progress.clone();
        let data = self.data_channel()?;
        let written = self
            .with_stream(move |s| {
                Box::pin(async move {
                    let mut file = file?;
                    if start_at > 0 {
                        s.resume_transfer(start_at as usize).await?;
                    }
                    let mut data_stream = data
                        .open(s, format!("RETR {remote_path_owned}"), RETRIEVE_OPEN)
                        .await?;
                    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
                    let mut transferred = start_at;
                    loop {
                        let read_len = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
                        let read_result = tokio::time::timeout(
                            TRANSFER_STALL_TIMEOUT,
                            data_stream.stream().read(&mut buf[..read_len]),
                        )
                        .await
                        .context("stalled while reading from server")?;
                        let n = read_result.context("reading from server")?;
                        if n == 0 {
                            break; // clean EOF from a well-behaved server
                        }
                        file.write_all(&buf[..n])
                            .await
                            .context("writing local file")?;
                        transferred += n as u64;
                        crate::transfer::rate_limiter::shared()
                            .acquire(n as u64)
                            .await;
                        progress_for_op(ProgressInfo::Progress {
                            bytes: transferred,
                            total: remote_size.unwrap_or(0),
                        });
                        if let Some(size) = remote_size
                            && transferred > size
                        {
                            return Err(crate::protocol::fail(
                                ErrorCode::IntegrityMismatch,
                                format!("The server sent more than the advertised {size} bytes"),
                            ));
                        }
                    }
                    file.flush().await.context("flushing local file")?;
                    tokio::time::timeout(TRANSFER_STALL_TIMEOUT, data_stream.settle_download(s))
                        .await
                        .context("download completion timed out")??;
                    Ok(transferred)
                })
            })
            .await;
        let written = match written {
            Err(error) => Err(self.explain_refusal(remote_path, error).await),
            done => done,
        };
        let written = crate::protocol::transfer_file::unless_changed(written, &source, || {
            self.source_identity(remote_path)
        })
        .await;
        download.finish(written, remote_size).await
    }

    pub(super) async fn remove_file(&mut self, path: &str) -> BackendResult<()> {
        let target = path.to_string();
        match self
            .with_stream(move |s| Box::pin(async move { Ok(s.rm(&target).await?) }))
            .await
        {
            Err(error) => Err(self.explain_refusal(path, error).await),
            done => done,
        }
    }

    /// Removes a tree depth-first from an explicit stack, so a deep folder
    /// costs memory for its path list rather than nested futures.
    pub(super) async fn remove_tree(&mut self, root: &str) -> BackendResult<()> {
        // How many entries the folder's last listing held, once it was listed.
        let mut stack = vec![(root.to_string(), 0, None)];
        while let Some((path, depth, listed)) = stack.pop() {
            if let Some(listed) = listed {
                let folder = path.clone();
                match self
                    .with_stream(move |s| Box::pin(async move { Ok(s.rmdir(&folder).await?) }))
                    .await
                {
                    Ok(()) => {}
                    // A server that caps its listings (pure-ftpd stops at 10 000
                    // lines) showed only part of a big folder. While a pass still
                    // finds something to delete, list what is left and go on.
                    Err(error) if listed > 0 && refused_by_server(&error) => {
                        stack.push((path, depth, None));
                    }
                    Err(error) => return Err(error),
                }
                continue;
            }
            if !remote_remove_depth_allowed(depth) {
                return Err(anyhow!(
                    "Folder nesting too deep to remove (> {MAX_REMOTE_REMOVE_DEPTH} levels)"
                ));
            }
            let entries = self.list_for_recursive(&path).await?;
            stack.push((path.clone(), depth, Some(entries.len())));
            for entry in entries {
                let child = format!("{}/{}", path.trim_end_matches('/'), entry.name);
                if entry.is_directory {
                    stack.push((child, depth + 1, None));
                } else {
                    self.remove_file(&child).await?;
                }
            }
        }
        Ok(())
    }
}
