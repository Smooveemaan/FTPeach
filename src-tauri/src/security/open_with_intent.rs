//! Everything an Open with grant authorizes, resolved once by the backend.
//!
//! The remote name is only a hint: the file lands under the name
//! [`safe_temp_name`] produces, and Windows decides how to open it from that
//! final name. `report.cmd.` passes an extension check as a document and is
//! saved as `report.cmd`, so the classification must come from the final
//! name. The grant covers the connection and the program too, so a token
//! issued for opening a document cannot launch another server's file or be
//! handed to a different program.
use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::local_fs::local_open::{ApprovedLocalPaths, is_executable};
use crate::security::connection_guard::safe_temp_name;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithIntent {
    pub connection_id: String,
    pub remote_path: String,
    /// The file name the download is written under.
    pub local_name: String,
    /// Whether Windows treats `local_name` as a program or script.
    pub executable: bool,
    /// The canonical program, or `None` for the file's default handler.
    pub application: Option<PathBuf>,
}

/// What the renderer names when it asks for an Open with grant.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenWithRequest {
    connection_id: String,
    remote_path: String,
    application: Option<String>,
}

pub fn remote_name(remote_path: &str) -> &str {
    remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(remote_path)
}

impl OpenWithIntent {
    /// Parses the authorization target the renderer sends for Open with.
    pub fn from_request(target: &str, approved: &ApprovedLocalPaths) -> CommandResult<Self> {
        let request: OpenWithRequest = serde_json::from_str(target).map_err(|_| {
            CommandError::new(ErrorCode::PermissionDenied, "Invalid Open with request")
        })?;
        Self::resolve(
            &request.connection_id,
            &request.remote_path,
            request.application.as_deref(),
            approved,
        )
    }

    pub fn resolve(
        connection_id: &str,
        remote_path: &str,
        application: Option<&str>,
        approved: &ApprovedLocalPaths,
    ) -> CommandResult<Self> {
        let local_name = safe_temp_name(remote_name(remote_path));
        let application = application
            .filter(|value| !value.trim().is_empty())
            .map(|value| approved.canonical_application(Path::new(value)))
            .transpose()?;
        Ok(Self {
            connection_id: connection_id.to_owned(),
            remote_path: remote_path.to_owned(),
            executable: is_executable(Path::new(&local_name)),
            local_name,
            application,
        })
    }

    /// The exact value a grant is bound to: any differing field is a
    /// different operation.
    pub fn grant_target(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The local name, when it differs from what the server listed.
    pub fn renamed_local_name(&self) -> Option<&str> {
        (remote_name(&self.remote_path) != self.local_name).then_some(self.local_name.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(remote_path: &str) -> OpenWithIntent {
        OpenWithIntent::resolve("c1", remote_path, None, &ApprovedLocalPaths::default()).unwrap()
    }

    #[test]
    fn classification_follows_the_name_the_file_is_saved_under() {
        for remote in [
            "/srv/report.cmd.",
            "/srv/report.cmd ",
            "/srv/report.hta...",
            "/srv/report.ps1.",
            "/srv/report.CmD. . ",
            "/srv/REPORT.EXE",
        ] {
            let resolved = intent(remote);
            assert!(resolved.executable, "{remote:?} -> {}", resolved.local_name);
        }
        for remote in [
            "/srv/report.txt",
            "/srv/report.txt.",
            "/srv/report.cmd\u{200b}",
            "/srv/report.cmd::$DATA",
            "/srv/report.cmd\u{1}",
            "/srv/\u{62a5}\u{544a}.pdf",
        ] {
            let resolved = intent(remote);
            assert!(
                !resolved.executable,
                "{remote:?} -> {}",
                resolved.local_name
            );
        }
    }

    #[test]
    fn a_rename_during_download_is_reported() {
        assert_eq!(
            intent("/srv/report.cmd.").renamed_local_name(),
            Some("report.cmd")
        );
        assert_eq!(intent("/srv/report.txt").renamed_local_name(), None);
    }

    #[test]
    fn every_field_takes_part_in_the_grant() {
        let base = intent("/srv/report.txt");
        let other_connection = OpenWithIntent::resolve(
            "c2",
            "/srv/report.txt",
            None,
            &ApprovedLocalPaths::default(),
        )
        .unwrap();
        let other_path = intent("/srv/report2.txt");
        let mut other_application = base.clone();
        other_application.application = Some(PathBuf::from(r"C:\Windows\System32\cmd.exe"));
        for other in [other_connection, other_path, other_application] {
            assert_ne!(base.grant_target(), other.grant_target());
        }
    }

    #[test]
    fn requests_with_unknown_fields_or_missing_programs_are_refused() {
        let approved = ApprovedLocalPaths::default();
        assert!(
            OpenWithIntent::from_request(
                r#"{"connectionId":"c1","remotePath":"/a.txt","application":null,"kind":"x"}"#,
                &approved
            )
            .is_err()
        );
        assert!(OpenWithIntent::from_request("/a.txt", &approved).is_err());
        let missing = OpenWithIntent::from_request(
            r#"{"connectionId":"c1","remotePath":"/a.txt","application":"C:\\missing\\app.exe"}"#,
            &approved,
        )
        .unwrap_err();
        assert_eq!(missing.code, ErrorCode::InvalidInput);
        let blank = OpenWithIntent::from_request(
            r#"{"connectionId":"c1","remotePath":"/a.txt","application":"  "}"#,
            &approved,
        )
        .unwrap();
        assert_eq!(blank.application, None);
    }
}
