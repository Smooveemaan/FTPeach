//! A server held in memory for the transfer and resume tests, with switches
//! for the ways a real one stalls, refuses or races the user.
use crate::ipc::ErrorCode;
use crate::protocol::{BackendResult, EntryInfo, ProgressInfo, ProgressSink, ProtocolBackend};
use std::collections::HashMap;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Default)]
pub(crate) struct Remote {
    pub(crate) files: Mutex<HashMap<String, Vec<u8>>>,
    /// Woken when an upload or a download starts writing.
    pub(crate) writing: tokio::sync::Notify,
    /// Uploads and downloads never finish.
    pub(crate) stall: bool,
    /// Byte-range reads never finish.
    pub(crate) stall_read: AtomicBool,
    /// Disconnecting and removing never finish.
    pub(crate) stall_cleanup: bool,
    pub(crate) reject_rename: bool,
    /// Mirrors a protocol with no ranged read, which must never be resumed.
    pub(crate) refuse_ranged_read: bool,
    /// Saves over the local source at its own length while it uploads.
    pub(crate) rewrite_source: bool,
    /// Saves a longer version over the local source while it uploads, so
    /// the upload fails its length check.
    pub(crate) lengthen_source: bool,
    /// Removals refused before the server lets go, as a Windows server does
    /// while a stopped upload still holds the file open.
    pub(crate) held_removals: AtomicUsize,
    /// Translation keys this connection put in front of the user.
    pub(crate) logged: Mutex<Vec<String>>,
    /// Every byte range asked of the server, as `(offset, len)`. What a resume
    /// costs the user is exactly what it reads back.
    pub(crate) ranges: Mutex<Vec<(u64, usize)>>,
}

pub(crate) struct MemoryBackend {
    remote: Arc<Remote>,
    connected: bool,
}

impl MemoryBackend {
    /// A connected backend over `remote`.
    pub(crate) fn over(remote: Arc<Remote>) -> Self {
        Self {
            remote,
            connected: true,
        }
    }
}

#[async_trait::async_trait]
impl ProtocolBackend for MemoryBackend {
    async fn connect(
        &mut self,
        _: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        Ok(())
    }
    async fn disconnect(&mut self) -> BackendResult<()> {
        if self.remote.stall_cleanup {
            std::future::pending::<()>().await;
        }
        self.connected = false;
        Ok(())
    }
    fn is_connected(&self) -> bool {
        self.connected
    }
    fn set_log_sink(
        &mut self,
        _: Option<Arc<dyn Fn(crate::protocol::LogText, crate::protocol::LogKind) + Send + Sync>>,
    ) {
    }
    fn log_event(&self, key: &'static str, _: serde_json::Value, _: crate::protocol::LogKind) {
        self.remote.logged.lock().unwrap().push(key.to_string());
    }
    async fn list(&mut self, _: &str) -> BackendResult<Vec<EntryInfo>> {
        Ok(vec![])
    }
    async fn mkdir(&mut self, _: &str) -> BackendResult<()> {
        unreachable!()
    }
    async fn create_file(&mut self, _: &str) -> BackendResult<()> {
        unreachable!()
    }
    async fn remove(&mut self, path: &str, _: bool) -> BackendResult<()> {
        if self.remote.stall_cleanup {
            std::future::pending::<()>().await;
        }
        let held = &self.remote.held_removals;
        if held
            .try_update(SeqCst, SeqCst, |left| left.checked_sub(1))
            .is_ok()
        {
            anyhow::bail!("Permission denied");
        }
        self.remote.files.lock().unwrap().remove(path);
        Ok(())
    }
    async fn rename(&mut self, old: &str, new: &str) -> BackendResult<()> {
        anyhow::ensure!(
            !self.remote.reject_rename,
            "Server cannot replace via rename"
        );
        let mut files = self.remote.files.lock().unwrap();
        let bytes = files.remove(old).unwrap();
        files.insert(new.into(), bytes);
        Ok(())
    }
    async fn known_size(&mut self, path: &str) -> Option<u64> {
        Some(
            self.remote
                .files
                .lock()
                .unwrap()
                .get(path)
                .map_or(0, |bytes| bytes.len() as u64),
        )
    }
    async fn read_range(&mut self, path: &str, offset: u64, len: usize) -> BackendResult<Vec<u8>> {
        self.remote.ranges.lock().unwrap().push((offset, len));
        if self.remote.stall_read.load(SeqCst) {
            std::future::pending::<()>().await;
        }
        if self.remote.refuse_ranged_read {
            return Err(crate::protocol::fail(
                ErrorCode::InvalidInput,
                "This protocol cannot read a byte range",
            ));
        }
        let files = self.remote.files.lock().unwrap();
        let bytes = files.get(path).cloned().unwrap_or_default();
        let from = (offset as usize).min(bytes.len());
        let to = (from + len).min(bytes.len());
        Ok(bytes[from..to].to_vec())
    }
    async fn upload(
        &mut self,
        local: &std::path::Path,
        path: &str,
        resume: bool,
        sink: ProgressSink,
    ) -> BackendResult<()> {
        assert!(!resume);
        self.remote
            .files
            .lock()
            .unwrap()
            .insert(path.into(), b"new".to_vec());
        self.remote.writing.notify_one();
        if self.remote.rewrite_source {
            std::fs::write(local, b"xyz").unwrap();
        }
        if self.remote.lengthen_source {
            std::fs::write(local, b"abcdef").unwrap();
            return Err(crate::protocol::fail(
                ErrorCode::IntegrityMismatch,
                "Expected 3 bytes, received 6",
            ));
        }
        if self.remote.stall {
            std::future::pending::<()>().await;
        }
        sink(ProgressInfo::Done);
        Ok(())
    }
    async fn download(
        &mut self,
        _: &str,
        _: &std::path::Path,
        _: bool,
        _: ProgressSink,
    ) -> BackendResult<()> {
        unreachable!()
    }
    async fn download_to_writer(
        &mut self,
        path: &str,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> BackendResult<()> {
        self.remote.writing.notify_one();
        if self.remote.stall {
            std::future::pending::<()>().await;
        }
        let bytes = self.remote.files.lock().unwrap()[path].clone();
        writer.write_all(&bytes).await?;
        Ok(())
    }
    async fn upload_from_reader(
        &mut self,
        reader: &mut (dyn AsyncRead + Unpin + Send),
        path: &str,
    ) -> BackendResult<()> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        self.remote.files.lock().unwrap().insert(path.into(), bytes);
        Ok(())
    }
}
