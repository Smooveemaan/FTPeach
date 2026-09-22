//! Copy of one local file that never exposes a partial target. The data lands
//! in a hidden sibling owned by this copy; only after the source is confirmed
//! unchanged and the sibling is synced does it take the target name, under the
//! caller's overwrite policy. Until that commit an existing target keeps its
//! old content, and a failure removes the sibling and nothing else.
//!
//! Callers hold the target reservation and the local mutation guard and have
//! validated both paths; this module owns only staging and commit.
use crate::ipc::{CommandError, ErrorCode};
use crate::protocol::transfer_file;
use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// Points where a test can fail the copy, in the order they are reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    #[cfg(test)]
    Read,
    #[cfg(test)]
    Write,
    #[cfg(test)]
    Flush,
    Sync,
    Copied,
    Synced,
}

#[cfg(test)]
tokio::task_local! {
    pub(crate) static FAULT: std::sync::Arc<dyn Fn(Stage) -> Result<()> + Send + Sync>;
}

#[cfg(test)]
fn reach(stage: Stage) -> Result<()> {
    FAULT.try_with(|fault| fault(stage)).unwrap_or(Ok(()))
}

#[cfg(not(test))]
fn reach(_: Stage) -> Result<()> {
    Ok(())
}

// Inject errors through the same AsyncRead/AsyncWrite interface used by
// tokio::io::copy, including after some bytes have already been written.
#[cfg(test)]
struct FaultIo(tokio::fs::File);

#[cfg(test)]
impl FaultIo {
    async fn into_std(self) -> std::fs::File {
        self.0.into_std().await
    }
}

#[cfg(test)]
impl std::ops::Deref for FaultIo {
    type Target = tokio::fs::File;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(test)]
impl tokio::io::AsyncRead for FaultIo {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if let Err(error) = reach(Stage::Read) {
            return std::task::Poll::Ready(Err(std::io::Error::other(error)));
        }
        std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

#[cfg(test)]
impl tokio::io::AsyncWrite for FaultIo {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        if let Err(error) = reach(Stage::Write) {
            return std::task::Poll::Ready(Err(std::io::Error::other(error)));
        }
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if let Err(error) = reach(Stage::Flush) {
            return std::task::Poll::Ready(Err(std::io::Error::other(error)));
        }
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

fn staging_path(target: &Path) -> PathBuf {
    target.with_file_name(format!(".ftpeach-{}.part", uuid::Uuid::new_v4()))
}

fn cancelled() -> anyhow::Error {
    CommandError::new(ErrorCode::Cancelled, "Copy cancelled").into()
}

pub(crate) async fn copy_file(
    source: &Path,
    target: &Path,
    overwrite: bool,
    token: &CancellationToken,
) -> Result<()> {
    let temporary = staging_path(target);
    let mut staged = None;
    let mut created = false;
    let result = async {
        let input = tokio::fs::File::open(source).await?;
        #[cfg(test)]
        let input = FaultIo(input);
        let mut input = input;
        let before = input.metadata().await?;
        anyhow::ensure!(before.is_file(), "Only a regular file can be copied");
        let output = tokio::fs::File::from_std(transfer_file::open_artifact(&temporary, true)?);
        created = true;
        #[cfg(test)]
        let output = FaultIo(output);
        staged = Some(output);
        let output = staged.as_mut().unwrap();
        let mut limited = (&mut input).take(before.len().saturating_add(1));
        let bytes = tokio::select! {
            result = tokio::io::copy(&mut limited, &mut *output) => result?,
            _ = token.cancelled() => return Err(cancelled()),
        };
        reach(Stage::Copied)?;
        transfer_file::validate_length(bytes, Some(before.len()))?;
        let after = input.metadata().await?;
        anyhow::ensure!(
            before.len() == after.len() && before.modified()? == after.modified()?,
            "Source changed during copy"
        );
        output.flush().await?;
        reach(Stage::Sync)?;
        output.sync_all().await?;
        drop(staged.take().unwrap().into_std().await);
        reach(Stage::Synced)?;
        if token.is_cancelled() {
            return Err(cancelled());
        }
        crate::protocol::ALLOW_OVERWRITE
            .scope(overwrite, transfer_file::commit(&temporary, target))
            .await
    }
    .await;
    // Tokio file writes can still be running on the blocking pool when copy
    // fails or is cancelled. Join them and close the exclusive handle before
    // removing the artifact, otherwise Windows may leave a partial behind.
    if let Some(output) = staged.take() {
        drop(output.into_std().await);
    }
    if result.is_err() && created {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn io_errors_and_disk_full_never_publish_a_partial_or_damage_an_old_target() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for stage in [Stage::Read, Stage::Write, Stage::Flush, Stage::Sync] {
            for existing in [None, Some(b"old".as_slice())] {
                for overwrite in [false, true] {
                    let fixture = Fixture::new(existing);
                    let writes = Arc::new(AtomicUsize::new(0));
                    let observed_writes = writes.clone();
                    let fault: Arc<dyn Fn(Stage) -> Result<()> + Send + Sync> =
                        Arc::new(move |reached| {
                            if reached == Stage::Write {
                                observed_writes.fetch_add(1, Ordering::SeqCst);
                            }
                            // Let the first write through, then fail a subsequent
                            // read/write. This exercises cleanup of a partial file.
                            if reached == stage
                                && (matches!(stage, Stage::Flush | Stage::Sync)
                                    || observed_writes.load(Ordering::SeqCst) > 1)
                            {
                                let error = if stage == Stage::Write {
                                    std::io::Error::from_raw_os_error(112) // ERROR_DISK_FULL
                                } else {
                                    std::io::Error::other(format!("injected {stage:?} I/O failure"))
                                };
                                return Err(error.into());
                            }
                            Ok(())
                        });
                    assert!(
                        FAULT
                            .scope(
                                fault,
                                copy_file(
                                    &fixture.source,
                                    &fixture.target,
                                    overwrite,
                                    &CancellationToken::new(),
                                )
                            )
                            .await
                            .is_err(),
                        "{stage:?}"
                    );
                    assert!(writes.load(Ordering::SeqCst) > 0);
                    if let Some(content) = existing {
                        assert_eq!(std::fs::read(&fixture.target).unwrap(), content);
                        assert_eq!(fixture.names(), ["source.bin", "target.bin"]);
                    } else {
                        assert_eq!(fixture.names(), ["source.bin"]);
                    }
                    assert_eq!(
                        std::fs::metadata(&fixture.source).unwrap().len(),
                        256 * 1024 + 3
                    );
                }
            }
        }
    }

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        target: PathBuf,
    }

    impl Fixture {
        fn new(existing_target: Option<&[u8]>) -> Self {
            let root =
                std::env::temp_dir().join(format!("ftpeach-staged-copy-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let source = root.join("source.bin");
            let target = root.join("target.bin");
            std::fs::write(&source, vec![7u8; 256 * 1024 + 3]).unwrap();
            if let Some(content) = existing_target {
                std::fs::write(&target, content).unwrap();
            }
            Self {
                root,
                source,
                target,
            }
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = std::fs::read_dir(&self.root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }

        async fn copy_failing_at(&self, stage: Stage, overwrite: bool) -> Result<()> {
            let fault: Arc<dyn Fn(Stage) -> Result<()> + Send + Sync> = Arc::new(move |reached| {
                anyhow::ensure!(reached != stage, "injected fault at {reached:?}");
                Ok(())
            });
            FAULT
                .scope(
                    fault,
                    copy_file(
                        &self.source,
                        &self.target,
                        overwrite,
                        &CancellationToken::new(),
                    ),
                )
                .await
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn a_fault_before_commit_keeps_the_old_target_and_leaves_no_partial() {
        for stage in [Stage::Copied, Stage::Synced] {
            for overwrite in [false, true] {
                let fixture = Fixture::new(Some(b"old"));
                assert!(fixture.copy_failing_at(stage, overwrite).await.is_err());
                assert_eq!(std::fs::read(&fixture.target).unwrap(), b"old");
                assert_eq!(fixture.names(), ["source.bin", "target.bin"]);
            }
        }
    }

    #[tokio::test]
    async fn a_fault_before_commit_never_creates_a_new_target() {
        for stage in [Stage::Copied, Stage::Synced] {
            let fixture = Fixture::new(None);
            assert!(fixture.copy_failing_at(stage, false).await.is_err());
            assert_eq!(fixture.names(), ["source.bin"]);
        }
    }

    #[tokio::test]
    async fn a_target_that_appears_before_commit_is_not_replaced() {
        let fixture = Fixture::new(None);
        let target = fixture.target.clone();
        let fault: Arc<dyn Fn(Stage) -> Result<()> + Send + Sync> = Arc::new(move |stage| {
            if stage == Stage::Synced {
                std::fs::write(&target, b"racing")?;
            }
            Ok(())
        });
        let result = FAULT
            .scope(
                fault,
                copy_file(
                    &fixture.source,
                    &fixture.target,
                    false,
                    &CancellationToken::new(),
                ),
            )
            .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read(&fixture.target).unwrap(), b"racing");
        assert_eq!(fixture.names(), ["source.bin", "target.bin"]);
    }

    #[tokio::test]
    async fn a_source_changed_during_the_copy_is_refused() {
        let fixture = Fixture::new(Some(b"old"));
        let source = fixture.source.clone();
        let fault: Arc<dyn Fn(Stage) -> Result<()> + Send + Sync> = Arc::new(move |stage| {
            if stage == Stage::Copied {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&source)
                    .and_then(|mut file| std::io::Write::write_all(&mut file, b"more"))?;
            }
            Ok(())
        });
        let result = FAULT
            .scope(
                fault,
                copy_file(
                    &fixture.source,
                    &fixture.target,
                    true,
                    &CancellationToken::new(),
                ),
            )
            .await;
        assert!(format!("{:#}", result.unwrap_err()).contains("Source changed"));
        assert_eq!(std::fs::read(&fixture.target).unwrap(), b"old");
        assert_eq!(fixture.names(), ["source.bin", "target.bin"]);
    }

    #[tokio::test]
    async fn a_cancelled_copy_leaves_no_trace() {
        let fixture = Fixture::new(None);
        let token = CancellationToken::new();
        token.cancel();
        let error = copy_file(&fixture.source, &fixture.target, false, &token)
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<CommandError>().map(|e| e.code),
            Some(ErrorCode::Cancelled)
        );
        assert_eq!(fixture.names(), ["source.bin"]);
    }

    #[tokio::test]
    async fn the_overwrite_policy_decides_an_existing_target() {
        let fixture = Fixture::new(Some(b"old"));
        let token = CancellationToken::new();
        assert!(
            copy_file(&fixture.source, &fixture.target, false, &token)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&fixture.target).unwrap(), b"old");
        copy_file(&fixture.source, &fixture.target, true, &token)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&fixture.target).unwrap(),
            std::fs::read(&fixture.source).unwrap()
        );
        assert_eq!(fixture.names(), ["source.bin", "target.bin"]);
    }
}
