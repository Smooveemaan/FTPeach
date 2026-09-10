//! A downloaded update waiting on disk to be installed.
//!
//! The updater downloads in the background and leaves the installer here, so
//! the next launch can install it silently before any window appears -- or the
//! status bar can install it sooner. Sitting in this directory earns the file
//! no trust: it is checked against the release key again right before it runs.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MANIFEST: &str = "pending.json";

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: String,
    installer: String,
    signature: String,
    /// Set just before the installer starts. A staged update still waiting
    /// on the next launch did not install, and trying it again would make
    /// every launch another failed install.
    #[serde(default)]
    attempted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedUpdate {
    pub version: String,
    pub installer: PathBuf,
}

/// Writes a downloaded installer and what is needed to trust it later.
///
/// The version becomes part of a file name, so it has to parse as SemVer
/// first: the update feed is not signed, only the artifact is.
pub fn stage(
    dir: &Path,
    version: &str,
    signature: &str,
    bytes: &[u8],
) -> anyhow::Result<StagedUpdate> {
    let version = semver::Version::parse(version)?.to_string();
    // Whatever an earlier download left goes first, so the manifest can never
    // end up describing another version's installer.
    discard(dir);
    std::fs::create_dir_all(dir)?;
    let file_name = format!("FTPeach-{version}-setup.exe");
    let installer = dir.join(&file_name);
    std::fs::write(&installer, bytes)?;
    write_manifest(
        dir,
        &Manifest {
            version: version.clone(),
            installer: file_name,
            signature: signature.to_owned(),
            attempted: false,
        },
    )?;
    Ok(StagedUpdate { version, installer })
}

/// The staged update this launch should install, if there is one.
///
/// Anything else is cleared away: an update no newer than `current` (the
/// install that already happened, or a stale download), one whose install was
/// already attempted, and one that no longer matches its signature.
pub fn ready_to_install(
    dir: &Path,
    current: &semver::Version,
    pubkey: &str,
) -> Option<StagedUpdate> {
    match staged_update(dir, current, pubkey) {
        Ok(Some(staged)) => return Some(staged),
        Ok(None) => {}
        Err(error) => log::warn!("discarding the staged update: {error:#}"),
    }
    discard(dir);
    None
}

fn staged_update(
    dir: &Path,
    current: &semver::Version,
    pubkey: &str,
) -> anyhow::Result<Option<StagedUpdate>> {
    let manifest: Manifest = match std::fs::read(dir.join(MANIFEST)) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if semver::Version::parse(&manifest.version)? <= *current {
        return Ok(None);
    }
    if manifest.attempted {
        anyhow::bail!("the installer for {} did not complete", manifest.version);
    }
    let installer = dir.join(&manifest.installer);
    verify(&std::fs::read(&installer)?, &manifest.signature, pubkey)?;
    Ok(Some(StagedUpdate {
        version: manifest.version,
        installer,
    }))
}

/// Starts the installer without any window: `/S` is silent, `/UPDATE` leaves
/// shortcuts and user data alone, and `/R` starts the new version once the
/// files are in place. The update is marked as attempted first, so an
/// install that fails is not retried on every launch.
pub fn install(dir: &Path, staged: &StagedUpdate) -> anyhow::Result<()> {
    let mut manifest: Manifest = serde_json::from_slice(&std::fs::read(dir.join(MANIFEST))?)?;
    manifest.attempted = true;
    write_manifest(dir, &manifest)?;
    std::process::Command::new(&staged.installer)
        .args(["/S", "/UPDATE", "/R"])
        .spawn()?;
    Ok(())
}

/// Best effort: the installer that just updated FTPeach and started it may
/// still be running and cannot be deleted yet; the next launch tries again.
pub fn discard(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> anyhow::Result<()> {
    let temporary = dir.join(format!("{MANIFEST}.tmp"));
    std::fs::write(&temporary, serde_json::to_vec(manifest)?)?;
    std::fs::rename(&temporary, dir.join(MANIFEST))?;
    Ok(())
}

fn verify(bytes: &[u8], signature: &str, pubkey: &str) -> anyhow::Result<()> {
    let key = PublicKey::decode(&String::from_utf8(BASE64.decode(pubkey.trim())?)?)?;
    let signature = Signature::decode(&String::from_utf8(BASE64.decode(signature.trim())?)?)?;
    // `true` accepts the same legacy signatures tauri-plugin-updater does, so
    // nothing the download accepted is refused here.
    key.verify(bytes, &signature, true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARTIFACT: &[u8] = include_bytes!("../../../test/fixtures/updater/dummy-update.bin");
    const SIGNATURE: &str = include_str!("../../../test/fixtures/updater/dummy-update.bin.sig");
    const PUBKEY: &str = include_str!("../../../test/fixtures/updater/spike.key.pub");

    fn staging_dir() -> PathBuf {
        std::env::temp_dir().join(format!("ftpeach-update-staging-{}", uuid::Uuid::new_v4()))
    }

    fn current() -> semver::Version {
        semver::Version::new(0, 1, 1)
    }

    #[test]
    fn a_newer_signed_update_is_ready_to_install() {
        let dir = staging_dir();
        let staged = stage(&dir, "0.2.0", SIGNATURE, ARTIFACT).unwrap();
        assert_eq!(
            ready_to_install(&dir, &current(), PUBKEY),
            Some(staged.clone())
        );
        assert_eq!(std::fs::read(&staged.installer).unwrap(), ARTIFACT);
        discard(&dir);
    }

    #[test]
    fn an_update_that_is_not_newer_is_cleared_away() {
        let dir = staging_dir();
        stage(&dir, "0.1.1", SIGNATURE, ARTIFACT).unwrap();
        assert_eq!(ready_to_install(&dir, &current(), PUBKEY), None);
        assert!(!dir.exists());
    }

    #[test]
    fn a_tampered_installer_is_cleared_away() {
        let dir = staging_dir();
        let staged = stage(&dir, "0.2.0", SIGNATURE, ARTIFACT).unwrap();
        std::fs::write(&staged.installer, b"not the signed bytes").unwrap();
        assert_eq!(ready_to_install(&dir, &current(), PUBKEY), None);
        assert!(!dir.exists());
    }

    #[test]
    fn an_install_that_did_not_complete_is_not_retried() {
        let dir = staging_dir();
        let staged = stage(&dir, "0.2.0", SIGNATURE, ARTIFACT).unwrap();
        // The fixture is not an executable, so the start itself fails -- but
        // only after the attempt was recorded, as a failed install would be.
        assert!(install(&dir, &staged).is_err());
        assert_eq!(ready_to_install(&dir, &current(), PUBKEY), None);
        assert!(!dir.exists());
    }

    #[test]
    fn leftovers_without_a_manifest_are_cleared_away() {
        let dir = staging_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("FTPeach-0.2.0-setup.exe"), ARTIFACT).unwrap();
        assert_eq!(ready_to_install(&dir, &current(), PUBKEY), None);
        assert!(!dir.exists());
    }

    #[test]
    fn a_version_that_is_not_semver_never_reaches_a_file_name() {
        let dir = staging_dir();
        assert!(stage(&dir, r"..\..\evil", SIGNATURE, ARTIFACT).is_err());
        assert!(!dir.exists());
    }
}
