//! Who a saved password is sent to.
//!
//! A password saved for one server must not quietly follow an edit of the
//! bookmark to another one: the backend already refuses a `host` override
//! next to a `siteId`, but editing the bookmark itself, or the global proxy,
//! used to keep the password for whatever address was typed in next. The
//! scope below is everything that decides the recipient; when it changes
//! and the saved password would stay, the user confirms the move in a
//! backend window that shows the old and the new recipient.
use crate::store::JsonMap;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialScope {
    pub protocol: String,
    pub host: String,
    pub port: u64,
    pub account: String,
    /// WebDAV names its server by URL rather than host and port.
    pub url: String,
    pub secure: bool,
    pub allow_invalid_cert: bool,
    /// A WebDAV bookmark allowed to sign in over plain HTTP.
    pub allow_cleartext_auth: bool,
    pub ca_cert_path: String,
}

/// A saved password that would be kept for a different recipient.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretTransfer {
    pub from: String,
    pub to: String,
    /// The new recipient is reached without encryption or without
    /// certificate checks where the old one was not.
    pub less_secure: bool,
}

fn text(record: &JsonMap, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

fn flag(record: &JsonMap, key: &str) -> bool {
    record.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn port(record: &JsonMap, key: &str) -> u64 {
    match record.get(key) {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

pub fn site_scope(site: &JsonMap) -> CredentialScope {
    CredentialScope {
        protocol: text(site, "protocol").to_ascii_lowercase(),
        host: text(site, "host").to_ascii_lowercase(),
        port: port(site, "port"),
        account: text(site, "user"),
        url: text(site, "webdavUrl"),
        secure: flag(site, "secure"),
        allow_invalid_cert: flag(site, "allowInvalidCert"),
        allow_cleartext_auth: flag(site, "allowCleartextAuth"),
        ca_cert_path: text(site, "caCertPath"),
    }
}

pub fn proxy_scope(settings: &JsonMap) -> CredentialScope {
    CredentialScope {
        protocol: text(settings, "proxyType").to_ascii_lowercase(),
        host: text(settings, "proxyHost").to_ascii_lowercase(),
        port: port(settings, "proxyPort"),
        account: text(settings, "proxyUsername"),
        url: String::new(),
        secure: false,
        allow_invalid_cert: false,
        allow_cleartext_auth: false,
        ca_cert_path: String::new(),
    }
}

/// Settings keys that decide where the proxy password goes.
pub const PROXY_SCOPE_KEYS: [&str; 4] = ["proxyType", "proxyHost", "proxyPort", "proxyUsername"];

impl CredentialScope {
    fn encrypted(&self) -> bool {
        match self.protocol.as_str() {
            "sftp" => true,
            "webdav" => self.url.to_ascii_lowercase().starts_with("https:"),
            _ => self.secure,
        }
    }

    /// How the recipient reads in a confirmation, e.g. `ftps://bob@host:21`.
    pub fn describe(&self) -> String {
        if !self.url.is_empty() {
            return match self.account.as_str() {
                "" => self.url.clone(),
                account => format!("{} ({account})", self.url),
            };
        }
        let scheme = match (self.protocol.as_str(), self.secure) {
            ("ftp", true) => "ftps",
            (protocol, _) => protocol,
        };
        let account = match self.account.as_str() {
            "" => String::new(),
            account => format!("{account}@"),
        };
        let port = match self.port {
            0 => String::new(),
            port => format!(":{port}"),
        };
        format!("{scheme}://{account}{}{port}", self.host)
    }
}

/// The move a save would make, or `None` when the password stays with its
/// recipient, is replaced or removed, or there is none.
pub fn transfer(
    before: &CredentialScope,
    after: &CredentialScope,
    has_saved_password: bool,
    password_replaced_or_removed: bool,
) -> Option<SecretTransfer> {
    if !has_saved_password || password_replaced_or_removed || before == after {
        return None;
    }
    Some(SecretTransfer {
        from: before.describe(),
        to: after.describe(),
        less_secure: (before.encrypted() && !after.encrypted())
            || (!before.allow_invalid_cert && after.allow_invalid_cert)
            || (!before.allow_cleartext_auth && after.allow_cleartext_auth),
    })
}

/// A non-empty new secret, as sent (`"…"`) or as named in a grant (`true`).
pub fn sets_secret(record: &JsonMap, key: &str) -> bool {
    match record.get(key) {
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Bool(value)) => *value,
        _ => false,
    }
}

/// The move saving `input` over the stored bookmark would make.
pub fn site_save_transfer(
    stored: Option<&(JsonMap, bool)>,
    input: &JsonMap,
) -> Option<SecretTransfer> {
    let (stored, has_password) = stored?;
    if matches!(
        input.get("kind").and_then(Value::as_str),
        Some("local" | "folder")
    ) {
        return None;
    }
    transfer(
        &site_scope(stored),
        &site_scope(input),
        *has_password,
        sets_secret(input, "password") || flag(input, "removePassword"),
    )
}

/// The value a `sites_save` grant is bound to: the bookmark, and the
/// password move the save makes, if any.
pub fn site_save_target(input: &JsonMap, transfer: Option<&SecretTransfer>) -> String {
    serde_json::json!({
        "siteId": input.get("id").and_then(Value::as_str).unwrap_or(""),
        "transfer": transfer,
    })
    .to_string()
}

/// The move a settings patch would make with the saved proxy password.
pub fn proxy_transfer(current: &JsonMap, patch: &JsonMap) -> Option<SecretTransfer> {
    let mut next = current.clone();
    for key in PROXY_SCOPE_KEYS {
        if let Some(value) = patch.get(key) {
            next.insert(key.into(), value.clone());
        }
    }
    let saved = ["proxyPasswordEnc", "proxyPasswordPlain"]
        .iter()
        .any(|key| sets_secret(current, key))
        || flag(current, "hasProxyPassword");
    transfer(
        &proxy_scope(current),
        &proxy_scope(&next),
        saved,
        sets_secret(patch, "proxyPassword") || flag(patch, "removeProxyPassword"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(value: Value) -> JsonMap {
        serde_json::from_value(value).unwrap()
    }

    fn base() -> JsonMap {
        site(serde_json::json!({
            "id": "s", "name": "Work", "color": "red", "protocol": "ftp",
            "host": "a.example", "port": 21, "user": "bob", "secure": true,
            "allowInvalidCert": false, "maxConnections": 2, "parentId": null
        }))
    }

    #[test]
    fn a_new_recipient_needs_a_confirmed_transfer() {
        let before = site_scope(&base());
        for (key, value) in [
            ("host", serde_json::json!("b.example")),
            ("port", serde_json::json!(2121)),
            ("user", serde_json::json!("alice")),
            ("protocol", serde_json::json!("sftp")),
            ("secure", serde_json::json!(false)),
            ("allowInvalidCert", serde_json::json!(true)),
            ("caCertPath", serde_json::json!("C:\\ca.pem")),
        ] {
            let mut edited = base();
            edited.insert(key.into(), value);
            assert!(
                transfer(&before, &site_scope(&edited), true, false).is_some(),
                "{key}"
            );
        }
    }

    #[test]
    fn cosmetic_edits_replacement_and_removal_need_nothing() {
        let before = site_scope(&base());
        let mut edited = base();
        for (key, value) in [
            ("name", serde_json::json!("Renamed")),
            ("color", serde_json::json!("blue")),
            ("maxConnections", serde_json::json!(8)),
            ("parentId", serde_json::json!("folder")),
            ("host", serde_json::json!(" A.Example ")),
            ("port", serde_json::json!("21")),
        ] {
            edited.insert(key.into(), value);
        }
        assert_eq!(transfer(&before, &site_scope(&edited), true, false), None);
        edited.insert("host".into(), serde_json::json!("b.example"));
        let after = site_scope(&edited);
        assert_eq!(transfer(&before, &after, false, false), None);
        assert_eq!(transfer(&before, &after, true, true), None);
    }

    #[test]
    fn dropping_encryption_or_certificate_checks_is_flagged() {
        let before = site_scope(&base());
        let mut plain = base();
        plain.insert("secure".into(), serde_json::json!(false));
        let moved = transfer(&before, &site_scope(&plain), true, false).unwrap();
        assert!(moved.less_secure);
        assert_eq!(moved.from, "ftps://bob@a.example:21");
        assert_eq!(moved.to, "ftp://bob@a.example:21");

        let mut unchecked = base();
        unchecked.insert("allowInvalidCert".into(), serde_json::json!(true));
        assert!(
            transfer(&before, &site_scope(&unchecked), true, false)
                .unwrap()
                .less_secure
        );

        let mut other_host = base();
        other_host.insert("host".into(), serde_json::json!("b.example"));
        assert!(
            !transfer(&before, &site_scope(&other_host), true, false)
                .unwrap()
                .less_secure
        );

        let https =
            site(serde_json::json!({"protocol":"webdav","webdavUrl":"https://dav.example/"}));
        let http = site(serde_json::json!({"protocol":"webdav","webdavUrl":"http://dav.example/"}));
        assert!(
            transfer(&site_scope(&https), &site_scope(&http), true, false)
                .unwrap()
                .less_secure
        );
    }

    #[test]
    fn saving_a_bookmark_moves_its_password_only_when_kept_for_a_new_server() {
        let stored = (base(), true);
        let mut edited = base();
        edited.insert("host".into(), serde_json::json!("b.example"));
        let moved = site_save_transfer(Some(&stored), &edited).unwrap();
        assert_eq!(moved.to, "ftps://bob@b.example:21");
        assert_ne!(
            site_save_target(&edited, Some(&moved)),
            site_save_target(&edited, None)
        );

        let mut replaced = edited.clone();
        replaced.insert("password".into(), serde_json::json!("new"));
        assert_eq!(site_save_transfer(Some(&stored), &replaced), None);
        replaced.insert("password".into(), serde_json::json!(true));
        assert_eq!(site_save_transfer(Some(&stored), &replaced), None);
        let mut removed = edited.clone();
        removed.insert("removePassword".into(), serde_json::json!(true));
        assert_eq!(site_save_transfer(Some(&stored), &removed), None);
        assert_eq!(site_save_transfer(Some(&(base(), false)), &edited), None);
        assert_eq!(site_save_transfer(None, &edited), None);
    }

    #[test]
    fn a_proxy_edit_moves_the_saved_proxy_password() {
        let current = site(serde_json::json!({
            "proxyType": "socks5", "proxyHost": "p.example", "proxyPort": 1080,
            "proxyUsername": "u", "proxyPasswordEnc": "AQID"
        }));
        let to_b = site(serde_json::json!({ "proxyHost": "q.example" }));
        assert!(proxy_transfer(&current, &to_b).is_some());
        let mut with_password = to_b.clone();
        with_password.insert("proxyPassword".into(), serde_json::json!("x"));
        assert_eq!(proxy_transfer(&current, &with_password), None);
        let mut vault = current.clone();
        vault.remove("proxyPasswordEnc");
        assert_eq!(proxy_transfer(&vault, &to_b), None);
        vault.insert("hasProxyPassword".into(), serde_json::json!(true));
        assert!(proxy_transfer(&vault, &to_b).is_some());
        assert_eq!(
            proxy_transfer(
                &current,
                &site(serde_json::json!({ "proxyEnabled": false }))
            ),
            None
        );
    }

    #[test]
    fn proxy_scope_is_its_address_type_and_account() {
        let proxy = site(serde_json::json!({
            "proxyType": "socks5", "proxyHost": "p.example", "proxyPort": 1080,
            "proxyUsername": "u", "proxyEnabled": true
        }));
        let before = proxy_scope(&proxy);
        for key in PROXY_SCOPE_KEYS {
            let mut edited = proxy.clone();
            edited.insert(key.into(), serde_json::json!("changed"));
            assert!(
                transfer(&before, &proxy_scope(&edited), true, false).is_some(),
                "{key}"
            );
        }
        let mut disabled = proxy;
        disabled.insert("proxyEnabled".into(), serde_json::json!(false));
        assert_eq!(
            transfer(&before, &proxy_scope(&disabled), true, false),
            None
        );
    }
}
