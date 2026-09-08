use super::JsonMap;
use crate::ipc::{CommandError, ErrorCode};
use serde::{Deserialize, Serialize};
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

/// Typed IPC boundary. Unknown fields are retained only while the protocol
/// backends are migrated away from their legacy map interface.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(default)]
    pub protocol: Protocol,
    pub site_id: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    #[serde(alias = "url")]
    pub webdav_url: Option<String>,
    pub remote_path: Option<String>,
    pub timeout: Option<u64>,
    pub concurrency: Option<u16>,
    #[serde(flatten)]
    pub compatibility: JsonMap,
}

impl ConnectionConfig {
    pub fn validate(&self) -> Result<(), CommandError> {
        if self.site_id.is_some() {
            return Ok(());
        }
        if self.timeout.is_some_and(|v| v > 86_400_000) || self.concurrency.is_some_and(|v| v > 128)
        {
            return Err(CommandError::new(
                ErrorCode::InvalidInput,
                "Invalid timeout or concurrency",
            ));
        }
        if self.remote_path.as_deref().is_some_and(|path| {
            !path.starts_with('/')
                || path.contains('\0')
                || path.split('/').any(|segment| segment == "..")
        }) {
            return Err(CommandError::new(
                ErrorCode::InvalidInput,
                "Invalid remote path",
            ));
        }
        match self.protocol {
            Protocol::Webdav if self.webdav_url.as_deref().is_none_or(str::is_empty) => Err(
                CommandError::new(ErrorCode::InvalidInput, "WebDAV URL is required"),
            ),
            Protocol::Ftp | Protocol::Ftps | Protocol::Sftp
                if self.host.as_deref().is_none_or(str::is_empty) =>
            {
                Err(CommandError::new(
                    ErrorCode::InvalidInput,
                    "Host is required",
                ))
            }
            _ => Ok(()),
        }
    }

    pub fn into_map(self) -> JsonMap {
        let mut map = self.compatibility;
        map.insert(
            "protocol".into(),
            serde_json::to_value(self.protocol).unwrap(),
        );
        for (key, value) in [
            ("siteId", self.site_id.map(Value::String)),
            ("host", self.host.map(Value::String)),
            ("webdavUrl", self.webdav_url.map(Value::String)),
            ("remotePath", self.remote_path.map(Value::String)),
            ("port", self.port.map(|v| Value::from(v as u64))),
            ("timeout", self.timeout.map(Value::from)),
            (
                "concurrency",
                self.concurrency.map(|v| Value::from(v as u64)),
            ),
        ] {
            if let Some(value) = value {
                map.insert(key.into(), value);
            }
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_config_preserves_compatibility_fields() {
        let config: ConnectionConfig = serde_json::from_value(
            serde_json::json!({"protocol":"sftp","host":"example.test","password":"secret"}),
        )
        .unwrap();
        config.validate().unwrap();
        assert_eq!(config.into_map()["password"], "secret");
    }
}
