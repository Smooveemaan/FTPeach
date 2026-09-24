//! What only one server (or one proxy) can show.

use crate::support::*;
use crate::targets::{Kind, Target, generated};
use app_lib::ErrorCode;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

macro_rules! specific {
    ($name:ident, $target:literal, $body:path) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore = "requires the server matrix: npm run servers:up, then servers:test"]
        async fn $name() {
            run($target, |target| Box::pin($body(target))).await;
        }
    };
}

async fn expect_refusal(target: &Target, config: &serde_json::Map<String, Value>) -> ErrorCode {
    let started = Instant::now();
    let error = try_connect_with(target, config)
        .await
        .err()
        .unwrap_or_else(|| panic!("{}: connection unexpectedly succeeded", target.id));
    let code = code(&error);
    println!(
        "{}: refused in {:?} as {code:?}: {error:#}",
        target.id,
        started.elapsed()
    );
    code
}

// FTP / FTPS

specific!(vsftpd_implicit_fails_fast, "vsftpd_implicit", implicit_ftps);
async fn implicit_ftps(target: Target) {
    let mut config = target.config.clone();
    config.insert("timeout".into(), 10_000.into());
    let started = Instant::now();
    let code = expect_refusal(&target, &config).await;
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{}: implicit FTPS took {:?} to fail ({code:?})",
        target.id,
        started.elapsed()
    );
    assert_ne!(code, ErrorCode::TimedOut, "{}", target.id);
}

specific!(vsftpd_untrusted_ca_rejected, "vsftpd", untrusted_ftps);
async fn untrusted_ftps(target: Target) {
    let mut config = target.config.clone();
    config.remove("caCertPath");
    assert_eq!(
        expect_refusal(&target, &config).await,
        ErrorCode::InvalidCertificate
    );
    config.insert("allowInvalidCert".into(), true.into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .expect("allowInvalidCert");
    backend.list("/").await.expect("list");
}

specific!(
    proftpd_badcert_expired_rejected_then_allowed,
    "proftpd_badcert_expired",
    bad_cert
);
specific!(
    proftpd_badcert_cn_rejected_then_allowed,
    "proftpd_badcert_cn",
    bad_cert
);
async fn bad_cert(target: Target) {
    assert_eq!(
        expect_refusal(&target, &target.config).await,
        ErrorCode::InvalidCertificate
    );
    let mut config = target.config.clone();
    config.insert("allowInvalidCert".into(), true.into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .unwrap_or_else(|error| panic!("{}: allowInvalidCert: {error:#}", target.id));
    backend
        .list(&fixtures(&target, "sizes"))
        .await
        .expect("list");
}

specific!(proftpd_anonymous_read_only, "proftpd", proftpd_anonymous);
async fn proftpd_anonymous(target: Target) {
    let mut config = target.config.clone();
    config.insert("user".into(), "".into());
    config.insert("password".into(), "".into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .unwrap_or_else(|error| panic!("anonymous login [{:?}]: {error:#}", code(&error)));
    let listed = backend.list("/").await.expect("anonymous list");
    println!("anonymous root: {:?}", names(&listed));
    let local = std::env::temp_dir().join(format!("ftpeach-matrix-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&local, b"x").await.unwrap();
    let error = backend
        .upload(&local, "/anonymous-upload.txt", false, noop_progress())
        .await
        .expect_err("anonymous upload must be refused");
    let _ = tokio::fs::remove_file(&local).await;
    assert_eq!(code(&error), ErrorCode::PermissionDenied, "{error:#}");
}

specific!(proftpd_readonly_user, "proftpd", proftpd_readonly);
async fn proftpd_readonly(target: Target) {
    let mut config = target.config.clone();
    config.insert("user".into(), "readonly".into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .expect("readonly login");
    let listed = backend.list("/").await.expect("readonly list");
    println!("readonly root: {:?}", names(&listed));
    let error = backend
        .mkdir("/readonly-mkdir")
        .await
        .expect_err("readonly mkdir must be refused");
    assert_eq!(code(&error), ErrorCode::PermissionDenied, "{error:#}");
}

specific!(
    pyftpdlib_nonutf8_cp1251_names,
    "pyftpdlib_nonutf8",
    cp1251_names
);
async fn cp1251_names(target: Target) {
    let mut config = target.config.clone();
    config.insert("encoding".into(), "windows-1251".into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .unwrap_or_else(|error| panic!("connect [{:?}]: {error:#}", code(&error)));
    let dir = fixtures(&target, "encoding");
    let listed = backend
        .list(&dir)
        .await
        .unwrap_or_else(|error| panic!("list cp1251 names [{:?}]: {error:#}", code(&error)));
    println!("cp1251 names as listed: {:?}", names(&listed));
    assert_eq!(listed.len(), 2, "{:?}", names(&listed));
    let expected = [
        "\u{41e}\u{442}\u{447}\u{435}\u{442}.txt",
        "\u{414}\u{430}\u{43d}\u{43d}\u{44b}\u{435} 2026.txt",
    ];
    let mut failures = Vec::new();
    for name in expected {
        if find(&listed, name).is_none() {
            failures.push(format!("{name:?} not listed readably"));
        }
    }
    for entry in &listed {
        let mut bytes = Vec::new();
        if let Err(error) = backend
            .download_to_writer(&join(&dir, &entry.name), &mut bytes)
            .await
        {
            failures.push(format!(
                "download {:?} [{:?}]: {error:#}",
                entry.name,
                code(&error)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));

    // New names go out in the same encoding.
    let work = Work::new(&target, &mut backend).await;
    let folder = work.path("\u{41f}\u{430}\u{43f}\u{43a}\u{430}");
    backend.mkdir(&folder).await.expect("mkdir cp1251 folder");
    let file = join(&folder, "\u{424}\u{430}\u{439}\u{43b}.txt");
    put(&mut backend, &work.local("upload.txt"), &file, b"cp1251").await;
    let renamed = join(&folder, "\u{418}\u{442}\u{43e}\u{433}.txt");
    backend
        .rename(&file, &renamed)
        .await
        .expect("rename cp1251 file");
    let listed = backend.list(&folder).await.expect("list cp1251 folder");
    assert_eq!(names(&listed), ["\u{418}\u{442}\u{43e}\u{433}.txt"]);
    assert_eq!(get(&mut backend, &renamed).await, b"cp1251");
    // A name windows-1251 has no letters for is refused before it is sent.
    let error = backend
        .mkdir(&work.path("\u{65e5}\u{672c}"))
        .await
        .expect_err("a name outside windows-1251");
    assert_eq!(code(&error), ErrorCode::InvalidInput, "{error:#}");
    work.finish(&mut backend).await;
}

specific!(proftpd_cp1251_iac_names, "proftpd", cp1251_iac_names);
specific!(iis_ftp_cp1251_iac_names, "iis_ftp", cp1251_iac_names);
specific!(vsftpd_cp1251_iac_names, "vsftpd", cp1251_iac_names);
specific!(
    pureftpd_cp1251_iac_names,
    "baseline_pureftpd",
    cp1251_iac_names
);
specific!(sftpgo_cp1251_iac_names, "sftpgo_ftp", cp1251_iac_names);
/// windows-1251 writes its last letter as 0xFF, the Telnet IAC. ProFTPD and
/// IIS read Telnet and need it doubled; the others take it as it is, and
/// vsftpd doubles it in replies.
async fn cp1251_iac_names(target: Target) {
    let mut config = target.config.clone();
    config.insert("encoding".into(), "windows-1251".into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .unwrap_or_else(|error| panic!("connect [{:?}]: {error:#}", code(&error)));
    let work = Work::new(&target, &mut backend).await;
    // "Family", then 0xFF right before 0xFE, which reads as Telnet DONT.
    let folder = work.path("\u{421}\u{435}\u{43c}\u{44c}\u{44f}");
    let file = join(&folder, "\u{44f}\u{44e}.txt");
    // Only reachable by walking the path, which saves and restores the
    // working directory through PWD.
    let nested = join(
        &folder,
        "\u{41c}\u{43e}\u{44f}/\u{442}\u{432}\u{43e}\u{44f}",
    );
    backend.mkdir(&folder).await.expect("mkdir");
    put(&mut backend, &work.local("upload.txt"), &file, b"iac").await;
    backend.mkdir(&nested).await.expect("mkdir nested");
    let renamed = join(&nested, "\u{44f}\u{44f}.txt");
    backend.rename(&file, &renamed).await.expect("rename");
    let listed = backend.list(&folder).await.expect("list folder");
    assert_eq!(names(&listed), ["\u{41c}\u{43e}\u{44f}"]);
    let listed = backend.list(&nested).await.expect("list nested");
    assert_eq!(names(&listed), ["\u{44f}\u{44f}.txt"]);
    assert_eq!(get(&mut backend, &renamed).await, b"iac");
    work.finish(&mut backend).await;
}

specific!(
    vsftpd_reuse_ftps_with_encoding,
    "vsftpd_reuse",
    ftps_with_encoding
);
specific!(
    proftpd_tls12_ftps_with_encoding,
    "proftpd_tls12",
    ftps_with_encoding
);
/// A site encoding moves TLS into the relay. Data connections still have to
/// resume that session, which vsftpd insists on.
async fn ftps_with_encoding(target: Target) {
    let mut config = target.config.clone();
    config.insert("encoding".into(), "windows-1252".into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .unwrap_or_else(|error| panic!("connect [{:?}]: {error:#}", code(&error)));
    let work = Work::new(&target, &mut backend).await;
    for round in 0..3 {
        let path = work.path(&format!("caf\u{e9}-{round}.txt"));
        put(&mut backend, &work.local("upload.txt"), &path, b"relayed").await;
        assert_eq!(get(&mut backend, &path).await, b"relayed");
    }
    let listed = backend.list(&work.remote).await.expect("list");
    assert_eq!(listed.len(), 3, "{:?}", names(&listed));
    work.finish(&mut backend).await;
}

// SFTP

specific!(openssh_keys_every_key_type, "openssh_keys", every_key_type);
async fn every_key_type(target: Target) {
    let mut failures = Vec::new();
    for (key, passphrase) in [
        ("id_ed25519", None),
        ("id_rsa", None),
        ("id_ecdsa", None),
        ("id_ed25519_passphrase", Some("keypass")),
    ] {
        let mut config = target.config.clone();
        config.insert("keyPath".into(), generated(&format!("keys/{key}")).into());
        if let Some(passphrase) = passphrase {
            config.insert("keyPassphrase".into(), passphrase.into());
        }
        match try_connect_with(&target, &config).await {
            Ok(mut backend) => {
                if let Err(error) = backend.list(target.root).await {
                    failures.push(format!("{key}: list: {error:#}"));
                }
            }
            Err(error) => failures.push(format!("{key} [{:?}]: {error:#}", code(&error))),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

specific!(
    openssh_keys_wrong_passphrase,
    "openssh_keys",
    wrong_passphrase
);
async fn wrong_passphrase(target: Target) {
    let mut config = target.config.clone();
    config.insert(
        "keyPath".into(),
        generated("keys/id_ed25519_passphrase").into(),
    );
    config.insert("keyPassphrase".into(), "wrong".into());
    let code = expect_refusal(&target, &config).await;
    assert_ne!(code, ErrorCode::Internal);
    config.remove("keyPassphrase");
    let code = expect_refusal(&target, &config).await;
    assert_ne!(code, ErrorCode::Internal);
}

specific!(
    openssh_kbdint_password_login,
    "openssh_kbdint",
    kbdint_login
);
async fn kbdint_login(target: Target) {
    let mut backend = try_connect_with(&target, &target.config)
        .await
        .unwrap_or_else(|error| {
            panic!(
                "keyboard-interactive-only server refused the password [{:?}]: {error:#}",
                code(&error)
            )
        });
    backend.list(target.root).await.expect("list");
}

specific!(
    openssh_legacy_connects_or_explains,
    "openssh_legacy",
    legacy_ssh
);
async fn legacy_ssh(target: Target) {
    match try_connect_with(&target, &target.config).await {
        Ok(mut backend) => {
            println!("legacy OpenSSH: connected");
            backend.list(target.root).await.expect("list");
        }
        Err(error) => {
            println!("legacy OpenSSH [{:?}]: {error:#}", code(&error));
            assert_eq!(code(&error), ErrorCode::SshNegotiationFailed, "{error:#}");
        }
    }
}

// WebDAV

specific!(apache_digest_refused_clearly, "apache_digest", digest_only);
async fn digest_only(target: Target) {
    assert_eq!(
        expect_refusal(&target, &target.config).await,
        ErrorCode::AuthFailed
    );
}

specific!(
    apache_https_untrusted_ca_rejected,
    "apache_https",
    untrusted_https
);
async fn untrusted_https(target: Target) {
    let mut config = target.config.clone();
    config.remove("caCertPath");
    assert_eq!(
        expect_refusal(&target, &config).await,
        ErrorCode::InvalidCertificate
    );
    config.insert("allowInvalidCert".into(), true.into());
    let mut backend = try_connect_with(&target, &config)
        .await
        .expect("allowInvalidCert");
    backend.list("/").await.expect("list");
}

// The server's own access log shows which protocol the requests came in on.
specific!(nginx_norange_h2_speaks_http2, "nginx_norange_h2", http2);
async fn http2(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    let marker = format!("h2-{}.txt", uuid::Uuid::new_v4().simple());
    put(&mut backend, &work.local("f"), &work.path(&marker), b"h2").await;
    assert_eq!(get(&mut backend, &work.path(&marker)).await, b"h2");
    work.finish(&mut backend).await;

    let container = format!("ftpeach-test-matrix-{}-1", target.service);
    let logs = std::process::Command::new("docker")
        .args(["logs", "--since", "10m", &container])
        .output()
        .unwrap_or_else(|error| panic!("docker logs {container}: {error}"));
    let logs =
        String::from_utf8_lossy(&logs.stdout).into_owned() + &String::from_utf8_lossy(&logs.stderr);
    let requests: Vec<&str> = logs.lines().filter(|line| line.contains(&marker)).collect();
    assert!(
        !requests.is_empty(),
        "{}: no request for {marker} in the access log",
        target.id
    );
    assert!(
        requests.iter().all(|line| line.contains("HTTP/2.0")),
        "{}: requests not over HTTP/2: {requests:#?}",
        target.id
    );
}

/// A resume must not splice an old partial onto a file that changed since:
/// the server's ETag / Last-Modified after an upload has to tell the two
/// apart, even for an overwrite of the same size within the same second.
async fn changed_since_partial(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    let len = target
        .max_upload_bytes
        .map_or(32 << 20, |limit| limit.min(32 << 20)) as usize;
    let first: Vec<u8> = (0..len as u32).map(|i| (i % 251) as u8).collect();
    let second: Vec<u8> = first.iter().map(|byte| !byte).collect();
    let remote = work.path("changing.bin");
    put(&mut backend, &work.local("first"), &remote, &first).await;

    let destination = work.local("download.bin");
    let moved = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let sink = moved.clone();
    let progress: app_lib::protocol::ProgressSink = std::sync::Arc::new(move |info| {
        if let app_lib::protocol::ProgressInfo::Progress { bytes, .. } = info {
            sink.store(bytes, std::sync::atomic::Ordering::SeqCst);
        }
    });
    // Stop the download part way, as closing the app would.
    {
        let download = backend.download(&remote, &destination, false, progress);
        tokio::pin!(download);
        tokio::select! {
            result = &mut download => panic!("{}: download finished before it could be stopped: {:?}", target.id, result.map_err(|error| format!("{error:#}"))),
            () = async {
                while moved.load(std::sync::atomic::Ordering::SeqCst) < 1024 * 1024 {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            } => {}
        }
    }
    // An FTP control connection does not survive a transfer dropped midway.
    let mut backend = connect(&target).await;
    put(&mut backend, &work.local("second"), &remote, &second).await;
    backend
        .download(&remote, &destination, true, noop_progress())
        .await
        .unwrap_or_else(|error| panic!("{}: resume [{:?}]: {error:#}", target.id, code(&error)));
    assert!(
        tokio::fs::read(&destination).await.unwrap() == second,
        "{}: the resumed file mixes the old and the new content",
        target.id
    );
    work.finish(&mut backend).await;
}

specific!(
    apache_basic_resume_after_change,
    "apache_basic",
    changed_since_partial
);
specific!(
    nginx_davext_resume_after_change,
    "nginx_davext",
    changed_since_partial
);
specific!(
    rclone_resume_after_change,
    "rclone_webdav",
    changed_since_partial
);
specific!(
    sftpgo_webdav_resume_after_change,
    "sftpgo_webdav",
    changed_since_partial
);
specific!(
    nextcloud_resume_after_change,
    "nextcloud",
    changed_since_partial
);

// Active mode. The server connects back to the address the client sends in
// PORT/EPRT, so the client has to reach the container directly: on Linux it
// connects to the container's bridge address, which the container can reach
// back. Docker Desktop (Windows, macOS) routes neither way.

async fn active_mode(target: Target) {
    if !cfg!(target_os = "linux") {
        not_run(format_args!(
            "{}: active mode needs the container reachable at its bridge address (Linux Docker only)",
            target.id
        ));
        return;
    }
    let container = format!("ftpeach-test-matrix-{}-1", target.service);
    let inspected = std::process::Command::new("docker")
        .args([
            "inspect",
            "-f",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}|{{range $port, $bound := .NetworkSettings.Ports}}{{range $bound}}{{$port}}={{.HostPort}} {{end}}{{end}}",
            &container,
        ])
        .output()
        .unwrap_or_else(|error| panic!("docker inspect {container}: {error}"));
    let inspected = String::from_utf8_lossy(&inspected.stdout).into_owned();
    let (addresses, ports) = inspected.split_once('|').unwrap_or_default();
    let address = addresses
        .split_whitespace()
        .next()
        .unwrap_or_else(|| panic!("{container} has no bridge address"))
        .to_string();
    // The port inside the container that the target's published port maps to.
    let published = target.config["port"].to_string();
    let port: u16 = ports
        .split_whitespace()
        .find_map(|mapping| {
            let (inside, host) = mapping.split_once('=')?;
            (host == published).then(|| inside.trim_end_matches("/tcp").parse().ok())?
        })
        .unwrap_or_else(|| panic!("{container} does not publish port {published}: {ports}"));
    let mut target = target;
    target.config.insert("host".into(), address.into());
    target.config.insert("port".into(), port.into());
    target.config.insert("activeMode".into(), true.into());
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    put(
        &mut backend,
        &work.local("f"),
        &work.path("active.txt"),
        b"active",
    )
    .await;
    assert_eq!(get(&mut backend, &work.path("active.txt")).await, b"active");
    let listed = backend.list(&work.remote).await.expect("active LIST");
    assert_eq!(names(&listed), ["active.txt"], "{}", target.id);
    work.finish(&mut backend).await;
}

specific!(vsftpd_active_mode, "vsftpd_plain", active_mode);
specific!(pyftpdlib_active_mode, "pyftpdlib", active_mode);

/// A proxy tunnel cannot take the server's connection back, so with a proxy
/// the client stays passive (docs/networking.md), says so in the protocol log,
/// and the transfer still works.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the server matrix: npm run servers:up, then servers:test"]
async fn proxy_socks5_ftp_active_mode_stays_passive() {
    let mut target = through(Kind::Ftp, socks5());
    target.config.insert("activeMode".into(), true.into());
    run_proxied(target, |target| {
        Box::pin(async move {
            let said = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let sink = said.clone();
            let mut backend = crate::support::backend(target.kind);
            backend.set_log_sink(Some(std::sync::Arc::new(move |text, _| {
                if let app_lib::protocol::LogText::Key { key, .. } = text
                    && key == "activeModeViaProxy"
                {
                    sink.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            })));
            backend
                .connect(&parse(&target.config))
                .await
                .expect("connect");
            drop(backend);
            assert!(
                said.load(std::sync::atomic::Ordering::SeqCst),
                "no log line for the ignored active mode"
            );
            proxy_round_trip(target).await;
        })
    })
    .await;
}

// Proxies. Targets are addressed by compose service name, so the proxy
// resolves them (the client has no DNS entry for `vsftpd`).

fn through(kind: Kind, proxy: Value) -> Target {
    let mut target = crate::targets::target(match kind {
        Kind::Ftp => "vsftpd_plain",
        Kind::Sftp => "openssh_modern",
        Kind::Webdav => "apache_basic",
    });
    target.profile = "proxy";
    match kind {
        Kind::Ftp => {
            target.config.insert("host".into(), "vsftpd".into());
            target.config.insert("port".into(), 21.into());
        }
        Kind::Sftp => {
            target.config.insert("host".into(), "openssh-modern".into());
            target.config.insert("port".into(), 22.into());
        }
        Kind::Webdav => {
            target
                .config
                .insert("webdavUrl".into(), "http://apache-basic/".into());
        }
    }
    target.config.insert("proxyEnabled".into(), true.into());
    for (key, value) in proxy.as_object().unwrap() {
        target.config.insert(key.clone(), value.clone());
    }
    target
}

/// Needs the `proxy` profile and the profile of the server behind the proxy.
async fn run_proxied(target: Target, scenario: impl FnOnce(Target) -> Scenario) {
    let behind = crate::targets::target(target.id);
    if !selected(&behind) {
        not_run(format_args!(
            "{} (behind the proxy) is not selected",
            behind.id
        ));
        return;
    }
    run_target(target, scenario).await;
}

async fn proxy_round_trip(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    put(
        &mut backend,
        &work.local("f"),
        &work.path("proxied.txt"),
        b"through the proxy",
    )
    .await;
    assert_eq!(
        get(&mut backend, &work.path("proxied.txt")).await,
        b"through the proxy"
    );
    let listed = backend.list(&work.remote).await.expect("list");
    assert_eq!(names(&listed), ["proxied.txt"]);
    work.finish(&mut backend).await;
}

macro_rules! proxied {
    ($name:ident, $kind:ident, $proxy:expr) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore = "requires the server matrix: npm run servers:up, then servers:test"]
        async fn $name() {
            run_proxied(through(Kind::$kind, $proxy), |target| {
                Box::pin(proxy_round_trip(target))
            })
            .await;
        }
    };
}

fn socks5() -> Value {
    json!({"proxyType": "socks5", "proxyHost": "127.0.0.1", "proxyPort": 11080})
}
fn socks5_auth(password: &str) -> Value {
    json!({"proxyType": "socks5", "proxyHost": "127.0.0.1", "proxyPort": 11081,
           "proxyUsername": "proxyuser", "proxyPassword": password})
}
fn socks4a() -> Value {
    json!({"proxyType": "socks4", "proxyHost": "127.0.0.1", "proxyPort": 11082})
}
fn http(password: Option<&str>) -> Value {
    match password {
        None => json!({"proxyType": "http", "proxyHost": "127.0.0.1", "proxyPort": 13128}),
        Some(password) => json!({"proxyType": "http", "proxyHost": "127.0.0.1", "proxyPort": 13129,
                                  "proxyUsername": "proxyuser", "proxyPassword": password}),
    }
}

proxied!(proxy_socks5_ftp, Ftp, socks5());
proxied!(proxy_socks5_sftp, Sftp, socks5());
proxied!(proxy_socks5_webdav, Webdav, socks5());
proxied!(proxy_socks5_auth_ftp, Ftp, socks5_auth("proxypass"));
proxied!(proxy_socks5_auth_sftp, Sftp, socks5_auth("proxypass"));
proxied!(proxy_socks5_auth_webdav, Webdav, socks5_auth("proxypass"));
proxied!(proxy_socks4a_ftp, Ftp, socks4a());
proxied!(proxy_socks4a_sftp, Sftp, socks4a());
proxied!(proxy_socks4a_webdav, Webdav, socks4a());
proxied!(proxy_http_ftp, Ftp, http(None));
proxied!(proxy_http_sftp, Sftp, http(None));
proxied!(proxy_http_webdav, Webdav, http(None));
proxied!(proxy_http_auth_ftp, Ftp, http(Some("proxypass")));
proxied!(proxy_http_auth_sftp, Sftp, http(Some("proxypass")));
proxied!(proxy_http_auth_webdav, Webdav, http(Some("proxypass")));

/// The encoding relay sits on top of the proxied control connection.
macro_rules! proxied_cp1251 {
    ($name:ident, $host:literal, $proxy:expr) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore = "requires the server matrix: npm run servers:up, then servers:test"]
        async fn $name() {
            let mut target = through(Kind::Ftp, $proxy);
            target.config.insert("host".into(), $host.into());
            run_proxied(target, |target| Box::pin(cp1251_iac_names(target))).await;
        }
    };
}

proxied_cp1251!(proxy_socks5_ftp_cp1251, "vsftpd", socks5());
proxied_cp1251!(proxy_http_ftp_cp1251, "proftpd", http(None));

macro_rules! proxy_refused {
    ($name:ident, $kind:ident, $proxy:expr) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore = "requires the server matrix: npm run servers:up, then servers:test"]
        async fn $name() {
            run_proxied(through(Kind::$kind, $proxy), |target| {
                Box::pin(async move {
                    let code = expect_refusal(&target, &target.config).await;
                    assert_eq!(code, ErrorCode::ProxyFailed);
                })
            })
            .await;
        }
    };
}

proxy_refused!(proxy_socks5_wrong_password_sftp, Sftp, socks5_auth("wrong"));
proxy_refused!(
    proxy_socks5_wrong_password_webdav,
    Webdav,
    socks5_auth("wrong")
);
proxy_refused!(proxy_http_wrong_password_sftp, Sftp, http(Some("wrong")));
proxy_refused!(
    proxy_http_wrong_password_webdav,
    Webdav,
    http(Some("wrong"))
);

// Relay: the app copies between two sites by piping one backend's download
// into the other's upload, never through a local file.

async fn relay(source: Target, destination: Target) {
    use app_lib::protocol::ProgressInfo;
    use app_lib::relay::{RELAY_BUF_SIZE, relay_download, relay_upload};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    let mut from = connect(&source).await;
    let mut to = connect(&destination).await;
    let from_work = Work::new(&source, &mut from).await;
    let to_work = Work::new(&destination, &mut to).await;
    // Several relay buffers, not a multiple of any of them.
    let payload: Vec<u8> = (0..3 * RELAY_BUF_SIZE as u32 + 12_345)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8)
        .collect();
    let name = "relay éà 中文.bin";
    put(
        &mut from,
        &from_work.local("f"),
        &from_work.path(name),
        &payload,
    )
    .await;

    let reported = Arc::new(AtomicU64::new(0));
    let seen = reported.clone();
    let progress: app_lib::protocol::ProgressSink = Arc::new(move |info| {
        if let ProgressInfo::Progress { bytes, .. } = info {
            seen.store(bytes, Ordering::SeqCst);
        }
    });
    let (source_path, destination_path) = (from_work.path(name), to_work.path(name));
    let (writer, reader) = tokio::io::duplex(RELAY_BUF_SIZE);
    let (total_tx, total_rx) = tokio::sync::oneshot::channel();
    let (sent, received) = tokio::join!(
        relay_download(&mut from, &source_path, writer, total_tx, progress),
        relay_upload(&mut to, &destination_path, reader, total_rx),
    );
    let label = format!("{} -> {}", source.id, destination.id);
    sent.unwrap_or_else(|error| panic!("{label}: source [{:?}]: {error:#}", code(&error)));
    received.unwrap_or_else(|error| panic!("{label}: destination [{:?}]: {error:#}", code(&error)));
    assert_eq!(
        reported.load(Ordering::SeqCst),
        payload.len() as u64,
        "{label}: progress"
    );
    assert!(
        get(&mut to, &to_work.path(name)).await == payload,
        "{label}: content differs"
    );

    from_work.finish(&mut from).await;
    to_work.finish(&mut to).await;
}

macro_rules! relayed {
    ($name:ident, $source:literal, $destination:literal) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore = "requires the server matrix: npm run servers:up, then servers:test"]
        async fn $name() {
            run_pair($source, $destination, |source, destination| {
                Box::pin(relay(source, destination))
            })
            .await;
        }
    };
}

relayed!(relay_vsftpd_to_nextcloud, "vsftpd", "nextcloud");
relayed!(relay_openssh_to_apache, "openssh_chroot", "apache_basic");
relayed!(relay_apache_to_proftpd, "apache_basic", "proftpd");
relayed!(relay_proftpd_to_dropbear, "proftpd", "dropbear");
relayed!(relay_nginx_to_sftpgo_sftp, "nginx_davext", "sftpgo_sftp");
relayed!(relay_sftpgo_webdav_to_vsftpd, "sftpgo_webdav", "vsftpd");
