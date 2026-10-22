//! Folder listings: MLSD or LIST, parsed, with links told apart from folders
//! so a walk cannot leave the tree it was started on.
use super::*;

impl FtpBackend {
    /// Runs a listing `command` — LIST or MLSD — for `path`, answering with
    /// the lines the server sent.
    pub(super) async fn list_raw(
        stream: &mut AsyncRustlsFtpStream,
        data: &DataChannel,
        command: &str,
        path: &str,
    ) -> BackendResult<Vec<String>> {
        let mut data_stream = tokio::time::timeout(
            GRACEFUL_IO_TIMEOUT,
            data.open(
                stream,
                format!("{command} {path}"),
                &[Status::AboutToSend, Status::AlreadyOpen],
            ),
        )
        .await
        .with_context(|| format!("FTP {command} command timed out"))?
        .with_context(|| format!("{command} command failed"))?;

        let raw = read_list_data(data_stream.stream(), DATA_IDLE_TIMEOUT).await?;
        let encoding = data.encoding;

        tokio::time::timeout(GRACEFUL_IO_TIMEOUT, data_stream.settle(stream))
            .await
            .with_context(|| format!("FTP {command} completion timed out"))?
            .with_context(|| format!("closing {command} data connection"))?;

        let text = crate::protocol::ftp_charset::decode(encoding, &raw);
        Ok(text
            .split(['\r', '\n'])
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// Whether `folder` can be entered, the working directory put back after.
    /// `None` when that could not be found out.
    pub(super) async fn folder_opens(&self, folder: &str) -> Option<bool> {
        let folder = folder.to_owned();
        self.with_stream(move |s| {
            Box::pin(async move {
                let original = s.pwd().await.context("saving working directory")?;
                let opens = s.cwd(&folder).await.is_ok();
                s.cwd(&original)
                    .await
                    .context("restoring working directory")?;
                Ok(opens)
            })
        })
        .await
        .ok()
    }

    /// A folder's entries. For a recursive operation (`resolve_links` off)
    /// a link stays a file and the folder itself must not be a link, so the
    /// walk cannot leave the tree it was started on.
    pub(super) async fn list_entries(
        &mut self,
        path: &str,
        resolve_links: bool,
    ) -> BackendResult<Vec<EntryInfo>> {
        let target = if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        };
        if !resolve_links && !self.real_folders.remove(&target) {
            self.refuse_linked_folder(&target).await?;
        }
        let (mut entries, links) = match self.read_listing(&target).await {
            Ok(listing) => listing,
            Err(error) => return Err(self.explain_refusal(&target, error).await),
        };
        let basename = target
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        let suspicious = entries.is_empty() || (entries.len() == 1 && entries[0].name == basename);
        // Where a server lists what it could not open as nothing, or as the
        // name alone, entering the folder tells whether it is really there.
        if !self.mlsd
            && suspicious
            && target != "/"
            && self.folder_opens(&target).await == Some(false)
        {
            return Err(self
                .explain_refusal(
                    &target,
                    anyhow::Error::new(suppaftp::FtpError::UnexpectedResponse(
                        suppaftp::types::Response::new(
                            Status::FileUnavailable,
                            b"550 The folder cannot be opened".to_vec(),
                        ),
                    )),
                )
                .await);
        }
        if resolve_links && !links.is_empty() {
            let names = links
                .iter()
                .take(MAX_RESOLVED_LINKS)
                .map(|&index| entries[index].name.clone())
                .collect();
            let folders = self.linked_folders(&target, names).await;
            for (index, is_folder) in links.into_iter().zip(folders) {
                entries[index].is_directory = is_folder;
            }
        }
        if !resolve_links {
            // Each of these was listed as a folder, not a link, so the walk
            // entering it next needs no check of its own.
            if self.real_folders.len() > MAX_REAL_FOLDERS {
                self.real_folders.clear();
            }
            let parent = target.trim_end_matches('/');
            self.real_folders.extend(
                entries
                    .iter()
                    .filter(|entry| entry.is_directory)
                    .map(|entry| format!("{parent}/{}", entry.name)),
            );
        }
        self.logger.event(
            "receivedEntries",
            serde_json::json!({ "count": entries.len() }),
            LogKind::Response,
        );
        Ok(entries)
    }

    /// Fails when `target` is a link in its parent's listing. A parent that
    /// cannot be listed leaves nothing to check against.
    pub(super) async fn refuse_linked_folder(&mut self, target: &str) -> BackendResult<()> {
        let trimmed = target.trim_end_matches('/');
        let Some((parent, name)) = trimmed.rsplit_once('/') else {
            return Ok(());
        };
        if name.is_empty() {
            return Ok(());
        }
        let parent = if parent.is_empty() { "/" } else { parent };
        if let Ok((siblings, links)) = self.read_listing(parent).await {
            anyhow::ensure!(
                !links.iter().any(|&index| siblings[index].name == name),
                "Recursive operations cannot traverse an FTP symbolic link: {target}"
            );
        }
        Ok(())
    }

    /// The parsed listing of `target`, with the indexes of the entries that
    /// are links.
    pub(super) async fn read_listing(
        &mut self,
        target: &str,
    ) -> BackendResult<(Vec<EntryInfo>, Vec<usize>)> {
        let target = target.to_owned();
        let mut listing = self.fetch_listing(&target).await;
        // A server may announce MLST and still turn MLSD away; LIST answers.
        if self.mlsd && listing.as_ref().is_err_and(command_refused) {
            self.mlsd = false;
            listing = self.fetch_listing(&target).await;
        }
        let raw_lines = match listing {
            Ok(lines) => lines,
            Err(err) => {
                self.logger.event(
                    "listFailed",
                    serde_json::json!({ "error": format!("{err:#}") }),
                    LogKind::Error,
                );
                return Err(err);
            }
        };
        if raw_lines.len() > crate::protocol::MAX_RAW_DIRECTORY_ENTRIES
            || raw_lines.iter().map(String::len).sum::<usize>()
                > crate::protocol::MAX_DIRECTORY_TEXT_BYTES
        {
            anyhow::bail!(crate::ipc::CommandError::new(
                crate::ipc::ErrorCode::ResourceLimit,
                "FTP directory listing exceeds the configured limit",
            ));
        }
        let now = Utc::now();
        let mut entries = Vec::with_capacity(raw_lines.len());
        let mut links = Vec::new();
        for line in raw_lines {
            let parsed = if self.mlsd {
                list_parse::parse_mlsd_line(&line)
            } else {
                list_parse::parse_line(&line, now)
            };
            let Some(raw) = parsed else {
                continue;
            };
            if !is_safe_path_segment(&raw.name) {
                self.logger.event(
                    "skippedUnsafeEntry",
                    serde_json::json!({ "name": raw.name }),
                    LogKind::Status,
                );
                continue;
            }
            if raw.is_symlink {
                links.push(entries.len());
            }
            entries.push(EntryInfo {
                name: raw.name,
                is_directory: raw.is_directory,
                size: raw.size,
                modified_at: raw.modified_at.map(|d| d.to_rfc3339()),
                permissions: raw.permissions,
                owner: raw.owner,
                group: raw.group,
            });
        }
        Ok((entries, links))
    }

    /// Which of the links in `folder` lead to a folder: LIST and MLSD only say
    /// that they are links. Entering one tells, and the working directory is
    /// put back afterwards. A link that cannot be entered counts as a file.
    pub(super) async fn linked_folders(&self, folder: &str, names: Vec<String>) -> Vec<bool> {
        let count = names.len();
        let folder = folder.trim_end_matches('/').to_owned();
        self.with_stream(move |s| {
            Box::pin(async move {
                let original = s.pwd().await.context("saving working directory")?;
                let mut folders = Vec::with_capacity(names.len());
                for name in names {
                    folders.push(s.cwd(format!("{folder}/{name}")).await.is_ok());
                }
                s.cwd(&original)
                    .await
                    .context("restoring working directory")?;
                Ok(folders)
            })
        })
        .await
        .unwrap_or_else(|_| vec![false; count])
    }

    /// The lines of `target`'s listing, by MLSD where the server offers it.
    pub(super) async fn fetch_listing(&self, target: &str) -> BackendResult<Vec<String>> {
        let command = if self.mlsd { "MLSD" } else { "LIST" };
        self.logger
            .emit(format!("{command} {target}"), LogKind::Command);
        let target = target.to_owned();
        let data = self.data_channel()?;
        self.with_stream(move |s| {
            Box::pin(async move { Self::list_raw(s, &data, command, &target).await })
        })
        .await
    }
}
