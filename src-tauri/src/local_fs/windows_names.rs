//! Which names Windows stores as an ordinary file of exactly that name.
//!
//! The one authority for names FTPeach did not choose: downloads, drag-out
//! descriptors and "Open with" temporary copies. The renderer repeats
//! [`validate_file_name`] only to refuse a doomed download before it is
//! queued; `test/fixtures/windows-names.json` holds both to the same verdicts.
use crate::ipc::{CommandError, ErrorCode};

/// A DOS device name, bare or with an extension. Windows 11 treats most of
/// these as ordinary files, Windows 10 does not, so the set covers both.
pub(crate) fn is_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

/// One file or folder name: no device, no stream separator, no character
/// Win32 refuses and no trailing dot or space it would silently strip.
/// Traversal and separators are the caller's concern.
pub(crate) fn validate_file_name(name: &str) -> Result<(), CommandError> {
    if is_reserved_name(name)
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            format!("{name}: invalid Windows file name"),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    pub(crate) struct Names {
        pub(crate) rejected: Vec<String>,
        pub(crate) accepted: Vec<String>,
    }

    pub(crate) fn fixture() -> Names {
        serde_json::from_str(include_str!("../../../test/fixtures/windows-names.json")).unwrap()
    }

    #[test]
    fn shared_fixture_verdicts() {
        let names = fixture();
        for name in &names.rejected {
            let error = validate_file_name(name).expect_err(name);
            assert_eq!(error.code, ErrorCode::InvalidInput, "{name:?}");
        }
        for name in &names.accepted {
            assert!(validate_file_name(name).is_ok(), "{name:?}");
        }
    }

    /// Windows is the oracle for the direction that matters: a name the
    /// rules accept must never open a device or a stream on the running
    /// system. Windows 11 no longer reserves most device names, so this
    /// cannot prove the reserved set is needed there, only that the
    /// accepted set is safe.
    #[cfg(windows)]
    #[test]
    fn accepted_names_create_exactly_that_file() {
        let dir = std::env::temp_dir().join(format!("ftpeach-names-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        for name in fixture().accepted {
            assert_creates_exactly(&dir, &name, &name);
        }
        std::fs::remove_dir(&dir).unwrap();
    }

    /// Writes `name` into the empty `dir` and asserts Windows stored one
    /// ordinary file of exactly that name, then removes it. `source` is the
    /// name the case started from, for the failure message.
    #[cfg(windows)]
    pub(crate) fn assert_creates_exactly(dir: &std::path::Path, name: &str, source: &str) {
        let path = dir.join(name);
        std::fs::write(&path, b"x")
            .unwrap_or_else(|error| panic!("{source:?} -> {name:?}: {error}"));
        let listed: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(listed, [std::ffi::OsString::from(name)], "{source:?}");
        assert!(std::fs::metadata(&path).unwrap().is_file(), "{source:?}");
        std::fs::remove_file(&path).unwrap();
    }
}
