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
//!
//! A portable copy has no installer. What waits here for it is the release's
//! zip, held to the same checks, and installing it means unpacking it beside
//! this folder's own files and swapping them for the program's.

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

/// What is staged: the installer an installed copy runs, or the zip a
/// portable copy unpacks over its own folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Package {
    Installer,
    PortableZip,
}

impl Package {
    fn file_name(self, version: &str) -> String {
        match self {
            Self::Installer => format!("FTPeach-{version}-setup.exe"),
            Self::PortableZip => format!("FTPeach-{version}-portable.zip"),
        }
    }
}

/// The program inside the portable zip.
const PORTABLE_EXE: &str = "FTPeach.exe";
/// Far above FTPeach unpacked; a zip that holds more is not one of ours.
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;

/// Writes a downloaded installer and what is needed to trust it later.
///
/// The version becomes part of a file name, so it has to parse as SemVer
/// first: the update feed is not signed, only the artifact is.
pub fn stage(
    dir: &Path,
    version: &str,
    signature: &str,
    bytes: &[u8],
    package: Package,
) -> anyhow::Result<StagedUpdate> {
    let version = semver::Version::parse(version)?.to_string();
    if bytes.len() as u64 > MAX_INSTALLER_BYTES {
        anyhow::bail!("the downloaded installer is larger than any FTPeach installer");
    }
    // Whatever an earlier download left goes first, so the manifest can never
    // end up describing another version's installer.
    discard(dir);
    std::fs::create_dir_all(dir)?;
    let file_name = package.file_name(&version);
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
/// embedded in them is the manifest's and newer than `current`. For the
/// portable zip that version is the one of the program inside it.
fn release_checks<'a>(
    current: &'a semver::Version,
    pubkey: &'a str,
    package: Package,
) -> impl Fn(&[u8], &Manifest) -> anyhow::Result<()> + 'a {
    move |bytes, manifest| {
        verify(bytes, &manifest.signature, pubkey)?;
        match package {
            Package::Installer => check_embedded_version(bytes, &manifest.version, current),
            Package::PortableZip => check_portable_zip(bytes, &manifest.version, current),
        }
    }
}

/// Where an entry of the portable zip goes, relative to the program's folder.
/// A name that would leave that folder is refused, and so is anything under
/// `data`: an update replaces the program, never what the user stored.
fn entry_path<R: Read>(file: &zip::read::ZipFile<'_, R>) -> anyhow::Result<PathBuf> {
    let path = file
        .enclosed_name()
        .filter(|_| !file.is_symlink())
        .ok_or_else(|| anyhow::anyhow!("the update names a file outside the program's folder"))?;
    let first = path.components().next();
    if first.is_some_and(|first| first.as_os_str().eq_ignore_ascii_case("data")) {
        anyhow::bail!("the update would write into the data folder");
    }
    Ok(path)
}

/// Every entry of the zip stays inside the program's folder, the whole of it
/// unpacks to a bounded size, and the program it carries passes the version
/// check an installer does.
fn check_portable_zip(
    bytes: &[u8],
    manifest_version: &str,
    current: &semver::Version,
) -> anyhow::Result<()> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut unpacked = 0u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        entry_path(&file)?;
        unpacked = unpacked.saturating_add(file.size());
    }
    if unpacked > MAX_UNPACKED_BYTES {
        anyhow::bail!("the update unpacks to more than any FTPeach");
    }
    let mut exe = Vec::new();
    archive
        .by_name(PORTABLE_EXE)?
        .take(MAX_INSTALLER_BYTES + 1)
        .read_to_end(&mut exe)?;
    check_embedded_version(&exe, manifest_version, current)
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
    package: Package,
) -> Option<StagedUpdate> {
    let check = release_checks(current, pubkey, package);
    ready_with(dir, current, package, &check)
}

fn ready_with(
    dir: &Path,
    current: &semver::Version,
    package: Package,
    check: Checker,
) -> Option<StagedUpdate> {
    let staged = read_manifest(dir).and_then(|manifest| match manifest {
        Some(manifest) if !is_newer(&manifest, current)? => Ok(None),
        Some(manifest) => {
            let pinned = Pinned::open(dir, &manifest, package)?;
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
    let package = Package::Installer;
    let check = release_checks(current, pubkey, package);
    install_with(dir, current, package, &check, &|path| {
        std::process::Command::new(path)
            .args(["/S", "/UPDATE", "/R"])
            .spawn()
            .map(drop)
    })
}

/// Installs the staged zip over the portable copy whose program is `exe`,
/// then hands the new program to `start`. The same checks and the same
/// "attempted" mark as [`install`]; the zip stays pinned while it is
/// unpacked, so what is unpacked is what was checked.
pub fn install_portable(
    dir: &Path,
    current: &semver::Version,
    pubkey: &str,
    exe: &Path,
    start: &dyn Fn(&Path) -> std::io::Result<()>,
) -> anyhow::Result<String> {
    let package = Package::PortableZip;
    let check = release_checks(current, pubkey, package);
    install_with(dir, current, package, &check, &|zip| {
        replace_program(zip, &dir.join("new"), exe, start)
    })
}

/// Unpacks `zip` into `unpacked`, moves its files into the folder of `exe`
/// with the program itself last, and starts the new program. Until the
/// program is swapped nothing the old one needs is gone; if the new one
/// cannot be put in place or started, the old one is put back.
fn replace_program(
    zip: &Path,
    unpacked: &Path,
    exe: &Path,
    start: &dyn Fn(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let root = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("the program has no folder"))?;
    let _ = std::fs::remove_dir_all(unpacked);
    unpack(zip, unpacked)?;
    let new_exe = unpacked.join(PORTABLE_EXE);
    move_tree(unpacked, root, &new_exe)?;
    // Windows lets a running program be renamed, not overwritten.
    let old_exe = replaced_name(exe);
    let _ = std::fs::remove_file(&old_exe);
    std::fs::rename(exe, &old_exe)?;
    let started = std::fs::rename(&new_exe, exe).and_then(|()| start(exe));
    if started.is_err() {
        let _ = std::fs::remove_file(exe);
        if let Err(error) = std::fs::rename(&old_exe, exe) {
            log::warn!("could not put the previous program back: {error}");
        }
    }
    started
}

fn unpack(zip: &Path, destination: &Path) -> std::io::Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(zip)?)?;
    let mut budget = MAX_UNPACKED_BYTES;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let target = destination.join(entry_path(&file).map_err(std::io::Error::other)?);
        if file.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // The sizes a zip declares are its own claim; count what comes out.
        let written = std::io::copy(
            &mut (&mut file).take(budget + 1),
            &mut File::create(target)?,
        )?;
        budget = budget
            .checked_sub(written)
            .ok_or_else(|| std::io::Error::other("the update unpacks to more than any FTPeach"))?;
    }
    Ok(())
}

/// Moves every file under `from` to the same place under `to`, replacing
/// what is there. `skip` is left where it is.
fn move_tree(from: &Path, to: &Path, skip: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&target)?;
            move_tree(&source, &target, skip)?;
        } else if source != skip {
            std::fs::rename(&source, &target)?;
        }
    }
    Ok(())
}

fn replaced_name(exe: &Path) -> PathBuf {
    let mut name = exe.as_os_str().to_owned();
    name.push(".old");
    PathBuf::from(name)
}

/// Removes the program a portable update replaced. Best effort: it may still
/// be exiting, and the next launch tries again.
pub fn remove_replaced(exe: &Path) {
    let _ = std::fs::remove_file(replaced_name(exe));
}

fn install_with(
    dir: &Path,
    current: &semver::Version,
    package: Package,
    check: Checker,
    launch: &dyn Fn(&Path) -> std::io::Result<()>,
) -> anyhow::Result<String> {
    let mut manifest = read_manifest(dir)?.ok_or_else(|| anyhow::anyhow!("No staged update"))?;
    if !is_newer(&manifest, current)? {
        anyhow::bail!("the staged update is not newer than {current}");
    }
    let pinned = Pinned::open(dir, &manifest, package)?;
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
    fn open(dir: &Path, manifest: &Manifest, package: Package) -> anyhow::Result<Self> {
        // The manifest is not signed: it may only name the one file this
        // module would have written for its version, inside `dir`.
        if manifest.installer != package.file_name(&manifest.version) {
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
