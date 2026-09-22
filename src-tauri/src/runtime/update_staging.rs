//! A downloaded update waiting on disk to be installed.
//!
//! The updater downloads in the background and leaves the installer here, so
//! the next launch can install it silently before any window appears -- or the
//! status bar can install it sooner. Sitting in this directory earns the file
//! no trust. Right before it runs, the installer is opened so that nothing can
//! write, replace or rename it or the directories above it, the bytes read
//! through that handle are checked against the release key, and the version
//! the installer itself carries must be the one the manifest names and newer
//! than this build. It is started while those handles are still held, so what
//! runs is what was checked.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const MANIFEST: &str = "pending.json";
/// Far above any real manifest; it is read whole before parsing.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// Far above FTPeach's installer; it is read whole to be verified.
pub const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;

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

fn installer_name(version: &str) -> String {
    format!("FTPeach-{version}-setup.exe")
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
    if bytes.len() as u64 > MAX_INSTALLER_BYTES {
        anyhow::bail!("the downloaded installer is larger than any FTPeach installer");
    }
    // Whatever an earlier download left goes first, so the manifest can never
    // end up describing another version's installer.
    discard(dir);
    std::fs::create_dir_all(dir)?;
    let file_name = installer_name(&version);
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

/// Checks the bytes of a staged installer against its manifest.
type Checker<'a> = &'a dyn Fn(&[u8], &Manifest) -> anyhow::Result<()>;

/// The release checks: the release key signed these bytes, and the version
/// embedded in them is the manifest's and newer than `current`.
fn release_checks<'a>(
    current: &'a semver::Version,
    pubkey: &'a str,
) -> impl Fn(&[u8], &Manifest) -> anyhow::Result<()> + 'a {
    move |bytes, manifest| {
        verify(bytes, &manifest.signature, pubkey)?;
        check_embedded_version(bytes, &manifest.version, current)
    }
}

/// The installer's own version must be the manifest's and newer than
/// `current`; a missing version fails closed.
fn check_embedded_version(
    bytes: &[u8],
    manifest_version: &str,
    current: &semver::Version,
) -> anyhow::Result<()> {
    let version = semver::Version::parse(manifest_version)?;
    let embedded = embedded_version(bytes)
        .ok_or_else(|| anyhow::anyhow!("the installer carries no version"))?;
    if embedded != (version.major, version.minor, version.patch) {
        anyhow::bail!(
            "the installer is version {}.{}.{}, not {version}",
            embedded.0,
            embedded.1,
            embedded.2
        );
    }
    if version <= *current {
        anyhow::bail!("the installer is not newer than {current}");
    }
    Ok(())
}

/// The staged update this launch should install, if there is one.
///
/// Anything else is cleared away: an update no newer than `current` (the
/// install that already happened, or a stale download), one whose install was
/// already attempted, and one that fails the release checks.
pub fn ready_to_install(
    dir: &Path,
    current: &semver::Version,
    pubkey: &str,
) -> Option<StagedUpdate> {
    ready_with(dir, current, &release_checks(current, pubkey))
}

fn ready_with(dir: &Path, current: &semver::Version, check: Checker) -> Option<StagedUpdate> {
    let staged = read_manifest(dir).and_then(|manifest| match manifest {
        Some(manifest) if !is_newer(&manifest, current)? => Ok(None),
        Some(manifest) => {
            let pinned = Pinned::open(dir, &manifest)?;
            pinned.check(&manifest, check)?;
            Ok(Some(pinned.staged(&manifest)))
        }
        None => Ok(None),
    });
    match staged {
        Ok(Some(staged)) => return Some(staged),
        Ok(None) => {}
        Err(error) => log::warn!("discarding the staged update: {error:#}"),
    }
    discard(dir);
    None
}

fn is_newer(manifest: &Manifest, current: &semver::Version) -> anyhow::Result<bool> {
    if semver::Version::parse(&manifest.version)? <= *current {
        return Ok(false);
    }
    if manifest.attempted {
        anyhow::bail!("the installer for {} did not complete", manifest.version);
    }
    Ok(true)
}

/// Starts the staged installer without any window: `/S` is silent,
/// `/UPDATE` leaves shortcuts and user data alone, and `/R` starts the new
/// version once the files are in place. The update is marked as attempted
/// first, so an install that fails is not retried on every launch.
pub fn install(dir: &Path, current: &semver::Version, pubkey: &str) -> anyhow::Result<String> {
    install_with(dir, current, &release_checks(current, pubkey), &|path| {
        std::process::Command::new(path)
            .args(["/S", "/UPDATE", "/R"])
            .spawn()
            .map(drop)
    })
}

fn install_with(
    dir: &Path,
    current: &semver::Version,
    check: Checker,
    launch: &dyn Fn(&Path) -> std::io::Result<()>,
) -> anyhow::Result<String> {
    let mut manifest = read_manifest(dir)?.ok_or_else(|| anyhow::anyhow!("No staged update"))?;
    if !is_newer(&manifest, current)? {
        anyhow::bail!("the staged update is not newer than {current}");
    }
    let pinned = Pinned::open(dir, &manifest)?;
    pinned.check(&manifest, check)?;
    manifest.attempted = true;
    write_manifest(dir, &manifest)?;
    launch(&pinned.path)?;
    // The handles close only now, after the installer has its own.
    drop(pinned);
    Ok(manifest.version)
}

/// A staged installer held open so that nothing can write, replace or
/// rename it, or rename the directories above it, while it is checked and
/// started. Reparse points are refused, so the path keeps naming the file
/// that was opened.
struct Pinned {
    file: File,
    path: PathBuf,
    _directories: Vec<File>,
}

#[cfg(windows)]
mod pin {
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Path;

    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    fn refuse_reparse_point(handle: &File, path: &Path) -> anyhow::Result<()> {
        if handle.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            anyhow::bail!("{} is a link, not the staged update", path.display());
        }
        Ok(())
    }

    /// Children may still change; the directory itself cannot be renamed
    /// or deleted while the handle is open.
    pub fn directory(path: &Path) -> anyhow::Result<File> {
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        refuse_reparse_point(&handle, path)?;
        Ok(handle)
    }

    /// Others may read and run the file, but not write, rename or delete it.
    pub fn file(path: &Path) -> anyhow::Result<File> {
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        refuse_reparse_point(&handle, path)?;
        if !handle.metadata()?.is_file() {
            anyhow::bail!("{} is not a file", path.display());
        }
        Ok(handle)
    }
}

#[cfg(not(windows))]
mod pin {
    use std::fs::File;
    use std::path::Path;

    pub fn directory(path: &Path) -> anyhow::Result<File> {
        Ok(File::open(path)?)
    }

    pub fn file(path: &Path) -> anyhow::Result<File> {
        Ok(File::open(path)?)
    }
}

impl Pinned {
    fn open(dir: &Path, manifest: &Manifest) -> anyhow::Result<Self> {
        // The manifest is not signed: it may only name the one file this
        // module would have written for its version, inside `dir`.
        if manifest.installer != installer_name(&manifest.version) {
            anyhow::bail!("the manifest names an unexpected installer");
        }
        let mut directories = Vec::new();
        for directory in [dir.parent(), Some(dir)].into_iter().flatten() {
            directories.push(pin::directory(directory)?);
        }
        let path = dir.join(&manifest.installer);
        let file = pin::file(&path)?;
        Ok(Self {
            file,
            path,
            _directories: directories,
        })
    }

    fn check(&self, manifest: &Manifest, check: Checker) -> anyhow::Result<()> {
        let mut bytes = Vec::new();
        (&self.file)
            .take(MAX_INSTALLER_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_INSTALLER_BYTES {
            anyhow::bail!("the staged installer is larger than any FTPeach installer");
        }
        check(&bytes, manifest)
    }

    fn staged(&self, manifest: &Manifest) -> StagedUpdate {
        StagedUpdate {
            version: manifest.version.clone(),
            installer: self.path.clone(),
        }
    }
}

fn read_manifest(dir: &Path) -> anyhow::Result<Option<Manifest>> {
    let file = match File::open(dir.join(MANIFEST)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        anyhow::bail!("the update manifest is too large");
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

/// The product version in an installer's `VS_FIXEDFILEINFO`, which Tauri's
/// NSIS installer fills from the app version (`VIProductVersion`). It is
/// part of the signed bytes, so an older installer cannot pass for a newer
/// one by what the unsigned manifest says.
pub fn embedded_version(bytes: &[u8]) -> Option<(u64, u64, u64)> {
    const SIGNATURE: [u8; 4] = 0xFEEF_04BDu32.to_le_bytes();
    const STRUCTURE_VERSION: [u8; 4] = 0x0001_0000u32.to_le_bytes();
    let word = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    let start = bytes
        .windows(8)
        .position(|window| window[..4] == SIGNATURE && window[4..] == STRUCTURE_VERSION)?;
    let (high, low) = (word(start + 16)?, word(start + 20)?);
    let version = (
        u64::from(high >> 16),
        u64::from(high & 0xFFFF),
        u64::from(low >> 16),
    );
    (version != (0, 0, 0)).then_some(version)
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
#[path = "update_staging_tests.rs"]
mod tests;
