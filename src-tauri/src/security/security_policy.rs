//! Settings that protect the user from the renderer itself.
//!
//! Turning off security confirmations or relaxing the vault's idle lock
//! must be the user's decision, not something the renderer those settings
//! guard against can do through `settings_set`. Such a change goes through
//! the `settings_set_security` command, whose confirmation is always shown,
//! whatever the setting being changed currently says. Making protection
//! stronger needs no confirmation. The same command carries the proxy's
//! address and password, so a saved proxy password follows a new proxy
//! only after the user confirmed that move (see `credential_scope`).
use crate::security::credential_scope::{PROXY_SCOPE_KEYS, proxy_transfer, sets_secret};
use crate::store::JsonMap;
use serde::Serialize;
use serde_json::Value;

pub const CONFIRMATIONS: &str = "showSecurityConfirmations";
pub const AUTO_LOCK: &str = "vaultAutoLockMinutes";
pub const STRICT_HOST_KEY: &str = "strictHostKeyCheck";

/// The protective changes a patch would undo, as shown to the user.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weakening {
    /// `Some(false)`: security confirmations would be turned off.
    pub show_security_confirmations: Option<bool>,
    /// The new idle lock in minutes, `0` meaning never.
    pub vault_auto_lock_minutes: Option<u64>,
    /// `Some(false)`: an unknown SSH host key would be trusted unseen.
    pub strict_host_key_check: Option<bool>,
}

impl Weakening {
    pub fn is_empty(&self) -> bool {
        self.show_security_confirmations.is_none()
            && self.vault_auto_lock_minutes.is_none()
            && self.strict_host_key_check.is_none()
    }
}

fn confirmations_enabled(settings: &JsonMap) -> bool {
    settings
        .get(CONFIRMATIONS)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn auto_lock_minutes(settings: &JsonMap) -> u64 {
    settings.get(AUTO_LOCK).and_then(Value::as_u64).unwrap_or(0)
}

fn strict_host_key(settings: &JsonMap) -> bool {
    settings
        .get(STRICT_HOST_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// What `patch` would weaken relative to `current`, the merged settings.
pub fn weakening(current: &JsonMap, patch: &JsonMap) -> Weakening {
    let mut weakening = Weakening::default();
    if confirmations_enabled(current) && patch.get(CONFIRMATIONS) == Some(&Value::Bool(false)) {
        weakening.show_security_confirmations = Some(false);
    }
    if let Some(next) = patch.get(AUTO_LOCK).and_then(Value::as_u64) {
        let now = auto_lock_minutes(current);
        // 0 is "never", the weakest setting; a longer delay is weaker too.
        if now > 0 && (next == 0 || next > now) {
            weakening.vault_auto_lock_minutes = Some(next);
        }
    }
    if strict_host_key(current) && patch.get(STRICT_HOST_KEY) == Some(&Value::Bool(false)) {
        weakening.strict_host_key_check = Some(false);
    }
    weakening
}

/// `patch` without the values that would weaken protection. An import
/// applies settings in bulk, so it keeps the current protection instead.
pub fn without_weakening(current: &JsonMap, mut patch: JsonMap) -> JsonMap {
    let weakening = weakening(current, &patch);
    if weakening.show_security_confirmations.is_some() {
        patch.remove(CONFIRMATIONS);
    }
    if weakening.vault_auto_lock_minutes.is_some() {
        patch.remove(AUTO_LOCK);
    }
    if weakening.strict_host_key_check.is_some() {
        patch.remove(STRICT_HOST_KEY);
    }
    patch
}

/// Everything `settings_set_security` applies: the protective settings,
/// and the proxy's address together with its password, since changing one
/// without the other can send the saved password somewhere new.
pub const PROTECTED_KEYS: [&str; 9] = [
    CONFIRMATIONS,
    AUTO_LOCK,
    STRICT_HOST_KEY,
    "proxyType",
    "proxyHost",
    "proxyPort",
    "proxyUsername",
    "proxyPassword",
    "removeProxyPassword",
];

/// Whether `settings_set` must leave `patch` to `settings_set_security`.
pub fn needs_confirmation_path(current: &JsonMap, patch: &JsonMap) -> bool {
    !weakening(current, patch).is_empty() || proxy_transfer(current, patch).is_some()
}

/// `patch` without what would weaken protection or send the saved proxy
/// password to a new proxy. An import applies settings in bulk, so it keeps
/// the current values instead.
pub fn without_unconfirmed_changes(current: &JsonMap, patch: JsonMap) -> JsonMap {
    let mut patch = without_weakening(current, patch);
    if proxy_transfer(current, &patch).is_some() {
        for key in PROXY_SCOPE_KEYS {
            patch.remove(key);
        }
    }
    patch
}

/// The value a grant for `settings_set_security` is bound to. A new proxy
/// password is named only by whether there is one, never by its value.
pub fn grant_target(current: &JsonMap, patch: &JsonMap) -> String {
    let protected: std::collections::BTreeMap<_, _> = patch
        .iter()
        .filter(|(key, _)| PROTECTED_KEYS.contains(&key.as_str()))
        .map(|(key, value)| match key.as_str() {
            "proxyPassword" => (key.clone(), Value::Bool(sets_secret(patch, key))),
            _ => (key.clone(), value.clone()),
        })
        .collect();
    serde_json::json!({
        "patch": protected,
        "transfer": proxy_transfer(current, patch),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(value: Value) -> JsonMap {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn turning_protection_off_or_down_is_a_weakening() {
        let current = map(serde_json::json!({ CONFIRMATIONS: true, AUTO_LOCK: 15 }));
        for (patch, expected) in [
            (
                serde_json::json!({ CONFIRMATIONS: false }),
                Weakening {
                    show_security_confirmations: Some(false),
                    ..Weakening::default()
                },
            ),
            (
                serde_json::json!({ AUTO_LOCK: 0 }),
                Weakening {
                    vault_auto_lock_minutes: Some(0),
                    ..Weakening::default()
                },
            ),
            (
                serde_json::json!({ AUTO_LOCK: 60 }),
                Weakening {
                    vault_auto_lock_minutes: Some(60),
                    ..Weakening::default()
                },
            ),
        ] {
            assert_eq!(
                weakening(&current, &map(patch.clone())),
                expected,
                "{patch}"
            );
        }
    }

    #[test]
    fn keeping_or_strengthening_protection_is_not() {
        let current = map(serde_json::json!({ CONFIRMATIONS: true, AUTO_LOCK: 15 }));
        for patch in [
            serde_json::json!({ CONFIRMATIONS: true, AUTO_LOCK: 15 }),
            serde_json::json!({ AUTO_LOCK: 5 }),
            serde_json::json!({ "theme": "dark" }),
        ] {
            assert!(
                weakening(&current, &map(patch.clone())).is_empty(),
                "{patch}"
            );
        }
        let off = map(serde_json::json!({ CONFIRMATIONS: false, AUTO_LOCK: 0 }));
        for patch in [
            serde_json::json!({ CONFIRMATIONS: false, AUTO_LOCK: 0 }),
            serde_json::json!({ AUTO_LOCK: 30 }),
            serde_json::json!({ CONFIRMATIONS: true }),
        ] {
            assert!(weakening(&off, &map(patch.clone())).is_empty(), "{patch}");
        }
    }

    #[test]
    fn missing_values_default_to_the_protective_side() {
        let empty = JsonMap::new();
        assert_eq!(
            weakening(&empty, &map(serde_json::json!({ CONFIRMATIONS: false })))
                .show_security_confirmations,
            Some(false)
        );
    }

    #[test]
    fn a_bulk_patch_keeps_current_protection_but_applies_the_rest() {
        let current = map(serde_json::json!({ CONFIRMATIONS: true, AUTO_LOCK: 15 }));
        let patch = map(serde_json::json!({
            CONFIRMATIONS: false,
            AUTO_LOCK: 5,
            "theme": "dark"
        }));
        assert_eq!(
            without_weakening(&current, patch),
            map(serde_json::json!({ AUTO_LOCK: 5, "theme": "dark" }))
        );
    }

    #[test]
    fn the_grant_covers_only_protected_keys_in_a_stable_order() {
        let current = JsonMap::new();
        let a = map(serde_json::json!({ AUTO_LOCK: 0, CONFIRMATIONS: false, "theme": "x" }));
        let b = map(serde_json::json!({ CONFIRMATIONS: false, AUTO_LOCK: 0 }));
        assert_eq!(grant_target(&current, &a), grant_target(&current, &b));
        assert_ne!(
            grant_target(&current, &a),
            grant_target(&current, &map(serde_json::json!({ CONFIRMATIONS: false })))
        );
    }

    #[test]
    fn the_grant_names_a_new_proxy_password_but_never_its_value() {
        let current = JsonMap::new();
        let sent = map(serde_json::json!({ "proxyHost": "p", "proxyPassword": "hunter2" }));
        let named = map(serde_json::json!({ "proxyHost": "p", "proxyPassword": true }));
        let target = grant_target(&current, &sent);
        assert!(!target.contains("hunter2"));
        assert_eq!(target, grant_target(&current, &named));
    }

    #[test]
    fn moving_the_saved_proxy_password_takes_the_confirmed_path() {
        let current = map(serde_json::json!({ "proxyHost": "p", "proxyPasswordEnc": "AQID" }));
        let moved = map(serde_json::json!({ "proxyHost": "q" }));
        assert!(needs_confirmation_path(&current, &moved));
        assert!(!needs_confirmation_path(
            &current,
            &map(serde_json::json!({ "proxyHost": "q", "proxyPassword": "new" }))
        ));
        assert!(!needs_confirmation_path(
            &current,
            &map(serde_json::json!({ "theme": "x" }))
        ));
        assert_eq!(
            without_unconfirmed_changes(
                &current,
                map(serde_json::json!({ "proxyHost": "q", "proxyPort": 9, "theme": "x" }))
            ),
            map(serde_json::json!({ "theme": "x" }))
        );
    }
}
