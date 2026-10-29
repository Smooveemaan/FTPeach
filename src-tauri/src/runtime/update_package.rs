//! Versions inside signed Unix packages; no package code is run or extracted.

use super::{MAX_UNPACKED_BYTES, Package};
use anyhow::{Context, bail, ensure};
use backhand::compression::{CompressionAction, Compressor, DefaultCompressor};
use std::io::{Cursor, Read};
use std::path::{Component, Path};

// workaround: backhand's optional zstd pins vulnerable releases; use its
// codec hook until it accepts the fixed zstd release.
struct UpdateCompression;
static UPDATE_COMPRESSION: UpdateCompression = UpdateCompression;

impl CompressionAction for UpdateCompression {
    type Error = backhand::BackhandError;
    type Compressor = Compressor;
    type FilesystemCompressor = backhand::FilesystemCompressor;
    type SuperBlock = backhand::SuperBlock;

    fn decompress(
        &self,
        bytes: &[u8],
        out: &mut Vec<u8>,
        compressor: Compressor,
    ) -> Result<(), Self::Error> {
        if compressor == Compressor::Zstd {
            // SquashFS blocks are at most 1 MiB; bound actual decompression.
            let decoded = zstd::bulk::decompress(bytes, 1024 * 1024)
                .map_err(|_| backhand::BackhandError::CorruptedOrInvalidSquashfs)?;
            out.extend_from_slice(&decoded);
            Ok(())
        } else {
            DefaultCompressor.decompress(bytes, out, compressor)
        }
    }

    fn compress(
        &self,
        _: &[u8],
        _: backhand::FilesystemCompressor,
        _: u32,
    ) -> Result<Vec<u8>, Self::Error> {
        Err(backhand::BackhandError::CorruptedOrInvalidSquashfs)
    }
}

const MAX_METADATA_BYTES: u64 = 64 * 1024;
const APPIMAGE_VERSION: &str = "ftpeach-update-version";

/// Requires the signed package's own version to match the offer and advance it.
pub(crate) fn check(
    bytes: &[u8],
    package: Package,
    announced: &str,
    current: &semver::Version,
) -> anyhow::Result<()> {
    let embedded = match package {
        Package::MacApp => mac_version(bytes)?,
        Package::Deb => deb_version(bytes)?,
        Package::AppImage => appimage_version(bytes)?,
        _ => bail!("not a Unix update package"),
    };
    let version = semver::Version::parse(embedded.trim())?;
    ensure!(
        version == semver::Version::parse(announced)?,
        "the package version differs from the announced version"
    );
    ensure!(
        version > *current,
        "the package is not newer than {current}"
    );
    Ok(())
}

fn metadata(reader: impl Read) -> anyhow::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_METADATA_BYTES,
        "update metadata is too large"
    );
    Ok(bytes)
}

fn mac_version(bytes: &[u8]) -> anyhow::Result<String> {
    let mut version = None;
    let mut budget = MAX_UNPACKED_BYTES;
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder.take(MAX_UNPACKED_BYTES + 1));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let mut components = path.components();
        ensure!(
            components.next() == Some(Component::Normal("FTPeach.app".as_ref()))
                && components.all(|component| matches!(component, Component::Normal(_))),
            "the update names a path outside FTPeach.app"
        );
        budget = budget
            .checked_sub(entry.size())
            .context("the update unpacks to more than any FTPeach")?;
        let kind = entry.header().entry_type();
        ensure!(
            kind.is_file() || kind.is_dir() || kind.is_symlink(),
            "unsupported app archive entry"
        );
        if kind.is_symlink() {
            let target = entry.link_name()?.context("missing app link target")?;
            ensure!(
                target
                    .components()
                    .all(|part| matches!(part, Component::Normal(_) | Component::CurDir)),
                "the update contains an unsafe app link"
            );
        }
        if path == Path::new("FTPeach.app/Contents/Info.plist") {
            ensure!(version.is_none() && kind.is_file(), "ambiguous app version");
            let value = plist::Value::from_reader(Cursor::new(metadata(&mut entry)?))?;
            let dict = value.as_dictionary().context("invalid Info.plist")?;
            ensure!(
                dict.get("CFBundleIdentifier")
                    .and_then(plist::Value::as_string)
                    == Some("com.smooveemaan.ftpeach"),
                "the update is not FTPeach"
            );
            version = Some(
                dict.get("CFBundleShortVersionString")
                    .and_then(plist::Value::as_string)
                    .context("missing app version")?
                    .to_owned(),
            );
        }
    }
    version.context("the app carries no version")
}

fn deb_version(bytes: &[u8]) -> anyhow::Result<String> {
    ensure!(bytes.starts_with(b"!<arch>\n"), "not a Debian package");
    let mut rest = &bytes[8..];
    let mut control = None;
    // Tauri builds exactly these three members, with gzip-compressed tar files.
    for expected in ["debian-binary", "control.tar.gz", "data.tar.gz"] {
        let header = rest.get(..60).context("truncated Debian header")?;
        ensure!(&header[58..] == b"`\n", "invalid Debian header");
        let name = std::str::from_utf8(&header[..16])?
            .trim()
            .trim_end_matches('/');
        ensure!(name == expected, "unexpected Debian member");
        let size: usize = std::str::from_utf8(&header[48..58])?.trim().parse()?;
        let end = 60usize
            .checked_add(size)
            .context("Debian member size overflow")?;
        let contents = rest.get(60..end).context("truncated Debian member")?;
        if expected == "debian-binary" {
            ensure!(contents == b"2.0\n", "unsupported Debian format");
        } else if expected == "control.tar.gz" {
            control = Some(contents);
        }
        let padded_end = end
            .checked_add(size % 2)
            .context("Debian padding overflow")?;
        rest = rest.get(padded_end..).context("missing Debian padding")?;
    }
    ensure!(rest.is_empty(), "unexpected extra Debian members");
    let decoder = flate2::read::GzDecoder::new(control.context("missing Debian control archive")?);
    let mut archive = tar::Archive::new(decoder.take(MAX_METADATA_BYTES + 1));
    let mut version = None;
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()? == Path::new("control") || entry.path()? == Path::new("./control") {
            ensure!(
                version.is_none() && entry.header().entry_type().is_file(),
                "ambiguous Debian version"
            );
            let text = String::from_utf8(metadata(&mut entry)?)?;
            ensure!(
                field(&text, "Package")? == "ftpeach",
                "the update is not FTPeach"
            );
            version = Some(field(&text, "Version")?.to_owned());
        }
    }
    version.context("the Debian package carries no version")
}

fn field<'a>(text: &'a str, name: &str) -> anyhow::Result<&'a str> {
    let mut values = text.lines().filter_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then_some(value.trim())
    });
    let value = values.next().context("missing Debian control field")?;
    ensure!(values.next().is_none(), "duplicate Debian control field");
    Ok(value)
}

fn appimage_version(bytes: &[u8]) -> anyhow::Result<String> {
    let offset = appimage_offset(bytes)?;
    let fs = backhand::FilesystemReader::from_reader_with_offset_and_kind(
        Cursor::new(bytes),
        offset as u64,
        backhand::kind::Kind::new_v4(&UPDATE_COMPRESSION),
    )?;
    let mut versions = fs.files().filter(|node| {
        node.fullpath
            .file_name()
            .is_some_and(|name| name == APPIMAGE_VERSION)
    });
    let node = versions
        .next()
        .context("the AppImage carries no version file")?;
    ensure!(versions.next().is_none(), "ambiguous AppImage version");
    let backhand::InnerNode::File(file) = &node.inner else {
        bail!("the AppImage version is not a regular file");
    };
    Ok(String::from_utf8(metadata(fs.file(file).reader())?)?)
}

fn appimage_offset(bytes: &[u8]) -> anyhow::Result<usize> {
    ensure!(
        bytes.get(..7) == Some(b"\x7fELF\x02\x01\x01") && bytes.get(8..11) == Some(b"AI\x02"),
        "not a type-2 ELF64 AppImage"
    );
    let word = |at: usize, len: usize| -> anyhow::Result<usize> {
        let raw = bytes
            .get(at..at.checked_add(len).context("ELF offset overflow")?)
            .context("truncated ELF header")?;
        let mut number = [0u8; 8];
        number[..len].copy_from_slice(raw);
        Ok(usize::try_from(u64::from_le_bytes(number))?)
    };
    let (table, count) = (word(40, 8)?, word(60, 2)?);
    ensure!(
        word(58, 2)? == 64 && (1..=4096).contains(&count),
        "invalid ELF section table"
    );
    let mut end = table
        .checked_add(count * 64)
        .context("ELF section overflow")?;
    ensure!(end <= bytes.len(), "truncated ELF sections");
    for index in 0..count {
        let section = table + index * 64;
        // SHT_NOBITS occupies memory, not bytes in the ELF file.
        if word(section + 4, 4)? != 8 {
            end = end.max(
                word(section + 24, 8)?
                    .checked_add(word(section + 32, 8)?)
                    .context("ELF section size overflow")?,
            );
        }
    }
    ensure!(
        bytes.get(end..end.checked_add(4).context("AppImage offset overflow")?) == Some(b"hsqs"),
        "the AppImage has no SquashFS at the end of its runtime"
    );
    Ok(end)
}

#[cfg(test)]
#[path = "update_package_tests.rs"]
mod tests;
