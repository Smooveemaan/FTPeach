//! How a drag-out download shows up in the Transfers panel like any other
//! transfer: its row appears when the drop starts pulling, then progress.

use super::DragOutFile;
use crate::ipc::CommandError;
use crate::transfer::error_kind::transfer_error_kind;
use crate::transfer::progress::{ProgressEmitter, TransferProgressPayload};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Emitted once per row the moment a drop target starts pulling bytes (i.e.
/// the drop actually happened and the download began) so the Transfers panel
/// can add it — the frontend only tracks rows it knows about, and unlike
/// every other transfer, it isn't the frontend that starts this one. A file
/// dragged out on its own gets a row; one inside a folder dragged out whole
/// reports through that folder's row instead (see `FolderRow`). Subsequent updates ride the ordinary `transfer:progress`
/// event under the same id.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DragOutStartedPayload {
    pub is_directory: bool,
    pub id: String,
    pub connection_id: String,
    pub protocol: String,
    pub name: String,
    pub remote_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// Everything a drag-out download needs to show up in the Transfers panel
/// like any other transfer.
#[derive(Clone)]
pub struct TransferReporter {
    app: AppHandle,
    progress: ProgressEmitter,
    connection_id: String,
    protocol: String,
}

impl TransferReporter {
    pub fn new(
        app: AppHandle,
        progress: ProgressEmitter,
        connection_id: String,
        protocol: String,
    ) -> Self {
        Self {
            app,
            progress,
            connection_id,
            protocol,
        }
    }

    pub fn started(&self, id: &str, file: &DragOutFile, total: Option<u64>) {
        let name = file
            .name
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&file.name)
            .to_string();
        let _ = self.app.emit(
            "transfer:dragOutStarted",
            DragOutStartedPayload {
                is_directory: file.is_directory,
                id: id.to_string(),
                connection_id: self.connection_id.clone(),
                protocol: self.protocol.clone(),
                name,
                remote_file: file.remote_path.clone(),
                total,
            },
        );
    }

    /// Says what a row is doing, leaving its numbers alone: "queued" while
    /// its download waits for a connection or a free transfer slot,
    /// "progress" once it has them.
    pub fn status(&self, id: &str, status: &'static str) {
        self.progress.send(TransferProgressPayload::status(
            id.to_string(),
            self.connection_id.clone(),
            status,
        ));
    }

    pub fn progress(&self, id: &str, bytes: u64, total: Option<u64>) {
        self.progress.send(TransferProgressPayload {
            bytes: Some(bytes),
            total,
            ..TransferProgressPayload::status(
                id.to_string(),
                self.connection_id.clone(),
                "progress",
            )
        });
    }

    pub fn done(&self, id: &str, bytes: u64, total: Option<u64>) {
        self.progress.send(TransferProgressPayload {
            bytes: Some(bytes),
            total,
            ..TransferProgressPayload::status(id.to_string(), self.connection_id.clone(), "done")
        });
    }

    pub fn error(&self, id: &str, failure: CommandError) {
        self.progress.send(TransferProgressPayload {
            error_code: Some(transfer_error_kind(failure.code)),
            // The raw text when we have it (it names the server reply), the
            // safe sentence otherwise; the renderer localizes the code anyway.
            error: Some(failure.details.unwrap_or(failure.message)),
            ..TransferProgressPayload::status(id.to_string(), self.connection_id.clone(), "error")
        });
    }
}
