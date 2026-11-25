//! Interactive SSH terminal channels multiplexed over live SFTP sessions.
//!
//! Terminal input and output never pass through `LogEmitter` or file logs
//! because interactive shells carry sudo passwords, API tokens and environment
//! secrets.

mod session;
#[cfg(test)]
mod tests;

use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::protocol::SshSessionHandle;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Notify, mpsc};

/// Maximum number of concurrent PTY channels across the process.
pub const MAX_TERMINALS: usize = 16;
pub const MIN_COLS: u32 = 2;
pub const MAX_COLS: u32 = 500;
pub const MIN_ROWS: u32 = 1;
pub const MAX_ROWS: u32 = 200;
/// Maximum payload size accepted by a single `terminal_write` IPC call.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;
/// Unacknowledged bytes allowed in flight to the renderer before reads pause.
pub const MAX_IN_FLIGHT_BYTES: usize = 128 * 1024;
/// Bounded queue for renderer -> SSH input/resize/close control messages.
const INPUT_QUEUE_CAPACITY: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// Base64-encoded raw PTY bytes along with the decoded byte count to ack.
    Output { data: String, bytes: usize },
    /// Remote shell exited (with optional POSIX exit code).
    Exit { code: Option<u32> },
    /// Terminal was closed locally or because its SSH connection ended.
    Closed { reason: Option<String> },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum TerminalOpenOutcome {
    #[serde(rename_all = "camelCase")]
    Opened { terminal_id: String },
    #[serde(rename_all = "camelCase")]
    ShellRefused { message: String },
}

pub type TerminalEventSink = Arc<dyn Fn(TerminalEvent) -> Result<(), String> + Send + Sync>;

pub(crate) enum TerminalInput {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub(crate) struct CreditState {
    pub in_flight: AtomicUsize,
    pub notify: Notify,
}

impl Default for CreditState {
    fn default() -> Self {
        Self {
            in_flight: AtomicUsize::new(0),
            notify: Notify::new(),
        }
    }
}

struct TerminalEntry {
    connection_id: String,
    input_tx: mpsc::Sender<TerminalInput>,
    credit: Arc<CreditState>,
    task: tokio::task::JoinHandle<()>,
}

/// Process-wide registry of live SSH terminal channels.
#[derive(Clone, Default)]
pub struct Terminals {
    entries: Arc<StdMutex<HashMap<String, TerminalEntry>>>,
    /// Counts slots reserved while an async PTY/shell handshake is in flight.
    pending_opens: Arc<AtomicUsize>,
}

struct PendingGuard(Arc<AtomicUsize>);
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) fn validate_dimensions(cols: u32, rows: u32) -> CommandResult<()> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            format!(
                "Terminal size must be within {MIN_COLS}..={MAX_COLS} cols and {MIN_ROWS}..={MAX_ROWS} rows"
            ),
        ));
    }
    Ok(())
}

impl Terminals {
    /// Opens a new PTY + interactive shell channel on an existing SSH session.
    pub async fn open(
        &self,
        connection_id: &str,
        ssh: Arc<dyn SshSessionHandle>,
        cols: u32,
        rows: u32,
        sink: TerminalEventSink,
    ) -> CommandResult<TerminalOpenOutcome> {
        validate_dimensions(cols, rows)?;
        if ssh.is_closed() {
            return Err(CommandError::new(
                ErrorCode::ConnectionLost,
                "The SSH connection is closed",
            ));
        }

        let _pending = self.reserve_slot()?;

        let mut channel = match ssh.open_session_channel().await {
            Ok(channel) => channel,
            Err(error) => {
                if ssh.is_closed() {
                    return Err(CommandError::new(
                        ErrorCode::ConnectionLost,
                        "The SSH connection is closed",
                    ));
                }
                return Ok(TerminalOpenOutcome::ShellRefused {
                    message: format!("{error:#}"),
                });
            }
        };

        let early_output = match session::open_pty_shell(&mut channel, cols, rows).await {
            Ok(output) => output,
            Err(session::ShellOpenError::Refused(message)) => {
                let _ = channel.close().await;
                return Ok(TerminalOpenOutcome::ShellRefused { message });
            }
            Err(session::ShellOpenError::Lost(message)) => {
                let _ = channel.close().await;
                return Err(CommandError::new(ErrorCode::ConnectionLost, message));
            }
        };

        let terminal_id = uuid::Uuid::new_v4().to_string();
        let (input_tx, input_rx) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let credit = Arc::new(CreditState::default());

        let cleanup_entries = self.entries.clone();
        let cleanup_id = terminal_id.clone();
        let task_credit = credit.clone();
        let task = tokio::spawn(async move {
            session::run_terminal_loop(channel, early_output, input_rx, task_credit, sink).await;
            cleanup_entries.lock().unwrap().remove(&cleanup_id);
        });

        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= MAX_TERMINALS {
            drop(entries);
            let _ = input_tx.try_send(TerminalInput::Close);
            task.abort();
            return Err(CommandError::new(
                ErrorCode::ResourceLimit,
                "Too many terminals are open",
            ));
        }
        entries.insert(
            terminal_id.clone(),
            TerminalEntry {
                connection_id: connection_id.to_owned(),
                input_tx,
                credit,
                task,
            },
        );
        drop(entries);

        Ok(TerminalOpenOutcome::Opened { terminal_id })
    }

    fn reserve_slot(&self) -> CommandResult<PendingGuard> {
        let entries = self.entries.lock().unwrap();
        let in_flight = self.pending_opens.load(Ordering::Acquire);
        if entries.len().saturating_add(in_flight) >= MAX_TERMINALS {
            return Err(CommandError::new(
                ErrorCode::ResourceLimit,
                "Too many terminals are open",
            ));
        }
        self.pending_opens.fetch_add(1, Ordering::AcqRel);
        Ok(PendingGuard(self.pending_opens.clone()))
    }

    pub async fn write(&self, terminal_id: &str, data: Vec<u8>) -> CommandResult<()> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(CommandError::new(
                ErrorCode::ResourceLimit,
                format!("Terminal write exceeds the {MAX_WRITE_BYTES}-byte limit"),
            ));
        }
        if data.is_empty() {
            return Ok(());
        }
        let tx = self.sender_for(terminal_id)?;
        tx.send(TerminalInput::Write(data))
            .await
            .map_err(|_| CommandError::new(ErrorCode::ConnectionLost, "Terminal is closed"))
    }

    pub async fn resize(&self, terminal_id: &str, cols: u32, rows: u32) -> CommandResult<()> {
        validate_dimensions(cols, rows)?;
        let tx = self.sender_for(terminal_id)?;
        tx.send(TerminalInput::Resize { cols, rows })
            .await
            .map_err(|_| CommandError::new(ErrorCode::ConnectionLost, "Terminal is closed"))
    }

    pub fn ack(&self, terminal_id: &str, bytes: usize) -> CommandResult<()> {
        let credit = {
            let entries = self.entries.lock().unwrap();
            entries.get(terminal_id).map(|entry| entry.credit.clone())
        };
        let Some(credit) = credit else {
            // An ack arriving just after close is harmless.
            return Ok(());
        };
        if bytes > 0 {
            let _ = credit
                .in_flight
                .try_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    Some(current.saturating_sub(bytes))
                });
            credit.notify.notify_one();
        }
        Ok(())
    }

    pub fn close(&self, terminal_id: &str) -> CommandResult<()> {
        let entry = self.entries.lock().unwrap().remove(terminal_id);
        if let Some(entry) = entry {
            stop_entry(entry);
        }
        Ok(())
    }

    pub fn close_for_connection(&self, connection_id: &str) {
        let removed: Vec<TerminalEntry> = {
            let mut entries = self.entries.lock().unwrap();
            let ids: Vec<String> = entries
                .iter()
                .filter(|(_, entry)| entry.connection_id == connection_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| entries.remove(&id))
                .collect()
        };
        for entry in removed {
            stop_entry(entry);
        }
    }

    pub fn close_all(&self) {
        let removed: Vec<TerminalEntry> = {
            let mut entries = self.entries.lock().unwrap();
            entries.drain().map(|(_, entry)| entry).collect()
        };
        for entry in removed {
            stop_entry(entry);
        }
    }

    #[cfg(test)]
    pub(crate) fn active_count(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    fn sender_for(&self, terminal_id: &str) -> CommandResult<mpsc::Sender<TerminalInput>> {
        self.entries
            .lock()
            .unwrap()
            .get(terminal_id)
            .map(|entry| entry.input_tx.clone())
            .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "Terminal session not found"))
    }
}

fn stop_entry(entry: TerminalEntry) {
    if entry.input_tx.try_send(TerminalInput::Close).is_err() {
        entry.task.abort();
    }
}
