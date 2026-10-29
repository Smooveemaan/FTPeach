use super::*;
use std::io::Write;

fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    for (name, contents) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, name, *contents).unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap()
}

fn mac(version: &str) -> Vec<u8> {
    let text = format!(
        r#"<?xml version="1.0"?><plist version="1.0"><dict>
        <key>CFBundleIdentifier</key><string>com.smooveemaan.ftpeach</string>
        <key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"#
    );
    tar_gz(&[("FTPeach.app/Contents/Info.plist", text.as_bytes())])
}

fn deb(control: &str) -> Vec<u8> {
    let compressed = tar_gz(&[("./control", control.as_bytes())]);
    let mut bytes = b"!<arch>\n".to_vec();
    for (name, content) in [
        ("debian-binary", b"2.0\n".as_slice()),
        ("control.tar.gz", compressed.as_slice()),
        ("data.tar.gz", b"unused".as_slice()),
    ] {
        writeln!(
            bytes,
            "{name:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`",
            0,
            0,
            0,
            "100644",
            content.len()
        )
        .unwrap();
        bytes.extend_from_slice(content);
        if content.len() % 2 != 0 {
            bytes.push(b'\n');
        }
    }
    bytes
}

fn appimage(version: &str, symlink: bool) -> Vec<u8> {
    use backhand::{FilesystemCompressor, FilesystemWriter, NodeHeader, compression::Compressor};
    let mut fs = FilesystemWriter::default();
    fs.set_compressor(FilesystemCompressor::new(Compressor::Gzip, None).unwrap());
    let header = NodeHeader::default();
    fs.push_dir_all("usr/lib/ftpeach", header).unwrap();
    let path = "usr/lib/ftpeach/ftpeach-update-version";
    if symlink {
        fs.push_symlink("other", path, header).unwrap();
    } else {
        fs.push_file(Cursor::new(version.as_bytes()), path, header)
            .unwrap();
    }
    let mut squashfs = Cursor::new(Vec::new());
    fs.write(&mut squashfs).unwrap();
    let mut bytes = vec![0u8; 128];
    bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    bytes[8..11].copy_from_slice(b"AI\x02");
    bytes[40..48].copy_from_slice(&64u64.to_le_bytes());
    bytes[58..60].copy_from_slice(&64u16.to_le_bytes());
    bytes[60..62].copy_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(squashfs.get_ref());
    bytes
}

#[test]
fn all_unix_formats_bind_the_signed_version_and_refuse_rollback() {
    for (package, bytes) in [
        (Package::MacApp, mac("0.2.0")),
        (Package::Deb, deb("Package: ftpeach\nVersion: 0.2.0\n")),
        (Package::AppImage, appimage("0.2.0", false)),
    ] {
        assert!(
            check(&bytes, package, "0.2.0", &semver::Version::new(0, 1, 0)).is_ok(),
            "{package:?}"
        );
        assert!(
            check(&bytes, package, "0.9.0", &semver::Version::new(0, 1, 0)).is_err(),
            "{package:?}"
        );
        assert!(
            check(&bytes, package, "0.2.0", &semver::Version::new(0, 2, 0)).is_err(),
            "{package:?}"
        );
        assert!(
            check(&bytes, package, "0.2.0", &semver::Version::new(0, 3, 0)).is_err(),
            "{package:?}"
        );
    }
}

#[test]
fn unix_versions_include_prerelease_and_build_metadata() {
    let version = "0.2.0-beta.1+build.42";
    assert!(
        check(
            &mac(version),
            Package::MacApp,
            version,
            &semver::Version::new(0, 1, 0)
        )
        .is_ok()
    );
    assert!(
        check(
            &mac(version),
            Package::MacApp,
            "0.2.0",
            &semver::Version::new(0, 1, 0)
        )
        .is_err()
    );
}

#[test]
fn missing_or_ambiguous_metadata_is_refused() {
    assert!(mac_version(&tar_gz(&[("FTPeach.app/Contents/other", b"0.2.0")])).is_err());
    assert!(
        mac_version(&tar_gz(&[(
            "FTPeach.app/Contents/Info.plist",
            b"bad plist"
        )]))
        .is_err()
    );
    for control in [
        "Package: other\nVersion: 0.2.0\n",
        "Package: ftpeach\n",
        "Package: ftpeach\nVersion: 0.2.0\nVersion: 0.9.0\n",
    ] {
        assert!(deb_version(&deb(control)).is_err(), "{control}");
    }
    assert!(appimage_version(&appimage("0.2.0", true)).is_err());
    assert!(appimage_version(b"not an AppImage").is_err());
}

#[test]
fn package_metadata_and_elf_offsets_are_bounded() {
    assert!(metadata(Cursor::new(vec![0; MAX_METADATA_BYTES as usize + 1])).is_err());
    let mut bytes = appimage("0.2.0", false);
    bytes[40..48].copy_from_slice(&u64::MAX.to_le_bytes());
    assert!(appimage_version(&bytes).is_err());
    assert!(deb_version(b"!<arch>\ntruncated").is_err());
    let valid = deb("Package: ftpeach\nVersion: 0.2.0\n");
    for length in [0, 8, 60, valid.len() - 1] {
        assert!(deb_version(&valid[..length]).is_err());
    }
}

#[test]
fn mac_archive_rejects_other_apps_duplicate_versions_and_escaping_links() {
    assert!(mac_version(&tar_gz(&[("Other.app/Contents/Info.plist", b"anything")])).is_err());
    let valid = mac("0.2.0");
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(valid.as_slice()));
    let mut plist = Vec::new();
    archive
        .entries()
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .read_to_end(&mut plist)
        .unwrap();
    let path = "FTPeach.app/Contents/Info.plist";
    assert!(mac_version(&tar_gz(&[(path, &plist), (path, &plist)])).is_err());
    assert!(
        mac_version(&tar_gz(&[(
            path,
            &vec![b'a'; MAX_METADATA_BYTES as usize + 1]
        )]))
        .is_err()
    );
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    header.set_link_name("/tmp/outside-ftpeach").unwrap();
    header.set_cksum();
    archive
        .append_data(&mut header, "FTPeach.app/Contents/escape", b"".as_slice())
        .unwrap();
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    assert!(mac_version(&bytes).is_err());
}
