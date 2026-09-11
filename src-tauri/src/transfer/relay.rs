use crate::protocol::{BackendResult, ProgressInfo, ProgressSink};
use crate::transfer::transfer_pool::BoxBackend;

use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use tokio::io::{AsyncWrite, DuplexStream};
use tokio::sync::oneshot;

pub const RELAY_BUF_SIZE: usize = 64 * 1024;

struct CountingWriter {
    inner: DuplexStream,
    transferred: Arc<AtomicU64>,
    total: u64,
    progress: ProgressSink,
}

impl AsyncWrite for CountingWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let res = Pin::new(&mut this.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = res {
            let transferred = this.transferred.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
            (this.progress)(ProgressInfo::Progress {
                bytes: transferred,
                total: this.total,
            });
        }
        res
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// Pipes the source into the bounded relay stream and preserves unknown size
/// separately from an empty file. EOF alone does not authorize commit: the
/// application service also waits for successful source completion.
pub async fn relay_download(
    source_backend: &mut BoxBackend,
    source_path: &str,
    writer: DuplexStream,
    total_tx: oneshot::Sender<Option<u64>>,
    progress: ProgressSink,
) -> BackendResult<()> {
    let total = source_backend.known_size(source_path).await;
    let _ = total_tx.send(total);
    let mut counting = CountingWriter {
        inner: writer,
        transferred: Arc::new(AtomicU64::new(0)),
        total: total.unwrap_or(0),
        progress,
    };
    source_backend
        .download_to_writer(source_path, &mut counting)
        .await
}

/// Target-side half: pipes `reader` into `target_path`, then verifies the
/// full file actually landed.
pub async fn relay_upload(
    target_backend: &mut BoxBackend,
    target_path: &str,
    reader: DuplexStream,
    total_rx: oneshot::Receiver<Option<u64>>,
) -> BackendResult<()> {
    let mut reader = reader;
    target_backend
        .upload_from_reader(&mut reader, target_path)
        .await?;
    drop(reader);

    let total = total_rx.await.map_err(|_| {
        crate::protocol::fail(
            crate::ipc::ErrorCode::Cancelled,
            "Relay source did not report metadata",
        )
    })?;
    if let Some(total) = total
        && let Some(target_size) = target_backend.known_size(target_path).await
        && target_size != total
    {
        return Err(crate::protocol::fail(
            crate::ipc::ErrorCode::IntegrityMismatch,
            format!(
                "File copied incompletely: destination server has {target_size} bytes instead of {total}."
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{EntryInfo, ProtocolBackend};
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    struct FakeBackend {
        data: Arc<StdMutex<Vec<u8>>>,
        // Simulates a server silently truncating a write (the exact failure
        // remote_upload's post-transfer size check exists to catch).
        truncate_upload_at: Option<usize>,
    }

    #[async_trait]
    impl ProtocolBackend for FakeBackend {
        async fn connect(
            &mut self,
            _config: &crate::protocol::config::ConnectionConfig,
        ) -> BackendResult<()> {
            unimplemented!()
        }
        async fn disconnect(&mut self) -> BackendResult<()> {
            unimplemented!()
        }
        fn is_connected(&self) -> bool {
            true
        }
        fn set_log_sink(
            &mut self,
            _sink: Option<
                Arc<dyn Fn(crate::protocol::LogText, crate::protocol::LogKind) + Send + Sync>,
            >,
        ) {
        }
        async fn list(&mut self, _path: &str) -> BackendResult<Vec<EntryInfo>> {
            unimplemented!()
        }
        async fn mkdir(&mut self, _path: &str) -> BackendResult<()> {
            unimplemented!()
        }
        async fn create_file(&mut self, _path: &str) -> BackendResult<()> {
            unimplemented!()
        }
        async fn remove(&mut self, _path: &str, _is_dir: bool) -> BackendResult<()> {
            unimplemented!()
        }
        async fn rename(&mut self, _old_path: &str, _new_path: &str) -> BackendResult<()> {
            unimplemented!()
        }
        async fn size(&mut self, _path: &str) -> u64 {
            self.data.lock().unwrap().len() as u64
        }
        async fn known_size(&mut self, _path: &str) -> Option<u64> {
            Some(self.data.lock().unwrap().len() as u64)
        }
        async fn upload(
            &mut self,
            _local_path: &std::path::Path,
            _remote_path: &str,
            _resume: bool,
            _progress: ProgressSink,
        ) -> BackendResult<()> {
            unimplemented!()
        }
        async fn download(
            &mut self,
            _remote_path: &str,
            _local_path: &std::path::Path,
            _resume: bool,
            _progress: ProgressSink,
        ) -> BackendResult<()> {
            unimplemented!()
        }

        async fn download_to_writer(
            &mut self,
            _remote_path: &str,
            writer: &mut (dyn AsyncWrite + Unpin + Send),
        ) -> BackendResult<()> {
            let data = self.data.lock().unwrap().clone();
            writer.write_all(&data).await?;
            Ok(())
        }

        async fn upload_from_reader(
            &mut self,
            reader: &mut (dyn AsyncRead + Unpin + Send),
            _remote_path: &str,
        ) -> BackendResult<()> {
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf).await?;
            if let Some(limit) = self.truncate_upload_at {
                buf.truncate(limit);
            }
            *self.data.lock().unwrap() = buf;
            Ok(())
        }
    }

    fn boxed(data: Arc<StdMutex<Vec<u8>>>, truncate_upload_at: Option<usize>) -> BoxBackend {
        Box::new(FakeBackend {
            data,
            truncate_upload_at,
        })
    }

    #[tokio::test]
    async fn relays_bytes_end_to_end() {
        let source_data = Arc::new(StdMutex::new(b"hello relay world".to_vec()));
        let target_data = Arc::new(StdMutex::new(Vec::new()));
        let mut source = boxed(source_data.clone(), None);
        let mut target = boxed(target_data.clone(), None);

        let (writer, reader) = tokio::io::duplex(RELAY_BUF_SIZE);
        let (total_tx, total_rx) = oneshot::channel();
        let progress: ProgressSink = Arc::new(|_| {});

        let (dl, ul) = tokio::join!(
            relay_download(&mut source, "/src", writer, total_tx, progress),
            relay_upload(&mut target, "/dst", reader, total_rx),
        );
        dl.expect("download half should succeed");
        ul.expect("upload half should succeed");
        assert_eq!(*target_data.lock().unwrap(), *source_data.lock().unwrap());
    }

    #[tokio::test]
    async fn unknown_and_zero_totals_have_different_integrity_contracts() {
        for (total, bytes, valid) in [
            (None, b"abc".as_slice(), true),
            (Some(0), b"".as_slice(), true),
            (Some(0), b"abc".as_slice(), false),
        ] {
            let data = Arc::new(StdMutex::new(Vec::new()));
            let mut target = boxed(data.clone(), None);
            let (mut writer, reader) = tokio::io::duplex(RELAY_BUF_SIZE);
            writer.write_all(bytes).await.unwrap();
            drop(writer);
            let (tx, rx) = oneshot::channel();
            tx.send(total).unwrap();
            let result = relay_upload(&mut target, "/dst", reader, rx).await;
            assert_eq!(result.is_ok(), valid);
            assert_eq!(data.lock().unwrap().as_slice(), bytes);
            if let Err(error) = result {
                assert_eq!(
                    crate::ipc::CommandError::from_anyhow(&error).code,
                    crate::ipc::ErrorCode::IntegrityMismatch
                );
            }
        }
    }

    #[tokio::test]
    async fn detects_truncated_upload_via_size_check() {
        let source_data = Arc::new(StdMutex::new(b"a file longer than three bytes".to_vec()));
        let target_data = Arc::new(StdMutex::new(Vec::new()));
        let mut source = boxed(source_data, None);
        let mut target = boxed(target_data, Some(3));

        let (writer, reader) = tokio::io::duplex(RELAY_BUF_SIZE);
        let (total_tx, total_rx) = oneshot::channel();
        let progress: ProgressSink = Arc::new(|_| {});

        let (dl, ul) = tokio::join!(
            relay_download(&mut source, "/src", writer, total_tx, progress),
            relay_upload(&mut target, "/dst", reader, total_rx),
        );
        dl.expect("download half should succeed");
        let err =
            ul.expect_err("a truncated upload must be caught by the post-transfer size check");
        assert!(
            err.to_string().contains("copied incompletely"),
            "unexpected error: {err}"
        );
    }
}
