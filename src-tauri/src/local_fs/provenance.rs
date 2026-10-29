//! Download provenance: Windows' Mark of the Web and macOS quarantine.
//! Marks are best effort on filesystems that support their metadata; Linux
//! has no corresponding mark here.

use std::path::Path;

/// Which Windows security zone a file came from.
///
/// Only the two that matter for a file arriving over a network connection.
/// The numbers are Windows'.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    /// A server on the local network, reached by a name or address that
    /// cannot be routed off it.
    Intranet = 1,
    /// Anything else, which is the safe assumption.
    Internet = 3,
}

/// Where a downloaded file came from, as the mark records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub zone: Zone,
    /// The address, for a person reading the file's properties. It carries
    /// the scheme, the host and the path, and never a user name, a password
    /// or a query string: this ends up in a file attribute that any program
    /// on the machine can read, and it survives being copied elsewhere.
    pub host_url: String,
}

impl Origin {
    /// Classifies a server by the address the connection names.
    ///
    /// `base` is a scheme and a host, never an account: FTP and SFTP build
    /// it from the configured host, and a WebDAV address has carried no
    /// userinfo or query string since it stopped being allowed to.
    pub fn for_url(base: &str, remote_path: &str) -> Self {
        let url = base;
        let host = reqwest::Url::parse(url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_default();
        Self {
            zone: zone_for_host(&host),
            host_url: format!(
                "{}{}{}",
                url.trim_end_matches('/'),
                if remote_path.starts_with('/') {
                    ""
                } else {
                    "/"
                },
                remote_path
            ),
        }
    }

    /// The mark itself, as both the alternate data stream and the
    /// `ZoneIdentifier` clipboard format spell it.
    #[cfg(any(windows, test))]
    pub fn zone_identifier(&self) -> String {
        // A URL cannot contain a newline once parsed, but the value arrives
        // from a server-side path, so the line is ended rather than trusted.
        let host_url: String = self
            .host_url
            .chars()
            .filter(|character| !character.is_control())
            .take(2048)
            .collect();
        format!(
            "[ZoneTransfer]\r\nZoneId={}\r\nHostUrl={host_url}\r\n",
            self.zone as u8
        )
    }
}

/// A host nothing outside this network can reach is the intranet; anything
/// else, including a name this cannot resolve on its own, is the internet.
fn zone_for_host(host: &str) -> Zone {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return Zone::Internet;
    }
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        return match address {
            std::net::IpAddr::V4(v4) => {
                if v4.is_loopback() || v4.is_private() || v4.is_link_local() {
                    Zone::Intranet
                } else {
                    Zone::Internet
                }
            }
            // Unique local addresses are fc00::/7; the constructor for that
            // check is not stable, so the prefix is read directly.
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || (v6.octets()[0] & 0xfe) == 0xfc || v6.segments()[0] == 0xfe80
                {
                    Zone::Intranet
                } else {
                    Zone::Internet
                }
            }
        };
    }
    // A single-label name resolves only through the local network's own
    // suffix search, so it cannot name a host on the internet.
    if host.eq_ignore_ascii_case("localhost") || !host.contains('.') {
        Zone::Intranet
    } else {
        Zone::Internet
    }
}

/// Records where `path` came from.
///
/// Best effort by design: the mark is written to the download artifact as
/// soon as it exists, so committing it under its final name carries the
/// stream along and a resumed download keeps the one it already has. A
/// filesystem with nowhere to put it is reported, once, rather than failing
/// the transfer that is otherwise complete.
pub fn mark(path: &Path, origin: &Origin) {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_os_string();
        stream.push(":Zone.Identifier");
        if let Err(error) = std::fs::write(&stream, origin.zone_identifier()) {
            log::debug!(
                "This filesystem does not keep where a download came from: {error}; \
                 the Mark of the Web needs NTFS"
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = origin;
        mark_quarantine(path);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (path, origin);
    }
}

/// Marks downloaded files and folders, including the root of an application bundle.
#[cfg(target_os = "macos")]
pub(crate) fn mark_quarantine(path: &Path) {
    if let Err(error) = quarantine(path) {
        log::debug!("This filesystem could not keep the download quarantine mark: {error}");
    }
}

#[cfg(target_os = "macos")]
fn quarantine(path: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let value = format!("0081;{timestamp:x};FTPeach;");
    // CREATE preserves a resumed artifact's mark; NOFOLLOW never marks a link's target.
    let result = unsafe {
        libc::setxattr(
            path.as_ptr(),
            c"com.apple.quarantine".as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            libc::XATTR_CREATE | libc::XATTR_NOFOLLOW,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EEXIST) {
        return Ok(());
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn quarantine_survives_resume_and_commit_without_changing_contents() {
        use std::os::unix::ffi::OsStrExt;
        let root =
            std::env::temp_dir().join(format!("ftpeach-quarantine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let partial = root.join("download.part");
        std::fs::write(&partial, b"contents").unwrap();
        let read = |path: &Path| {
            let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            let mut value = [0u8; 256];
            let size = unsafe {
                libc::getxattr(
                    path.as_ptr(),
                    c"com.apple.quarantine".as_ptr(),
                    value.as_mut_ptr().cast(),
                    value.len(),
                    0,
                    libc::XATTR_NOFOLLOW,
                )
            };
            assert!(size > 0, "{}", std::io::Error::last_os_error());
            String::from_utf8(value[..size as usize].to_vec()).unwrap()
        };
        let origin = Origin::for_url("sftp://files.example.com", "/report.txt");
        mark_quarantine(&root);
        assert!(read(&root).starts_with("0081;"));
        mark(&partial, &origin);
        let mark_before_resume = read(&partial);
        assert!(mark_before_resume.starts_with("0081;"));
        assert!(mark_before_resume.ends_with(";FTPeach;"));
        quarantine(&partial).unwrap();
        assert_eq!(read(&partial), mark_before_resume);
        let committed = root.join("report.txt");
        std::fs::rename(&partial, &committed).unwrap();
        assert_eq!(read(&committed), mark_before_resume);
        assert_eq!(std::fs::read(&committed).unwrap(), b"contents");
        assert!(quarantine(&partial).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_host_that_cannot_be_reached_from_outside_is_the_intranet() {
        for host in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.5",
            "172.16.0.1",
            "169.254.1.1",
            "::1",
            "[fd00::1]",
            "fe80::1",
            "localhost",
            "LOCALHOST",
            "fileserver",
        ] {
            assert_eq!(zone_for_host(host), Zone::Intranet, "{host}");
        }
    }

    #[test]
    fn anything_else_is_the_internet() {
        for host in [
            "example.com",
            "ftp.example.com",
            "8.8.8.8",
            "172.32.0.1",
            "[2001:db8::1]",
            "",
        ] {
            assert_eq!(zone_for_host(host), Zone::Internet, "{host}");
        }
    }

    /// The stream is readable by every program on the machine and travels
    /// with the file, so an account must never reach it.
    #[test]
    fn the_mark_carries_the_address_but_never_an_account() {
        let origin = Origin::for_url("ftps://files.example.com", "/reports/q3.xlsx");
        let contents = origin.zone_identifier();
        assert!(contents.contains("ZoneId=3"));
        assert!(contents.contains("HostUrl=ftps://files.example.com/reports/q3.xlsx"));

        // A WebDAV address is already free of userinfo and query strings by
        // the time a connection exists; this proves the mark follows it.
        let dav = Origin::for_url("https://dav.example.com/remote.php", "/q3.xlsx");
        assert_eq!(dav.zone, Zone::Internet);
        assert_eq!(dav.host_url, "https://dav.example.com/remote.php/q3.xlsx");
        assert!(!dav.zone_identifier().contains('@'));
    }

    #[test]
    fn a_control_character_in_a_remote_path_cannot_forge_another_field() {
        let origin = Origin::for_url("sftp://files.example.com", "/a\r\nZoneId=0\r\nx");
        let contents = origin.zone_identifier();
        // The path is folded onto the HostUrl line, so it can add text but
        // not a line, and only a line of its own would be read as a field.
        let fields: Vec<&str> = contents
            .lines()
            .filter(|line| line.starts_with("ZoneId="))
            .collect();
        assert_eq!(fields, vec!["ZoneId=3"]);
        assert_eq!(contents.lines().count(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn the_mark_lands_beside_the_file_and_survives_being_renamed() {
        let root = std::env::temp_dir().join(format!("ftpeach-motw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let partial = root.join("download.part");
        std::fs::write(&partial, b"contents").unwrap();
        mark(
            &partial,
            &Origin::for_url("ftps://files.example.com", "/q3.xlsx"),
        );

        let read = |path: &Path| {
            let mut stream = path.as_os_str().to_os_string();
            stream.push(":Zone.Identifier");
            std::fs::read_to_string(&stream)
        };
        assert!(read(&partial).unwrap().contains("ZoneId=3"));

        // Committing a download is a rename on the same volume, which is
        // what carries the stream to the final name.
        let committed = root.join("q3.xlsx");
        std::fs::rename(&partial, &committed).unwrap();
        assert!(read(&committed).unwrap().contains("ZoneId=3"));
        assert_eq!(std::fs::read(&committed).unwrap(), b"contents");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
