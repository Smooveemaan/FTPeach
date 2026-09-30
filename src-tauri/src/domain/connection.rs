//! What a server connection is, from the request to the protocol layer.
//!
//! A connect names a saved site or carries a server and its credentials
//! ([`ConnectRequest`]). Either way the backend ends up with one
//! [`ServerSettings`] and one [`Credentials`], adds the application's
//! connection settings (`store::ConnectionDefaults`) and builds the protocol
//! configuration from the three (`protocol::config::ConnectionConfig::build`).
//! A new server property is a field of `ServerSettings`, read in
//! [`ServerSettings::from_json`] and used in `build`.

use super::JsonMap;
use crate::ipc::{CommandError, ErrorCode};
use crate::security::sensitive_string::SensitiveString;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Ftp,
    Ftps,
    Sftp,
    Webdav,
}

/// Everything a saved site stores about its server, and what a direct
/// connect sends. It holds no secret.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerSettings {
    pub protocol: Protocol,
    pub host: String,
    pub port: Option<u16>,
    pub webdav_url: String,
    pub user: String,
    /// The folder a saved site opens in.
    pub remote_path: String,
    pub allow_invalid_cert: bool,
    /// A WebDAV server may be sent the password over plain `http://`.
    pub allow_cleartext_auth: bool,
    pub ca_cert_path: String,
    pub use_key_auth: bool,
    pub key_path: String,
    /// The FTP server's file name encoding; empty is UTF-8.
    pub encoding: String,
    /// How many connections the site may open at once; `Some(0)` is no limit.
    pub max_connections: Option<u16>,
}

impl ServerSettings {
    /// Reads the fields the way every earlier version stored or sent them. A
    /// field that is missing, `null` or of another type is unset, `port` and
    /// `maxConnections` may be numeric strings, and `protocol: "ftp"` with
    /// `secure: true` is FTPS. Other fields are ignored.
    pub fn from_json(record: &JsonMap) -> Result<Self> {
        let text = |key: &str| {
            record
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let flag = |key: &str| record.get(key).and_then(Value::as_bool).unwrap_or(false);
        let protocol = match record.get("protocol").and_then(Value::as_str) {
            None | Some("ftp") if flag("secure") => Protocol::Ftps,
            None | Some("ftp") => Protocol::Ftp,
            Some("ftps") => Protocol::Ftps,
            Some("sftp") => Protocol::Sftp,
            Some("webdav") => Protocol::Webdav,
            Some(other) => bail!("unsupported protocol: {other}"),
        };
        Ok(Self {
            protocol,
            host: text("host"),
            port: number(record, "port")?,
            webdav_url: text("webdavUrl"),
            user: text("user"),
            remote_path: record
                .get("remotePath")
                .and_then(Value::as_str)
                .unwrap_or("/")
                .to_owned(),
            allow_invalid_cert: flag("allowInvalidCert"),
            allow_cleartext_auth: flag("allowCleartextAuth"),
            ca_cert_path: text("caCertPath"),
            use_key_auth: flag("useKeyAuth"),
            key_path: text("keyPath"),
            encoding: text("encoding"),
            max_connections: number(record, "maxConnections")?,
        })
    }
}

fn number(record: &JsonMap, key: &str) -> Result<Option<u16>> {
    let value = match record.get(key) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) => text
            .parse::<u64>()
            .with_context(|| format!("{key} must be a non-negative integer"))?,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| anyhow!("{key} must be a non-negative integer"))?,
    };
    u16::try_from(value)
        .map(Some)
        .with_context(|| format!("{key} is out of range"))
}

impl<'de> Deserialize<'de> for ServerSettings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_json(&JsonMap::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// The secrets a connection signs in with: sent with a direct connect, or
/// resolved in the backend from a saved site's protected fields or the
/// vault. Resolved ones never go back to the renderer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    #[serde(default)]
    pub password: SensitiveString,
    /// `None` when a direct connect sends none; a saved site always has one,
    /// empty when nothing is saved.
    #[serde(default)]
    pub key_passphrase: Option<SensitiveString>,
}

/// The two connection settings the window sends with every connect instead
/// of the backend reading them from the store: the settings dialog applies
/// them to new connections while it previews them, before they are saved.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowConnectionSettings {
    pub timeout_ms: u64,
    pub active_mode: bool,
}

/// What `session_connect` is asked to open.
// Read once per connect and taken apart straight away; boxing the larger
// variant would buy nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectRequest {
    /// A saved site, whose server and credentials the backend reads itself.
    SavedSite { site_id: String },
    /// A server typed into the connection bar.
    Direct {
        server: ServerSettings,
        credentials: Credentials,
    },
}

/// How a server's settings that cannot be connected to are reported.
pub fn invalid_connection_settings(error: &anyhow::Error) -> CommandError {
    CommandError {
        code: ErrorCode::InvalidInput,
        message: "Invalid connection configuration".into(),
        details: Some(format!("{error:#}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(value: Value) -> Result<ServerSettings> {
        ServerSettings::from_json(value.as_object().unwrap())
    }

    #[test]
    fn every_stored_spelling_of_ftps_reads_as_ftps() {
        for value in [
            json!({"protocol": "ftps"}),
            json!({"protocol": "ftps", "secure": false}),
            json!({"protocol": "ftp", "secure": true}),
            json!({"secure": true}),
        ] {
            assert_eq!(
                read(value.clone()).unwrap().protocol,
                Protocol::Ftps,
                "{value}"
            );
        }
        for value in [
            json!({}),
            json!({"protocol": null}),
            json!({"protocol": 5}),
            json!({"protocol": "ftp", "secure": "true"}),
        ] {
            assert_eq!(
                read(value.clone()).unwrap().protocol,
                Protocol::Ftp,
                "{value}"
            );
        }
        // Only FTP had a separate switch for TLS.
        assert_eq!(
            read(json!({"protocol": "sftp", "secure": true}))
                .unwrap()
                .protocol,
            Protocol::Sftp
        );
        assert!(read(json!({"protocol": "FTPS"})).is_err());
    }

    #[test]
    fn unset_and_mistyped_fields_read_as_their_defaults() {
        let server = read(json!({
            "host": 5, "user": true, "allowInvalidCert": "yes", "remotePath": 7,
            "port": null, "maxConnections": null, "encoding": null, "future": 1
        }))
        .unwrap();
        assert_eq!(
            server,
            ServerSettings {
                protocol: Protocol::Ftp,
                host: String::new(),
                port: None,
                webdav_url: String::new(),
                user: String::new(),
                remote_path: "/".into(),
                allow_invalid_cert: false,
                allow_cleartext_auth: false,
                ca_cert_path: String::new(),
                use_key_auth: false,
                key_path: String::new(),
                encoding: String::new(),
                max_connections: None,
            }
        );
    }

    #[test]
    fn numbers_may_be_numeric_strings_but_nothing_else() {
        let server = read(json!({"port": "2222", "maxConnections": "3"})).unwrap();
        assert_eq!((server.port, server.max_connections), (Some(2222), Some(3)));
        for port in [
            json!("twenty-one"),
            json!(-1),
            json!(2.5),
            json!(70000),
            json!(true),
        ] {
            assert!(read(json!({ "port": port })).is_err(), "{port}");
        }
    }

    #[test]
    fn a_request_names_a_saved_site_or_carries_a_server() {
        let saved: ConnectRequest =
            serde_json::from_value(json!({"kind": "savedSite", "siteId": "s"})).unwrap();
        assert!(matches!(saved, ConnectRequest::SavedSite { site_id } if site_id == "s"));
        let direct: ConnectRequest = serde_json::from_value(json!({
            "kind": "direct",
            "server": {"protocol": "sftp", "host": "h", "password": "not here"},
            "credentials": {"password": "p"}
        }))
        .unwrap();
        let ConnectRequest::Direct {
            server,
            credentials,
        } = direct
        else {
            panic!("a direct request")
        };
        assert_eq!(server.host, "h");
        assert_eq!(credentials.password.expose(), "p");
        assert!(credentials.key_passphrase.is_none());
    }
}
