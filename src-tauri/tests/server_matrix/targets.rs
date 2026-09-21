//! The servers of tests/docker/matrix, as the client sees them: how to connect,
//! where the seeded fixtures are, and what each implementation is known to do
//! differently. Scenarios read the flags instead of special-casing server ids.

use serde_json::{Map, Value, json};
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Ftp,
    Sftp,
    Webdav,
}

#[derive(Clone, Debug)]
pub struct Target {
    pub id: &'static str,
    /// Compose profile, for `FTPEACH_MATRIX`.
    pub profile: &'static str,
    /// One container can serve several targets; tests of one container run
    /// one at a time so connection limits never mix with the scenario.
    pub service: &'static str,
    pub kind: Kind,
    pub config: Map<String, Value>,
    /// Writable directory that holds `fixtures/`.
    pub root: &'static str,
    /// The seed ran for this server (the baseline stack has no fixtures).
    pub fixtures: bool,
    pub dotfiles_visible: bool,
    pub symlinks: bool,
    /// `fixtures/perms` exists and the server process cannot bypass modes.
    pub perms: bool,
    /// The 255-byte fixture name is served.
    pub long_name: bool,
    /// Fixture names the server's file system cannot hold; the seed skips
    /// them and the client is not asked to write them.
    pub unsupported_names: &'static [&'static str],
    /// URL segments the server accepts, a trailing slash counting as one
    /// (IIS `limits.maxUrlSegments`, 32 by default; it answers 404.20).
    pub max_url_segments: Option<usize>,
    /// Directory backed by a 16 MiB tmpfs.
    pub disk_full_dir: Option<&'static str>,
    /// Uploads above this size are refused by the server.
    pub max_upload_bytes: Option<u64>,
    pub resume_upload: bool,
    /// Parallel logins the server accepts from one address.
    pub max_connections: Option<usize>,
    /// Under many parallel logins the server drops some at random, with no
    /// fixed limit.
    pub login_drops: bool,
}

pub fn matrix_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/docker/matrix")
}

pub fn generated(path: &str) -> String {
    matrix_dir()
        .join("generated")
        .join(path)
        .to_string_lossy()
        .into_owned()
}

pub fn big_bytes() -> u64 {
    std::env::var("FTPEACH_MATRIX_BIG_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(64)
        * 1024
        * 1024
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().expect("config is a JSON object").clone()
}

fn ftp(port: u16) -> Map<String, Value> {
    object(json!({
        "protocol": "ftp", "host": "127.0.0.1", "port": port,
        "user": "testuser", "password": "testpass",
    }))
}

fn ftps(port: u16) -> Map<String, Value> {
    // Certificates are issued for localhost by the matrix test CA.
    object(json!({
        "protocol": "ftps", "host": "localhost", "port": port,
        "user": "testuser", "password": "testpass",
        "caCertPath": generated("tls/ca.pem"),
    }))
}

fn sftp(port: u16) -> Map<String, Value> {
    object(json!({
        "protocol": "sftp", "host": "127.0.0.1", "port": port,
        "user": "testuser", "password": "testpass",
    }))
}

fn sftp_key(port: u16, key: &str) -> Map<String, Value> {
    object(json!({
        "protocol": "sftp", "host": "127.0.0.1", "port": port,
        "user": "testuser", "useKeyAuth": true, "keyPath": generated(&format!("keys/{key}")),
    }))
}

fn webdav(url: &str) -> Map<String, Value> {
    object(json!({
        "protocol": "webdav", "webdavUrl": url,
        "user": "testuser", "password": "testpass",
        "caCertPath": generated("tls/ca.pem"),
    }))
}

/// IIS on the Windows host (scripts/test-servers/iis.ps1): its own account,
/// and a self-signed certificate the script exports for caCertPath.
fn iis(mut config: Map<String, Value>) -> Map<String, Value> {
    config.insert("user".into(), "ftpeach_test".into());
    config.insert("password".into(), "FTPeach-test-2026!".into());
    if config.contains_key("caCertPath") {
        config.insert(
            "caCertPath".into(),
            r"C:\ftpeach-test-servers\iis\cert.pem".into(),
        );
    }
    config
}

/// NTFS holds no '"' in a name and no case.txt beside Case.txt.
const WINDOWS_UNSUPPORTED_NAMES: &[&str] = &["quote's and \"double\".txt", "case.txt"];

/// IIS: NTFS permissions instead of modes, no links. All sites share one
/// lock: they run in the same host services, and a 10 000-entry PROPFIND
/// next to the FTP scenarios outlasts the client timeout.
fn iis_target(id: &'static str, kind: Kind, config: Map<String, Value>) -> Target {
    Target {
        symlinks: false,
        unsupported_names: WINDOWS_UNSUPPORTED_NAMES,
        max_url_segments: (kind == Kind::Webdav).then_some(32),
        ..base(id, "iis", "iis", kind, iis(config), "")
    }
}

fn base(
    id: &'static str,
    profile: &'static str,
    service: &'static str,
    kind: Kind,
    config: Map<String, Value>,
    root: &'static str,
) -> Target {
    Target {
        id,
        profile,
        service,
        kind,
        config,
        root,
        fixtures: true,
        dotfiles_visible: true,
        symlinks: true,
        perms: true,
        long_name: true,
        unsupported_names: &[],
        max_url_segments: None,
        disk_full_dir: None,
        max_upload_bytes: None,
        resume_upload: kind != Kind::Webdav,
        max_connections: None,
        login_drops: false,
    }
}

pub fn target(id: &str) -> Target {
    use Kind::*;
    match id {
        // Baseline: the CI stack, without seeded fixtures.
        "baseline_pureftpd" => Target {
            fixtures: false,
            dotfiles_visible: false,
            max_connections: Some(5),
            ..base("baseline_pureftpd", "baseline", "ftp", Ftp, ftp(2131), "")
        },
        "baseline_atmoz" => Target {
            fixtures: false,
            // Stock sshd: MaxStartups 10:30:100 drops logins past ten at random.
            login_drops: true,
            ..base(
                "baseline_atmoz",
                "baseline",
                "sftp",
                Sftp,
                sftp(2222),
                "/upload",
            )
        },
        "baseline_hacdias" => Target {
            fixtures: false,
            ..base(
                "baseline_hacdias",
                "baseline",
                "webdav",
                Webdav,
                webdav("http://127.0.0.1:6065/"),
                "",
            )
        },

        // FTP / FTPS
        "vsftpd" => Target {
            dotfiles_visible: false,
            // max_per_ip
            max_connections: Some(10),
            disk_full_dir: Some("/small"),
            ..base("vsftpd", "ftp", "vsftpd", Ftp, ftps(2141), "")
        },
        "vsftpd_plain" => Target {
            dotfiles_visible: false,
            max_connections: Some(10),
            ..base("vsftpd_plain", "ftp", "vsftpd", Ftp, ftp(2141), "")
        },
        "vsftpd_reuse" => Target {
            dotfiles_visible: false,
            max_connections: Some(10),
            ..base("vsftpd_reuse", "ftp", "vsftpd-reuse", Ftp, ftps(2142), "")
        },
        "vsftpd_nat" => Target {
            dotfiles_visible: false,
            max_connections: Some(10),
            ..base("vsftpd_nat", "ftp", "vsftpd-nat", Ftp, ftp(2143), "")
        },
        "vsftpd_implicit" => base(
            "vsftpd_implicit",
            "ftp",
            "vsftpd-implicit",
            Ftp,
            ftps(2990),
            "",
        ),
        "proftpd" => Target {
            disk_full_dir: Some("/small"),
            max_connections: Some(8),
            ..base("proftpd", "ftp", "proftpd", Ftp, ftps(2151), "")
        },
        "proftpd_tls12" => Target {
            max_connections: Some(8),
            ..base("proftpd_tls12", "ftp", "proftpd-tls12", Ftp, ftps(2152), "")
        },
        "proftpd_tls13" => Target {
            max_connections: Some(8),
            ..base("proftpd_tls13", "ftp", "proftpd-tls13", Ftp, ftps(2153), "")
        },
        "proftpd_badcert_expired" => base(
            "proftpd_badcert_expired",
            "ftp",
            "proftpd-badcert-expired",
            Ftp,
            ftps(2154),
            "",
        ),
        "proftpd_badcert_cn" => base(
            "proftpd_badcert_cn",
            "ftp",
            "proftpd-badcert-cn",
            Ftp,
            ftps(2155),
            "",
        ),
        // pyftpdlib lists a link as what it leads to, so no client can tell.
        "pyftpdlib" => Target {
            symlinks: false,
            ..base("pyftpdlib", "ftp", "pyftpdlib", Ftp, ftp(2161), "")
        },
        // pyftpdlib lists a link as what it leads to, so no client can tell.
        "pyftpdlib_ftps" => Target {
            symlinks: false,
            ..base("pyftpdlib_ftps", "ftp", "pyftpdlib", Ftp, ftps(2161), "")
        },
        "pyftpdlib_epsv_only" => Target {
            symlinks: false,
            ..base(
                "pyftpdlib_epsv_only",
                "ftp",
                "pyftpdlib-epsv-only",
                Ftp,
                ftp(2162),
                "",
            )
        },
        "pyftpdlib_nonutf8" => Target {
            symlinks: false,
            ..base(
                "pyftpdlib_nonutf8",
                "ftp",
                "pyftpdlib-nonutf8",
                Ftp,
                ftp(2163),
                "",
            )
        },
        // SFTPGo will not CWD into a link over FTP, so a link to a folder
        // cannot be told from a link to a file.
        "sftpgo_ftp" => Target {
            symlinks: false,
            ..base("sftpgo_ftp", "ftp", "sftpgo", Ftp, ftps(2171), "")
        },

        // SFTP
        "openssh_keys" => base(
            "openssh_keys",
            "sftp",
            "openssh-keys",
            Sftp,
            sftp_key(2231, "id_ed25519"),
            "/home/testuser",
        ),
        "openssh_kbdint" => base(
            "openssh_kbdint",
            "sftp",
            "openssh-kbdint",
            Sftp,
            sftp(2232),
            "/home/testuser",
        ),
        "openssh_legacy" => base(
            "openssh_legacy",
            "sftp",
            "openssh-legacy",
            Sftp,
            sftp(2233),
            "/home/testuser",
        ),
        "openssh_modern" => base(
            "openssh_modern",
            "sftp",
            "openssh-modern",
            Sftp,
            sftp(2234),
            "/home/testuser",
        ),
        "openssh_chroot" => Target {
            disk_full_dir: Some("/small"),
            ..base(
                "openssh_chroot",
                "sftp",
                "openssh-chroot",
                Sftp,
                sftp(2235),
                "/home",
            )
        },
        "proftpd_sftp" => base("proftpd_sftp", "sftp", "proftpd-sftp", Sftp, sftp(2241), ""),
        "sftpgo_sftp" => base("sftpgo_sftp", "sftp", "sftpgo", Sftp, sftp(2251), ""),
        // Dropbear drops unauthenticated connections above five per address.
        "dropbear" => Target {
            max_connections: Some(5),
            ..base(
                "dropbear",
                "sftp",
                "dropbear",
                Sftp,
                sftp(2261),
                "/home/testuser",
            )
        },

        // WebDAV
        "apache_basic" => Target {
            disk_full_dir: Some("/small"),
            perms: false,
            ..base(
                "apache_basic",
                "webdav",
                "apache-basic",
                Webdav,
                webdav("http://127.0.0.1:18081/"),
                "",
            )
        },
        "apache_digest" => base(
            "apache_digest",
            "webdav",
            "apache-digest",
            Webdav,
            webdav("http://127.0.0.1:18082/"),
            "",
        ),
        "apache_https" => Target {
            perms: false,
            ..base(
                "apache_https",
                "webdav",
                "apache-https",
                Webdav,
                webdav("https://localhost:18443/"),
                "",
            )
        },
        "nginx_davext" => Target {
            dotfiles_visible: false,
            perms: false,
            symlinks: false,
            long_name: false,
            disk_full_dir: Some("/small"),
            max_upload_bytes: Some(8 * 1024 * 1024),
            ..base(
                "nginx_davext",
                "webdav",
                "nginx-davext",
                Webdav,
                webdav("http://127.0.0.1:18091/"),
                "",
            )
        },
        "nginx_norange_h2" => Target {
            dotfiles_visible: false,
            perms: false,
            symlinks: false,
            long_name: false,
            ..base(
                "nginx_norange_h2",
                "webdav",
                "nginx-norange-h2",
                Webdav,
                webdav("https://localhost:18444/"),
                "",
            )
        },
        // nginx dav_ext, as nginx_davext.
        "webdav_subpath" => Target {
            dotfiles_visible: false,
            perms: false,
            symlinks: false,
            long_name: false,
            ..base(
                "webdav_subpath",
                "webdav",
                "webdav-subpath",
                Webdav,
                // The redirect names localhost, so only that host is upgraded
                // to HTTPS without asking.
                webdav("http://localhost:18131/dav/"),
                "",
            )
        },
        "rclone_webdav" => Target {
            perms: false,
            ..base(
                "rclone_webdav",
                "webdav",
                "rclone-webdav",
                Webdav,
                webdav("http://127.0.0.1:18111/"),
                "",
            )
        },
        // SFTPGo lists every link as a file over WebDAV.
        "sftpgo_webdav" => Target {
            perms: false,
            symlinks: false,
            ..base(
                "sftpgo_webdav",
                "webdav",
                "sftpgo",
                Webdav,
                webdav("http://127.0.0.1:18121/"),
                "",
            )
        },
        "nextcloud" => Target {
            symlinks: false,
            perms: false,
            long_name: false,
            ..base(
                "nextcloud",
                "heavy",
                "nextcloud",
                Webdav,
                webdav("http://127.0.0.1:18101/remote.php/dav/files/testuser/"),
                "",
            )
        },

        // IIS (Windows host, profile iis)
        "iis_ftp" => iis_target("iis_ftp", Ftp, ftp(2121)),
        "iis_ftps" => iis_target("iis_ftps", Ftp, ftps(2121)),
        "iis_ftp_unix" => iis_target("iis_ftp_unix", Ftp, ftp(2122)),
        "iis_webdav" => iis_target("iis_webdav", Webdav, webdav("http://127.0.0.1:18180/")),
        other => panic!("unknown matrix target {other}"),
    }
}
