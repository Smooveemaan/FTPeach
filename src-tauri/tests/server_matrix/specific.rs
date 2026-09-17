//! What only one server (or one proxy) can show.

use crate::support::*;
use crate::targets::{Kind, Target, generated};
use app_lib::ErrorCode;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

macro_rules! specific {
    ($name:ident, $target:literal, $body:path) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore]
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
    let mut backend = connect(&target).await;
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
        #[ignore]
        async fn $name() {
            let target = through(Kind::$kind, $proxy);
            let id = target.id;
            run(id, move |_| Box::pin(proxy_round_trip(target))).await;
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

macro_rules! proxy_refused {
    ($name:ident, $kind:ident, $proxy:expr) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore]
        async fn $name() {
            let target = through(Kind::$kind, $proxy);
            run(target.id, move |_| {
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
