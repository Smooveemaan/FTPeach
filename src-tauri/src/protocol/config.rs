use super::transport::ProxyConfig;
use crate::domain::Protocol;
use crate::store::JsonMap;
use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use zeroize::Zeroize;

pub const DEFAULT_TIMEOUT_MS: u64 = 20_000;

#[derive(Clone, Debug)]
pub struct CommonConfig {
    pub max_connections: Option<u16>,
    pub timeout_ms: u64,
    pub concurrency: Option<u16>,
    pub proxy: Option<ProxyConfig>,
}

#[derive(Clone, Debug)]
pub struct FtpConfig {
    pub common: CommonConfig,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub secure: bool,
    pub allow_invalid_cert: bool,
    pub ca_cert_path: Option<String>,
    pub active_mode: bool,
}

#[derive(Clone, Debug)]
pub struct SftpConfig {
    pub common: CommonConfig,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub use_key_auth: bool,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
}

#[derive(Clone, Debug)]
pub struct WebDavConfig {
    pub common: CommonConfig,
    pub url: String,
    pub user: String,
    pub password: String,
    pub allow_invalid_cert: bool,
    pub ca_cert_path: Option<String>,
}

#[derive(Clone, Debug)]
pub enum ConnectionConfig {
    Ftp(FtpConfig),
    Sftp(SftpConfig),
    Webdav(WebDavConfig),
}

impl ConnectionConfig {
    pub fn from_json_map(map: &JsonMap) -> Result<Self> {
        for (key, limit) in [
            ("host", 255usize),
            ("user", 1024),
            ("remotePath", super::MAX_REMOTE_PATH_LEN),
            ("webdavUrl", 4096),
            ("keyPath", 4096),
            ("caCertPath", 4096),
            ("proxyHost", 255),
            ("proxyUsername", 1024),
            ("proxyPassword", 16 * 1024),
            ("password", 16 * 1024),
            ("keyPassphrase", 16 * 1024),
        ] {
            if map
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| value.len() > limit)
            {
                bail!(crate::ipc::CommandError::new(
                    crate::ipc::ErrorCode::ResourceLimit,
                    format!("{key} exceeds the {limit}-byte limit"),
                ));
            }
        }
        if let Some(remote_path) = map.get("remotePath").and_then(Value::as_str)
            && (!remote_path.starts_with('/')
                || remote_path.contains('\0')
                || remote_path.split('/').any(|segment| segment == ".."))
        {
            bail!("remotePath must be an absolute remote path without traversal");
        }
        let protocol = match map.get("protocol").and_then(Value::as_str).unwrap_or("ftp") {
            "ftp" => Protocol::Ftp,
            "ftps" => Protocol::Ftps,
            "sftp" => Protocol::Sftp,
            "webdav" => Protocol::Webdav,
            other => bail!("unsupported protocol: {other}"),
        };
        let timeout_ms = optional_u64(map, "timeout")?.unwrap_or(DEFAULT_TIMEOUT_MS);
        if timeout_ms > 86_400_000 {
            bail!("timeout must not exceed 86400000 ms");
        }
        let concurrency = optional_u16(map, "concurrency")?;
        if concurrency.is_some_and(|value| value > 128) {
            bail!("concurrency must not exceed 128");
        }
        let common = CommonConfig {
            max_connections: {
                let limit = optional_u16(map, "maxConnections")?;
                if limit.is_some_and(|value| value == 1 || value > 128) {
                    bail!("maxConnections must be 0 (unlimited) or between 2 and 128");
                }
                limit
            },
            timeout_ms,
            concurrency,
            proxy: ProxyConfig::from_json_map(map)?,
        };
        let user = string(map, "user").unwrap_or_default();
        let password = string(map, "password").unwrap_or_default();

        match protocol {
            Protocol::Ftp | Protocol::Ftps => {
                if user.contains(['\r', '\n']) || password.contains(['\r', '\n']) {
                    bail!("user/password must not contain carriage return or newline characters");
                }
                Ok(Self::Ftp(FtpConfig {
                    common,
                    host: required_string(map, "host")?,
                    port: optional_u16(map, "port")?.unwrap_or(21),
                    user: if user.is_empty() {
                        "anonymous".into()
                    } else {
                        user
                    },
                    password,
                    secure: protocol == Protocol::Ftps
                        || map.get("secure").and_then(Value::as_bool).unwrap_or(false),
                    allow_invalid_cert: bool_value(map, "allowInvalidCert"),
                    ca_cert_path: string(map, "caCertPath").filter(|value| !value.is_empty()),
                    active_mode: bool_value(map, "activeMode"),
                }))
            }
            Protocol::Sftp => {
                let use_key_auth = bool_value(map, "useKeyAuth");
                let key_path = string(map, "keyPath").filter(|value| !value.is_empty());
                if use_key_auth && key_path.is_none() {
                    bail!("keyPath is required when key authentication is enabled");
                }
                Ok(Self::Sftp(SftpConfig {
                    common,
                    host: required_string(map, "host")?,
                    port: optional_u16(map, "port")?.unwrap_or(22),
                    user,
                    password,
                    use_key_auth,
                    key_path,
                    key_passphrase: string(map, "keyPassphrase"),
                }))
            }
            Protocol::Webdav => {
                let url = required_string(map, "webdavUrl")?
                    .trim_end_matches('/')
                    .to_string();
                let parsed = reqwest::Url::parse(&url).context("invalid WebDAV URL")?;
                if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
                    bail!("WebDAV URL must be an absolute HTTP or HTTPS URL");
                }
                Ok(Self::Webdav(WebDavConfig {
                    common,
                    url,
                    user,
                    password,
                    allow_invalid_cert: bool_value(map, "allowInvalidCert"),
                    ca_cert_path: string(map, "caCertPath").filter(|value| !value.is_empty()),
                }))
            }
        }
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
}

impl Drop for ConnectionConfig {
    fn drop(&mut self) {
        let (password, key_passphrase, proxy_password) = match self {
            Self::Ftp(config) => (
                &mut config.password,
                None,
                config
                    .common
                    .proxy
                    .as_mut()
                    .and_then(|proxy| proxy.password.as_mut()),
            ),
            Self::Sftp(config) => (
                &mut config.password,
                config.key_passphrase.as_mut(),
                config
                    .common
                    .proxy
                    .as_mut()
                    .and_then(|proxy| proxy.password.as_mut()),
            ),
            Self::Webdav(config) => (
                &mut config.password,
                None,
                config
                    .common
                    .proxy
                    .as_mut()
                    .and_then(|proxy| proxy.password.as_mut()),
            ),
        };
        password.zeroize();
        if let Some(secret) = key_passphrase {
            secret.zeroize();
        }
        if let Some(secret) = proxy_password {
            secret.zeroize();
        }
    }
}

fn string(map: &JsonMap, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn required_string(map: &JsonMap, key: &str) -> Result<String> {
    string(map, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("{key} is required"))
}

fn bool_value(map: &JsonMap, key: &str) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn optional_u64(map: &JsonMap, key: &str) -> Result<Option<u64>> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => value
            .parse::<u64>()
            .map(Some)
            .with_context(|| format!("{key} must be a non-negative integer")),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| anyhow!("{key} must be a non-negative integer")),
    }
}

fn optional_u16(map: &JsonMap, key: &str) -> Result<Option<u16>> {
    optional_u64(map, key)?
        .map(|value| u16::try_from(value).with_context(|| format!("{key} is out of range")))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn connection_limit_validates_runtime_and_saved_values() {
        for limit in [json!(0), json!(2), json!(5), json!(128), json!(null)] {
            assert!(
                ConnectionConfig::from_json_map(&map(
                    json!({"host":"test", "maxConnections":limit})
                ))
                .is_ok()
            );
        }
        for limit in [json!(1), json!(129), json!(-1), json!(2.5), json!("bad")] {
            assert!(
                ConnectionConfig::from_json_map(&map(
                    json!({"host":"test", "maxConnections":limit})
                ))
                .is_err()
            );
        }
    }

    fn map(value: Value) -> JsonMap {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn rejects_connection_strings_above_their_boundaries() {
        let accepted =
            map(json!({"protocol":"ftp", "host":"x".repeat(255), "user":"u".repeat(1024)}));
        assert!(ConnectionConfig::from_json_map(&accepted).is_ok());
        for value in [
            json!({"protocol":"ftp", "host":"x".repeat(256)}),
            json!({"protocol":"ftp", "host":"example.test", "user":"u".repeat(1025)}),
            json!({"protocol":"ftp", "host":"example.test", "proxyHost":"p".repeat(256)}),
        ] {
            let error = ConnectionConfig::from_json_map(&map(value)).unwrap_err();
            assert!(error.downcast_ref::<crate::ipc::CommandError>().is_some());
        }
    }

    #[test]
    fn separates_protocol_specific_fields() {
        let config = ConnectionConfig::from_json_map(&map(json!({
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
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "ftp", "host": "x", "port": 70000
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "webdav", "webdavUrl": "/relative"
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "ftp", "host": "x", "remotePath": "/safe/../escape"
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "ftp", "host": "x", "timeout": 86_400_001
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "ftp", "host": "x", "concurrency": 129
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "sftp", "host": "x", "useKeyAuth": true
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "ftp", "host": "x", "proxyEnabled": true,
                "proxyPort": 1080
            })))
            .is_err()
        );
    }

    #[test]
    fn accepts_numeric_strings_from_legacy_saved_sites() {
        let config = ConnectionConfig::from_json_map(&map(json!({
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
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "ftp", "host": "x", "user": "evil\r\nDELE /other"
            })))
            .is_err()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "ftp", "host": "x", "password": "evil\r\nDELE /other"
            })))
            .is_err()
        );
    }

    #[test]
    fn parses_custom_ca_cert_path_for_ftps_and_webdav() {
        let config = ConnectionConfig::from_json_map(&map(json!({
            "protocol": "ftps", "host": "example.test", "caCertPath": "/ca.pem"
        })))
        .unwrap();
        let ConnectionConfig::Ftp(ref config) = config else {
            panic!("wrong variant")
        };
        assert_eq!(config.ca_cert_path.as_deref(), Some("/ca.pem"));

        let config = ConnectionConfig::from_json_map(&map(json!({
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
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "sftp", "host": "2001:db8::1", "port": 22
            })))
            .is_ok()
        );
        assert!(
            ConnectionConfig::from_json_map(&map(json!({
                "protocol": "webdav", "webdavUrl": "https://[2001:db8::1]/dav"
            })))
            .is_ok()
        );
    }
}
