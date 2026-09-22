//! Settings that protect the user from the renderer itself.
//!
//! Turning off security confirmations or relaxing the vault's idle lock
//! must be the user's decision, not something the renderer those settings
//! guard against can do through `settings_set`. Such a change goes through
//! the `settings_set_security` command, whose confirmation is always shown,
//! whatever the setting being changed currently says. Making protection
//! stronger needs no confirmation.
use crate::store::JsonMap;
use serde::Serialize;
use serde_json::Value;

pub const CONFIRMATIONS: &str = "showSecurityConfirmations";
pub const AUTO_LOCK: &str = "vaultAutoLockMinutes";
pub const SECURITY_KEYS: [&str; 2] = [CONFIRMATIONS, AUTO_LOCK];

/// The protective changes a patch would undo, as shown to the user.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weakening {
    /// `Some(false)`: security confirmations would be turned off.
    pub show_security_confirmations: Option<bool>,
    /// The new idle lock in minutes, `0` meaning never.
    pub vault_auto_lock_minutes: Option<u64>,
}

impl Weakening {
    pub fn is_empty(&self) -> bool {
        self.show_security_confirmations.is_none() && self.vault_auto_lock_minutes.is_none()
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
    patch
}

/// Only the security keys of `patch`.
pub fn security_part(patch: &JsonMap) -> JsonMap {
    patch
        .iter()
        .filter(|(key, _)| SECURITY_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// The value a grant for `settings_set_security` is bound to.
pub fn grant_target(patch: &JsonMap) -> String {
    let ordered: std::collections::BTreeMap<_, _> = security_part(patch).into_iter().collect();
    serde_json::to_string(&ordered).unwrap_or_default()
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
    fn the_grant_covers_only_security_keys_in_a_stable_order() {
        let a = map(serde_json::json!({ AUTO_LOCK: 0, CONFIRMATIONS: false, "theme": "x" }));
        let b = map(serde_json::json!({ CONFIRMATIONS: false, AUTO_LOCK: 0 }));
        assert_eq!(grant_target(&a), grant_target(&b));
        assert_ne!(
            grant_target(&a),
            grant_target(&map(serde_json::json!({ CONFIRMATIONS: false })))
        );
    }
}
