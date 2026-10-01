use super::*;

const ARTIFACT: &[u8] = include_bytes!("../../../test/fixtures/updater/dummy-update.bin");
const SIGNATURE: &str = include_str!("../../../test/fixtures/updater/dummy-update.bin.sig");
const PUBKEY: &str = include_str!("../../../test/fixtures/updater/spike.key.pub");

fn staging_dir() -> PathBuf {
    std::env::temp_dir()
        .join(format!("ftpeach-update-{}", uuid::Uuid::new_v4()))
        .join("updates")
}

fn current() -> semver::Version {
    semver::Version::new(0, 1, 1)
}

/// The fixture key signed only `dummy-update.bin`, which carries no version
/// resource, so these checks keep the signature and leave the embedded
/// version to its own tests.
fn signature_only(bytes: &[u8], manifest: &Manifest) -> anyhow::Result<()> {
    verify(bytes, &manifest.signature, PUBKEY)
}

fn never_launch(_: &Path) -> std::io::Result<()> {
    panic!("the installer must not start");
}

/// A `VS_FIXEDFILEINFO` with the given product version, amid other bytes.
fn with_version(major: u16, minor: u16, patch: u16) -> Vec<u8> {
    let mut bytes = b"MZ...resource section...".to_vec();
    bytes.extend_from_slice(&0xFEEF_04BDu32.to_le_bytes());
    bytes.extend_from_slice(&0x0001_0000u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes()); // file version, high
    bytes.extend_from_slice(&0u32.to_le_bytes()); // file version, low
    bytes.extend_from_slice(&((u32::from(major) << 16) | u32::from(minor)).to_le_bytes());
    bytes.extend_from_slice(&(u32::from(patch) << 16).to_le_bytes());
    bytes.extend_from_slice(b"...appended installer payload...");
    bytes
}

#[test]
fn a_newer_signed_update_is_ready_to_install() {
    let dir = staging_dir();
    let staged = stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    assert_eq!(
        ready_with(&dir, &current(), Package::Installer, &signature_only),
        Some(staged.clone())
    );
    assert_eq!(std::fs::read(&staged.installer).unwrap(), ARTIFACT);
    discard(&dir);
}

#[test]
fn the_release_checks_refuse_an_installer_without_a_version() {
    let dir = staging_dir();
    stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    assert_eq!(
        ready_to_install(&dir, &current(), PUBKEY, Package::Installer),
        None
    );
    assert!(!dir.exists());
}

#[test]
fn the_embedded_version_must_be_the_announced_one_and_newer() {
    assert_eq!(embedded_version(&with_version(0, 2, 3)), Some((0, 2, 3)));
    assert_eq!(embedded_version(ARTIFACT), None);
    assert_eq!(embedded_version(&with_version(0, 0, 0)), None);

    let installer = with_version(0, 2, 0);
    assert!(check_embedded_version(&installer, "0.2.0", &current()).is_ok());
    // An old signed installer announced as a newer release.
    assert!(check_embedded_version(&installer, "0.9.0", &current()).is_err());
    // A genuine installer that is not newer than this build.
    assert!(check_embedded_version(&installer, "0.2.0", &semver::Version::new(0, 2, 0)).is_err());
}

#[test]
fn an_update_that_is_not_newer_is_cleared_away() {
    let dir = staging_dir();
    stage(&dir, "0.1.1", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    assert_eq!(
        ready_with(&dir, &current(), Package::Installer, &signature_only),
        None
    );
    assert!(!dir.exists());
}

#[test]
fn a_tampered_installer_is_cleared_away() {
    let dir = staging_dir();
    let staged = stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    std::fs::write(&staged.installer, b"not the signed bytes").unwrap();
    assert_eq!(
        ready_with(&dir, &current(), Package::Installer, &signature_only),
        None
    );
    assert!(!dir.exists());
}

#[test]
fn a_manifest_may_name_only_the_installer_for_its_version() {
    for installer in [
        r"..\evil.exe",
        r"C:\Windows\System32\cmd.exe",
        "FTPeach-0.3.0-setup.exe",
        "sub/FTPeach-0.2.0-setup.exe",
    ] {
        let dir = staging_dir();
        stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
        let mut manifest = read_manifest(&dir).unwrap().unwrap();
        manifest.installer = installer.into();
        write_manifest(&dir, &manifest).unwrap();
        assert!(
            install_with(
                &dir,
                &current(),
                Package::Installer,
                &signature_only,
                &never_launch
            )
            .is_err(),
            "{installer}"
        );
        assert_eq!(
            ready_with(&dir, &current(), Package::Installer, &signature_only),
            None,
            "{installer}"
        );
    }
}

#[test]
fn an_oversized_manifest_is_refused_before_parsing() {
    let dir = staging_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(MANIFEST),
        vec![b' '; MAX_MANIFEST_BYTES as usize + 1],
    )
    .unwrap();
    assert!(read_manifest(&dir).is_err());
    discard(&dir);
}

#[cfg(windows)]
#[test]
fn nothing_can_swap_the_installer_or_its_folders_while_it_starts() {
    let dir = staging_dir();
    let staged = stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    let parent = dir.parent().unwrap().to_path_buf();
    let launched = std::cell::Cell::new(false);
    let version = install_with(
        &dir,
        &current(),
        Package::Installer,
        &signature_only,
        &|path| {
            assert_eq!(path, staged.installer);
            assert!(std::fs::write(path, b"replacement").is_err());
            assert!(std::fs::rename(path, dir.join("moved.exe")).is_err());
            assert!(std::fs::remove_file(path).is_err());
            assert!(std::fs::rename(&dir, parent.join("moved")).is_err());
            assert!(std::fs::rename(&parent, parent.with_extension("moved")).is_err());
            launched.set(true);
            Ok(())
        },
    )
    .unwrap();
    assert!(launched.get());
    assert_eq!(version, "0.2.0");
    assert_eq!(std::fs::read(&staged.installer).unwrap(), ARTIFACT);
    // The attempt was recorded before the start, so it is not retried.
    assert_eq!(
        ready_with(&dir, &current(), Package::Installer, &signature_only),
        None
    );
    let _ = std::fs::remove_dir_all(parent);
}

#[cfg(windows)]
#[test]
fn a_pinned_installer_still_starts() {
    let dir = staging_dir();
    let program = std::fs::read(r"C:\Windows\System32\where.exe").unwrap();
    stage(&dir, "0.2.0", "unused", &program, Package::Installer).unwrap();
    install_with(
        &dir,
        &current(),
        Package::Installer,
        &|_, _| Ok(()),
        &|path| {
            std::process::Command::new(path)
                .arg("/?")
                .stdout(std::process::Stdio::null())
                .spawn()?
                .wait()
                .map(drop)
        },
    )
    .unwrap();
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}

#[cfg(windows)]
#[test]
fn a_linked_installer_is_refused() {
    let dir = staging_dir();
    stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    let installer = dir.join(Package::Installer.file_name("0.2.0"));
    let target = dir.parent().unwrap().join("elsewhere.exe");
    std::fs::rename(&installer, &target).unwrap();
    if let Err(error) = std::os::windows::fs::symlink_file(&target, &installer) {
        if error.raw_os_error() == Some(1314) {
            eprintln!("skipping: Windows symlink privilege is unavailable");
            let _ = std::fs::remove_dir_all(dir.parent().unwrap());
            return;
        }
        panic!("creating test symlink failed: {error}");
    }
    assert!(
        install_with(
            &dir,
            &current(),
            Package::Installer,
            &signature_only,
            &never_launch
        )
        .is_err()
    );
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}

#[test]
fn an_install_that_did_not_complete_is_not_retried() {
    let dir = staging_dir();
    stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    // The launch fails -- but only after the attempt was recorded, as a
    // failed install would be.
    assert!(
        install_with(
            &dir,
            &current(),
            Package::Installer,
            &signature_only,
            &|_| Err(std::io::Error::other("not an executable"))
        )
        .is_err()
    );
    assert_eq!(
        ready_with(&dir, &current(), Package::Installer, &signature_only),
        None
    );
    assert!(!dir.exists());
}

#[test]
fn leftovers_without_a_manifest_are_cleared_away() {
    let dir = staging_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("FTPeach-0.2.0-setup.exe"), ARTIFACT).unwrap();
    assert_eq!(
        ready_with(&dir, &current(), Package::Installer, &signature_only),
        None
    );
    assert!(!dir.exists());
}

#[test]
fn a_version_that_is_not_semver_never_reaches_a_file_name() {
    let dir = staging_dir();
    assert!(stage(&dir, r"..\..\evil", SIGNATURE, ARTIFACT, Package::Installer).is_err());
    assert!(!dir.exists());
}

/// The portable zip as a release would build it, plus whatever `extra` names.
fn portable_zip(version: (u16, u16, u16), extra: &[&str]) -> Vec<u8> {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let (major, minor, patch) = version;
    zip.start_file(PORTABLE_EXE, options).unwrap();
    zip.write_all(&with_version(major, minor, patch)).unwrap();
    zip.start_file("FTPeach.portable", options).unwrap();
    for name in ["licenses/NOTICE.txt"].iter().chain(extra) {
        zip.start_file(*name, options).unwrap();
        zip.write_all(b"from the update").unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// A portable copy on disk: the program, a saved setting, and the folder a
/// downloaded update waits in.
fn portable_copy() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("ftpeach-portable-{}", uuid::Uuid::new_v4()));
    let dir = root.join("data").join("local").join("updates");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(root.join("data").join("settings.json"), b"kept").unwrap();
    let exe = root.join(PORTABLE_EXE);
    std::fs::write(&exe, b"the running program").unwrap();
    (root, dir, exe)
}

/// The zip's own checks without the signature, which the fixture key cannot
/// give a zip built here.
fn zip_checks(bytes: &[u8], manifest: &Manifest) -> anyhow::Result<()> {
    check_portable_zip(bytes, &manifest.version, &current())
}

fn install_zip(dir: &Path, exe: &Path, start: &dyn Fn(&Path) -> std::io::Result<()>) -> bool {
    install_with(dir, &current(), Package::PortableZip, &zip_checks, &|zip| {
        replace_program(zip, &dir.join("new"), exe, start)
    })
    .is_ok()
}

#[test]
fn a_portable_update_replaces_the_program_and_leaves_the_data() {
    let (root, dir, exe) = portable_copy();
    let package = Package::PortableZip;
    stage(
        &dir,
        "0.2.0",
        "unused",
        &portable_zip((0, 2, 0), &[]),
        package,
    )
    .unwrap();
    let started = std::cell::Cell::new(false);
    assert!(install_zip(&dir, &exe, &|program| {
        assert_eq!(program, exe);
        started.set(true);
        Ok(())
    }));
    assert!(started.get());
    assert_eq!(std::fs::read(&exe).unwrap(), with_version(0, 2, 0));
    assert_eq!(
        std::fs::read(root.join("licenses").join("NOTICE.txt")).unwrap(),
        b"from the update"
    );
    assert!(root.join("FTPeach.portable").exists());
    assert_eq!(
        std::fs::read(root.join("data").join("settings.json")).unwrap(),
        b"kept"
    );
    // The program that was running stays until the next start removes it.
    let replaced = replaced_name(&exe);
    assert_eq!(std::fs::read(&replaced).unwrap(), b"the running program");
    remove_replaced(&exe);
    assert!(!replaced.exists());
    // It was attempted, so the next start clears it away instead of repeating it.
    assert_eq!(ready_with(&dir, &current(), package, &zip_checks), None);
    assert!(!dir.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_portable_update_that_fails_its_checks_changes_nothing() {
    let escaping = portable_zip((0, 2, 0), &["../outside.txt"]);
    let into_data = portable_zip((0, 2, 0), &["data/settings.json"]);
    let older_program = portable_zip((0, 1, 0), &[]);
    let not_newer = portable_zip((0, 1, 1), &[]);
    for (name, version, zip) in [
        ("a name outside the folder", "0.2.0", &escaping),
        ("a file in the data folder", "0.2.0", &into_data),
        ("an older program than announced", "0.2.0", &older_program),
        ("a program that is not newer", "0.1.1", &not_newer),
        ("not a zip at all", "0.2.0", &ARTIFACT.to_vec()),
    ] {
        let (root, dir, exe) = portable_copy();
        if stage(&dir, version, "unused", zip, Package::PortableZip).is_ok() {
            assert!(!install_zip(&dir, &exe, &never_launch), "{name}");
        }
        assert_eq!(
            std::fs::read(&exe).unwrap(),
            b"the running program",
            "{name}"
        );
        assert_eq!(
            std::fs::read(root.join("data").join("settings.json")).unwrap(),
            b"kept",
            "{name}"
        );
        assert!(!root.join("licenses").exists(), "{name}");
        assert!(
            !root.parent().unwrap().join("outside.txt").exists(),
            "{name}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn a_portable_update_is_held_to_the_release_signature() {
    let (root, dir, exe) = portable_copy();
    let package = Package::PortableZip;
    // A well-formed, newer zip carrying a signature made for other bytes.
    stage(
        &dir,
        "0.2.0",
        SIGNATURE,
        &portable_zip((0, 2, 0), &[]),
        package,
    )
    .unwrap();
    assert!(install_portable(&dir, &current(), PUBKEY, &exe, &never_launch).is_err());
    assert_eq!(ready_to_install(&dir, &current(), PUBKEY, package), None);
    assert!(!dir.exists());
    assert_eq!(std::fs::read(&exe).unwrap(), b"the running program");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_new_program_that_does_not_start_gives_way_to_the_old_one() {
    let (root, dir, exe) = portable_copy();
    stage(
        &dir,
        "0.2.0",
        "unused",
        &portable_zip((0, 2, 0), &[]),
        Package::PortableZip,
    )
    .unwrap();
    assert!(!install_zip(&dir, &exe, &|_| Err(std::io::Error::other(
        "not an executable"
    ))));
    assert_eq!(std::fs::read(&exe).unwrap(), b"the running program");
    assert!(!replaced_name(&exe).exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_installed_copy_does_not_take_the_portable_zip_and_the_reverse() {
    let dir = staging_dir();
    stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::PortableZip).unwrap();
    assert_eq!(
        ready_with(&dir, &current(), Package::Installer, &signature_only),
        None
    );
    stage(&dir, "0.2.0", SIGNATURE, ARTIFACT, Package::Installer).unwrap();
    assert_eq!(
        ready_with(&dir, &current(), Package::PortableZip, &signature_only),
        None
    );
}
