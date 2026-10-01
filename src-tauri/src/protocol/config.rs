use super::SensitiveString;
use super::transport::ProxyConfig;
use crate::domain::{Credentials, Protocol, ServerSettings};
use crate::ipc::{CommandError, ErrorCode};
use crate::store::ConnectionDefaults;
use anyhow::{Context, Result, bail};

#[cfg(any(test, feature = "test-utils"))]
pub const DEFAULT_TIMEOUT_MS: u64 = 20_000;

#[derive(Clone, Debug)]
pub struct CommonConfig {
    pub max_connections: Option<u16>,
    pub timeout_ms: u64,
    pub proxy: Option<ProxyConfig>,
}

#[derive(Clone, Debug)]
pub struct FtpConfig {
    pub common: CommonConfig,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: SensitiveString,
    pub secure: bool,
    pub allow_invalid_cert: bool,
    pub ca_cert_path: Option<String>,
    pub active_mode: bool,
    /// The server's file name encoding, when it is not UTF-8.
    pub encoding: Option<&'static encoding_rs::Encoding>,
}

#[derive(Clone, Debug)]
pub struct SftpConfig {
    pub common: CommonConfig,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: SensitiveString,
    pub use_key_auth: bool,
    pub key_path: Option<String>,
    pub key_passphrase: Option<SensitiveString>,
    /// Refuse an unknown host key until the user has confirmed it, rather
    /// than pinning whatever answers first.
    pub strict_host_key_check: bool,
}

#[derive(Clone, Debug)]
pub struct WebDavConfig {
    pub common: CommonConfig,
    pub url: String,
    pub user: String,
    pub password: SensitiveString,
    pub allow_invalid_cert: bool,
    /// The user accepted sending the password over an unencrypted `http://`
    /// connection. Without it FTPeach probes for an HTTPS address first and
    /// refuses to authenticate in the clear.
    pub allow_cleartext_auth: bool,
    pub ca_cert_path: Option<String>,
}

/// The longest a server's text fields may be, in bytes. Saving a site checks
/// the same numbers, so nothing is stored that could not be connected to.
pub(crate) const MAX_HOST_LEN: usize = 255;
pub(crate) const MAX_USER_LEN: usize = 1024;
pub(crate) const MAX_URL_OR_FILE_LEN: usize = 4096;

#[derive(Clone, Debug)]
pub enum ConnectionConfig {
    Ftp(FtpConfig),
    Sftp(SftpConfig),
    Webdav(WebDavConfig),
}

impl ConnectionConfig {
    /// The configuration a protocol backend connects with: the server and
    /// its credentials, with the application's connection settings. What is
    /// checked here is what a connection needs, for a saved site and a
    /// direct connect alike: sizes, a start folder without traversal, a host
    /// or an absolute URL, a key file for key sign-in, and no line breaks in
    /// FTP credentials.
    pub fn build(
        server: &ServerSettings,
        credentials: Credentials,
        defaults: &ConnectionDefaults,
    ) -> Result<Self> {
        let Credentials {
            password,
            key_passphrase,
        } = credentials;
        for (key, length, limit) in [
            ("host", server.host.len(), MAX_HOST_LEN),
            ("user", server.user.len(), MAX_USER_LEN),
            (
                "remotePath",
                server.remote_path.len(),
                super::MAX_REMOTE_PATH_LEN,
            ),
            ("webdavUrl", server.webdav_url.len(), MAX_URL_OR_FILE_LEN),
            ("keyPath", server.key_path.len(), MAX_URL_OR_FILE_LEN),
            ("caCertPath", server.ca_cert_path.len(), MAX_URL_OR_FILE_LEN),
            ("password", password.expose().len(), 16 * 1024),
            (
                "keyPassphrase",
                key_passphrase
                    .as_ref()
                    .map_or(0, |value| value.expose().len()),
                16 * 1024,
            ),
        ] {
            if length > limit {
                bail!(CommandError::new(
                    ErrorCode::ResourceLimit,
                    format!("{key} exceeds the {limit}-byte limit"),
                ));
            }
        }
        let remote_path = &server.remote_path;
        if !remote_path.starts_with('/')
            || remote_path.contains('\0')
            || remote_path.split('/').any(|segment| segment == "..")
        {
            bail!("remotePath must be an absolute remote path without traversal");
        }
        if defaults.timeout_ms > 86_400_000 {
            bail!("timeout must not exceed 86400000 ms");
        }
        if server
            .max_connections
            .is_some_and(|value| value == 1 || value > 128)
        {
            bail!("maxConnections must be 0 (unlimited) or between 2 and 128");
        }
        let common = CommonConfig {
            max_connections: server.max_connections,
            timeout_ms: defaults.timeout_ms,
            proxy: defaults.proxy.clone(),
        };
        let host = || {
            if server.host.trim().is_empty() {
                bail!("host is required");
            }
            Ok(server.host.clone())
        };
        let file = |path: &str| (!path.is_empty()).then(|| path.to_owned());

        match server.protocol {
            Protocol::Ftp | Protocol::Ftps => {
                if server.user.contains(['\r', '\n']) || password.expose().contains(['\r', '\n']) {
                    bail!("user/password must not contain carriage return or newline characters");
                }
                Ok(Self::Ftp(FtpConfig {
                    common,
                    host: host()?,
                    port: server.port.unwrap_or(21),
                    user: if server.user.is_empty() {
                        "anonymous".into()
                    } else {
                        server.user.clone()
                    },
                    password,
                    secure: server.protocol == Protocol::Ftps,
                    allow_invalid_cert: server.allow_invalid_cert,
                    ca_cert_path: file(&server.ca_cert_path),
                    active_mode: defaults.active_mode,
                    encoding: super::ftp_charset::parse(&server.encoding)?,
                }))
            }
            Protocol::Sftp => {
                let key_path = file(&server.key_path);
                if server.use_key_auth && key_path.is_none() {
                    bail!("keyPath is required when key authentication is enabled");
                }
                Ok(Self::Sftp(SftpConfig {
                    common,
                    host: host()?,
                    port: server.port.unwrap_or(22),
                    user: server.user.clone(),
                    password,
                    use_key_auth: server.use_key_auth,
                    key_path,
                    key_passphrase,
                    strict_host_key_check: defaults.strict_host_key_check,
                }))
            }
            Protocol::Webdav => {
                if server.webdav_url.trim().is_empty() {
                    bail!("webdavUrl is required");
                }
                let url = server.webdav_url.trim_end_matches('/').to_string();
                let parsed = reqwest::Url::parse(&url).context("invalid WebDAV URL")?;
                if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
                    bail!("WebDAV URL must be an absolute HTTP or HTTPS URL");
                }
                // A second, silent place to keep a password: it would be
                // logged with the address, exported with the bookmark and
                // sent before anything decided it was safe to send.
                if !parsed.username().is_empty() || parsed.password().is_some() {
                    bail!(
                        "WebDAV URL must not carry a user name or password; put them in the account fields"
                    );
                }
                // WebDAV addresses collections by path, and every request
                // appends segments to this base, so a query string here is
                // both meaningless and another place a token could hide.
                if parsed.query().is_some() || parsed.fragment().is_some() {
                    bail!("WebDAV URL must not contain a query string or fragment");
                }
                Ok(Self::Webdav(WebDavConfig {
                    common,
                    url,
                    user: server.user.clone(),
                    password,
                    allow_invalid_cert: server.allow_invalid_cert,
                    allow_cleartext_auth: server.allow_cleartext_auth,
                    ca_cert_path: file(&server.ca_cert_path),
                }))
            }
        }
    }

    /// A connection described the way tests write one: the fields a direct
    /// connect sends for the server and its credentials, with the
    /// application settings it depends on (`timeout`, `activeMode`,
    /// `strictHostKeyCheck` and the `proxy*` keys) in the same object. A
    /// setting left out takes the value a new profile starts with.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn for_test(description: &crate::store::JsonMap) -> Result<Self> {
        use serde_json::Value;
        let text = |key: &str| description.get(key).and_then(Value::as_str);
        let proxy = match description.get("proxyEnabled").and_then(Value::as_bool) {
            Some(true) => Some(ProxyConfig::new(
                text("proxyType"),
                text("proxyHost").unwrap_or_default(),
                description
                    .get("proxyPort")
                    .and_then(Value::as_u64)
                    .and_then(|port| u16::try_from(port).ok())
                    .unwrap_or_default(),
                text("proxyUsername"),
                text("proxyPassword").map(SensitiveString::from),
            )?),
            _ => None,
        };
        let defaults = ConnectionDefaults {
            timeout_ms: description
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_TIMEOUT_MS),
            active_mode: description
                .get("activeMode")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            strict_host_key_check: description
                .get(crate::security::security_policy::STRICT_HOST_KEY)
                .and_then(Value::as_bool)
                .unwrap_or(true),
            proxy,
        };
        Self::build(
            &ServerSettings::from_json(description)?,
            serde_json::from_value(Value::Object(description.clone()))?,
            &defaults,
        )
    }

    pub fn protocol(&self) -> Protocol {
        match self {
            Self::Ftp(config) if config.secure => Protocol::Ftps,
            Self::Ftp(_) => Protocol::Ftp,
            Self::Sftp(_) => Protocol::Sftp,
            Self::Webdav(_) => Protocol::Webdav,
        }
    }

    pub fn common(&self) -> &CommonConfig {
        match self {
            Self::Ftp(config) => &config.common,
            Self::Sftp(config) => &config.common,
            Self::Webdav(config) => &config.common,
        }
    }

    /// Tells one server account apart from another. Two sessions opened with
    /// the same details reach the same files, whichever pane opened them;
    /// anything else may be a different server, even at the same address.
    pub fn server(&self) -> String {
        match self {
            // FTPS is the same server as plain FTP on that port.
            Self::Ftp(config) => {
                serde_json::json!(["ftp", config.host.to_lowercase(), config.port, config.user])
            }
            Self::Sftp(config) => {
                serde_json::json!(["sftp", config.host.to_lowercase(), config.port, config.user])
            }
            Self::Webdav(config) => serde_json::json!(["webdav", config.url, config.user]),
        }
        .to_string()
    }

    /// How the log file and the diagnostic bundle name this server: address
    /// and port, never the user name or anything else from the account, so
    /// the file can be attached to a bug report as it is.
    pub fn log_label(&self) -> String {
        fn host_port(host: &str, port: u16) -> String {
            if host.contains(':') && !host.starts_with('[') {
                format!("[{host}]:{port}")
            } else {
                format!("{host}:{port}")
            }
        }
        match self {
            Self::Ftp(config) => format!(
                "{}://{}",
                if config.secure { "ftps" } else { "ftp" },
                host_port(&config.host, config.port)
            ),
            Self::Sftp(config) => format!("sftp://{}", host_port(&config.host, config.port)),
            Self::Webdav(config) => reqwest::Url::parse(&config.url)
                .ok()
                .and_then(|url| {
                    let host = url.host_str()?;
                    Some(match url.port() {
                        Some(port) => format!("{}://{host}:{port}", url.scheme()),
                        None => format!("{}://{host}", url.scheme()),
                    })
                })
                .unwrap_or_else(|| "webdav".to_string()),
        }
    }
}

// Every credential field is a `SensitiveString`, which clears itself when
// the last copy of a config goes out of scope. A hand-written `Drop` on
// the outer `ConnectionConfig` used to do that, but it only reached the
// values it named: the clones the protocol backends and the transfer
// pool's factory keep were plain `String`s that outlived it.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn connection_limit_validates_runtime_and_saved_values() {
        for limit in [json!(0), json!(2), json!(5), json!(128), json!(null)] {
            assert!(
                ConnectionConfig::for_test(&map(json!({"host":"test", "maxConnections":limit})))
                    .is_ok()
            );
        }
        for limit in [json!(1), json!(129), json!(-1), json!(2.5), json!("bad")] {
            assert!(
                ConnectionConfig::for_test(&map(json!({"host":"test", "maxConnections":limit})))
                    .is_err()
            );
        }
    }

    fn map(value: serde_json::Value) -> crate::store::JsonMap {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn a_missing_null_or_empty_host_and_user_mean_the_same() {
        for protocol in ["ftp", "ftps", "sftp"] {
            for host in [None, Some(json!(null)), Some(json!("")), Some(json!(5))] {
                let mut site = map(json!({ "protocol": protocol }));
                if let Some(host) = host {
                    site.insert("host".into(), host);
                }
                let error = ConnectionConfig::for_test(&site).unwrap_err();
                assert_eq!(error.to_string(), "host is required", "{site:?}");
            }
        }
        for user in [None, Some(json!(null)), Some(json!(""))] {
            let mut site = map(json!({ "protocol": "ftp", "host": "example.test" }));
            if let Some(user) = user {
                site.insert("user".into(), user);
            }
            let ConnectionConfig::Ftp(config) = ConnectionConfig::for_test(&site).unwrap() else {
                panic!("an FTP config");
            };
            assert_eq!(config.user, "anonymous", "{site:?}");
        }
    }

    /// A start folder is a path from the server's root. One saved without
    /// the leading slash names the same folder, and must not make the site
    /// unconnectable: the connection itself never uses it.
    #[test]
    fn a_start_folder_saved_without_its_leading_slash_starts_at_the_root() {
        for (stored, read) in [
            ("pub", "/pub"),
            ("pub/in", "/pub/in"),
            ("", "/"),
            ("/pub", "/pub"),
        ] {
            let site =
                map(json!({ "protocol": "ftp", "host": "example.test", "remotePath": stored }));
            assert_eq!(
                crate::domain::ServerSettings::from_json(&site)
                    .unwrap()
                    .remote_path,
                read
            );
            assert!(ConnectionConfig::for_test(&site).is_ok(), "{stored}");
        }
        let escaping =
            map(json!({ "protocol": "ftp", "host": "example.test", "remotePath": "../up" }));
        assert!(ConnectionConfig::for_test(&escaping).is_err());
    }

    #[test]
    fn rejects_connection_strings_above_their_boundaries() {
        let accepted =
            map(json!({"protocol":"ftp", "host":"x".repeat(255), "user":"u".repeat(1024)}));
        assert!(ConnectionConfig::for_test(&accepted).is_ok());
        for value in [
            json!({"protocol":"ftp", "host":"x".repeat(256)}),
            json!({"protocol":"ftp", "host":"example.test", "user":"u".repeat(1025)}),
        ] {
            let error = ConnectionConfig::for_test(&map(value)).unwrap_err();
            assert!(error.downcast_ref::<crate::ipc::CommandError>().is_some());
            // The size limit keeps its own code on the way to the renderer.
            assert_eq!(
                crate::domain::invalid_connection_settings(&error).code,
                ErrorCode::ResourceLimit
            );
        }
        let no_host = ConnectionConfig::for_test(&map(json!({"protocol":"ftp"}))).unwrap_err();
        assert_eq!(
            crate::domain::invalid_connection_settings(&no_host).code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn log_label_names_the_server_without_the_account() {
        let label =
            |value: serde_json::Value| ConnectionConfig::for_test(&map(value)).unwrap().log_label();
        assert_eq!(
            label(json!({"protocol":"ftps", "host":"example.test", "user":"alice"})),
            "ftps://example.test:21"
        );
        assert_eq!(
            label(json!({"protocol":"sftp", "host":"::1", "port":2222, "user":"alice"})),
            "sftp://[::1]:2222"
        );
        assert_eq!(
            label(json!({
                "protocol":"webdav",
                "webdavUrl":"https://dav.example.test:8443/remote.php/dav",
                "user":"alice"
            })),
            "https://dav.example.test:8443"
        );
        // The address itself can no longer carry an account, so the label
        // has nothing of the kind left to strip.
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol":"webdav",
                "webdavUrl":"https://alice:secret@dav.example.test:8443/remote.php/dav?token=x"
            })))
            .is_err()
        );
    }

    #[test]
    fn separates_protocol_specific_fields() {
        let config = ConnectionConfig::for_test(&map(json!({
            "protocol": "sftp", "host": "example.test", "port": 22,
            "useKeyAuth": true, "keyPath": "/key", "timeout": 0
        })))
        .unwrap();
        let ConnectionConfig::Sftp(ref config) = config else {
            panic!("wrong variant")
        };
        assert_eq!(config.host, "example.test");
        assert_eq!(config.common.timeout_ms, 0);
        assert_eq!(config.key_path.as_deref(), Some("/key"));
    }

    #[test]
    fn validates_numeric_values_and_webdav_url() {
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "ftp", "host": "x", "port": 70000
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "webdav", "webdavUrl": "/relative"
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "ftp", "host": "x", "remotePath": "/safe/../escape"
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "ftp", "host": "x", "timeout": 86_400_001
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "sftp", "host": "x", "useKeyAuth": true
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "ftp", "host": "x", "proxyEnabled": true,
                "proxyPort": 1080
            })))
            .is_err()
        );
    }

    #[test]
    fn accepts_numeric_strings_from_legacy_saved_sites() {
        let config = ConnectionConfig::for_test(&map(json!({
            "protocol": "sftp", "host": "example.test", "port": "2222"
        })))
        .unwrap();
        let ConnectionConfig::Sftp(ref config) = config else {
            panic!("wrong variant")
        };
        assert_eq!(config.port, 2222);
    }

    #[test]
    fn rejects_crlf_in_ftp_credentials_to_block_command_injection() {
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "ftp", "host": "x", "user": "evil\r\nDELE /other"
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "ftp", "host": "x", "password": "evil\r\nDELE /other"
            })))
            .is_err()
        );
    }

    #[test]
    fn parses_custom_ca_cert_path_for_ftps_and_webdav() {
        let config = ConnectionConfig::for_test(&map(json!({
            "protocol": "ftps", "host": "example.test", "caCertPath": "/ca.pem"
        })))
        .unwrap();
        let ConnectionConfig::Ftp(ref config) = config else {
            panic!("wrong variant")
        };
        assert_eq!(config.ca_cert_path.as_deref(), Some("/ca.pem"));

        let config = ConnectionConfig::for_test(&map(json!({
            "protocol": "webdav", "webdavUrl": "https://example.test/dav", "caCertPath": ""
        })))
        .unwrap();
        let ConnectionConfig::Webdav(ref config) = config else {
            panic!("wrong variant")
        };
        assert_eq!(config.ca_cert_path, None);
    }

    #[test]
    fn accepts_ipv6_targets_for_tcp_and_webdav_protocols() {
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "sftp", "host": "2001:db8::1", "port": 22
            })))
            .is_ok()
        );
        assert!(
            ConnectionConfig::for_test(&map(json!({
                "protocol": "webdav", "webdavUrl": "https://[2001:db8::1]/dav"
            })))
            .is_ok()
        );
    }
}
