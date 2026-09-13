//! What the renderer tells the tray icon to show, and what the icon reports
//! back. The renderer owns the transfer queue, the settings and the vault
//! state, so it hands over finished, localized strings; the backend only
//! draws them and says which item was clicked.

use serde::{Deserialize, Serialize};

/// Longest label the renderer may send, in characters. A menu item or a
/// status line has no use for more, and the tooltip is cut far shorter.
pub const MAX_TEXT_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayLabels {
    pub show: String,
    pub quit: String,
    pub pause_all: String,
    pub resume_all: String,
    pub lock_vault: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayTransfers {
    /// Transfers still running, queued or winding down.
    pub active: u32,
    pub can_pause_all: bool,
    pub can_resume_all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayModel {
    pub labels: TrayLabels,
    /// The finished status line, empty while nothing is transferring.
    pub status: String,
    pub transfers: TrayTransfers,
    /// The vault is set up and unlocked, so there is something to lock.
    pub vault_lockable: bool,
}

impl Default for TrayModel {
    /// What the icon shows before the renderer has sent anything.
    fn default() -> Self {
        Self {
            labels: TrayLabels {
                show: "Show FTPeach".into(),
                quit: "Quit".into(),
                pause_all: "Pause all transfers".into(),
                resume_all: "Resume all transfers".into(),
                lock_vault: "Lock saved passwords".into(),
            },
            status: String::new(),
            transfers: TrayTransfers::default(),
            vault_lockable: false,
        }
    }
}

impl TrayModel {
    pub fn validate(&self) -> Result<(), String> {
        let labels = &self.labels;
        [
            ("labels.show", &labels.show),
            ("labels.quit", &labels.quit),
            ("labels.pauseAll", &labels.pause_all),
            ("labels.resumeAll", &labels.resume_all),
            ("labels.lockVault", &labels.lock_vault),
            ("status", &self.status),
        ]
        .into_iter()
        .try_for_each(|(field, text)| check_text(field, text))
    }
}

fn check_text(field: &str, text: &str) -> Result<(), String> {
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!(
            "{field} is longer than {MAX_TEXT_CHARS} characters"
        ));
    }
    Ok(())
}

/// A tray menu click the renderer carries out, sent as `tray:action`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrayAction {
    PauseAll,
    ResumeAll,
    LockVault,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model_json() -> serde_json::Value {
        json!({
            "labels": {
                "show": "Show FTPeach",
                "quit": "Quit",
                "pauseAll": "Pause all transfers",
                "resumeAll": "Resume all transfers",
                "lockVault": "Lock saved passwords",
            },
            "status": "Transferring 3 · 42%",
            "transfers": { "active": 3, "canPauseAll": true, "canResumeAll": false },
            "vaultLockable": true,
        })
    }

    #[test]
    fn a_complete_model_deserializes() {
        let model: TrayModel = serde_json::from_value(model_json()).unwrap();
        assert_eq!(model.transfers.active, 3);
        assert!(model.transfers.can_pause_all);
        assert!(model.vault_lockable);
        assert_eq!(model.validate(), Ok(()));
    }

    #[test]
    fn unknown_fields_are_rejected_at_every_level() {
        let mut top = model_json();
        top["extra"] = json!(true);
        assert!(serde_json::from_value::<TrayModel>(top).is_err());

        let mut labels = model_json();
        labels["labels"]["extra"] = json!("x");
        assert!(serde_json::from_value::<TrayModel>(labels).is_err());

        let mut transfers = model_json();
        transfers["transfers"]["extra"] = json!(1);
        assert!(serde_json::from_value::<TrayModel>(transfers).is_err());
    }

    #[test]
    fn missing_fields_and_negative_counts_are_rejected() {
        let mut missing = model_json();
        missing.as_object_mut().unwrap().remove("status");
        assert!(serde_json::from_value::<TrayModel>(missing).is_err());

        let mut negative = model_json();
        negative["transfers"]["active"] = json!(-1);
        assert!(serde_json::from_value::<TrayModel>(negative).is_err());
    }

    #[test]
    fn overlong_text_fails_validation() {
        let mut model: TrayModel = serde_json::from_value(model_json()).unwrap();
        model.status = "x".repeat(MAX_TEXT_CHARS);
        assert_eq!(model.validate(), Ok(()));
        model.status.push('x');
        assert!(model.validate().unwrap_err().contains("status"));
    }

    #[test]
    fn actions_serialize_with_a_camel_case_kind() {
        assert_eq!(
            serde_json::to_value(TrayAction::PauseAll).unwrap(),
            json!({ "kind": "pauseAll" })
        );
        assert_eq!(
            serde_json::to_value(TrayAction::LockVault).unwrap(),
            json!({ "kind": "lockVault" })
        );
    }
}
