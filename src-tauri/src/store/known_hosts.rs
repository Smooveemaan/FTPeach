use super::{JsonMap, Store};
use crate::protocol::known_hosts::{HostKeyPinOutcome, KnownHostsStore};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;

#[async_trait]
impl KnownHostsStore for Store {
    async fn pin_or_verify(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
        allow_first_pin: bool,
    ) -> Result<HostKeyPinOutcome> {
        self.pin_or_verify_known_host_fingerprint(host, port, fingerprint, allow_first_pin)
            .await
    }
}

impl Store {
    async fn read_trust_store(&self) -> Result<JsonMap> {
        use anyhow::Context;
        let path = self.known_hosts_file();
        let raw = match tokio::fs::read(&path).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                anyhow::ensure!(
                    !tokio::fs::try_exists(path.with_extension("last-good.bak")).await?,
                    "Trust store is missing but a previous store exists; explicit recovery is required"
                );
                return Ok(JsonMap::new());
            }
            Err(error) => {
                return Err(error)
                    .context("reading SSH trust store; explicit recovery is required");
            }
        };
        let value = super::storage::decode_versioned_store(&path, serde_json::from_slice(&raw)?)?;
        let hosts: JsonMap = serde_json::from_value(value).context("invalid SSH trust store")?;
        anyhow::ensure!(
            hosts.iter().all(|(key, value)| key
                .rsplit_once(':')
                .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
                && value.as_str().is_some_and(|s| !s.is_empty())),
            "Invalid SSH trust store entries; explicit recovery is required"
        );
        Ok(hosts)
    }

    fn known_hosts_file(&self) -> PathBuf {
        self.dir.join("known_hosts.json")
    }

    pub async fn get_known_host_fingerprint(&self, host: &str, port: u16) -> Option<String> {
        let hosts: JsonMap = self
            .read_json(&self.known_hosts_file(), JsonMap::new())
            .await;
        hosts
            .get(&format!("{host}:{port}"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    #[cfg(test)]
    pub async fn set_known_host_fingerprint(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> Result<()> {
        let path = self.known_hosts_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut hosts = self.read_trust_store().await?;
        hosts.insert(
            format!("{host}:{port}"),
            Value::String(fingerprint.to_string()),
        );
        self.write_json(&path, &hosts).await
    }

    /// Atomically checks the stored fingerprint for `host:port` against
    /// `fingerprint` and pins it if none is stored yet — the read (deciding
    /// "is this a first sighting") and the write (pinning it) happen under
    /// one held lock instead of two separate calls. Splitting this into a
    /// `get_known_host_fingerprint` + `set_known_host_fingerprint` pair
    /// would reopen a TOFU race: two SFTP connections to the same
    /// never-before-seen host could both observe "no pinned key yet" and
    /// each pin its *own* peer's key, with whichever write landed last
    /// silently overwriting the other — no mismatch ever reported for the
    /// connection whose key didn't win.
    pub async fn pin_or_verify_known_host_fingerprint(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
        allow_first_pin: bool,
    ) -> Result<HostKeyPinOutcome> {
        let path = self.known_hosts_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut hosts = self.read_trust_store().await?;
        let key = format!("{host}:{port}");
        match hosts.get(&key).and_then(Value::as_str) {
            None if !allow_first_pin => Ok(HostKeyPinOutcome::Unknown),
            None => {
                hosts.insert(key, Value::String(fingerprint.to_string()));
                self.write_json(&path, &hosts).await?;
                Ok(HostKeyPinOutcome::Pinned)
            }
            Some(known) if known == fingerprint => Ok(HostKeyPinOutcome::Matched),
            Some(known) => Ok(HostKeyPinOutcome::Mismatched {
                expected: known.to_string(),
            }),
        }
    }

    /// Replaces the pin for `host:port`, but only if it still holds
    /// `expected` (or still holds nothing, when `expected` is `None`).
    ///
    /// The user confirmed one specific replacement. If the stored key moved
    /// on in between -- another connection pinned it, or a second mismatch
    /// arrived -- that confirmation was about a different pair of keys, so
    /// the write is refused and the decision has to be made again.
    pub async fn trust_known_host_fingerprint(
        &self,
        host: &str,
        port: u16,
        expected: Option<&str>,
        actual: &str,
    ) -> Result<()> {
        let path = self.known_hosts_file();
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let mut hosts = self.read_trust_store().await?;
        let key = format!("{host}:{port}");
        anyhow::ensure!(
            hosts.get(&key).and_then(Value::as_str) == expected,
            "The stored key for this server changed while it was being confirmed"
        );
        hosts.insert(key, Value::String(actual.to_string()));
        self.write_json(&path, &hosts).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn damaged_trust_never_accepts_a_new_pin_or_rolls_back_to_backup() {
        let root = std::env::temp_dir().join(format!("ftpeach-trust-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::new_at(root.clone());
        assert!(
            store
                .pin_or_verify("host", 22, "original", true)
                .await
                .is_ok()
        );
        for content in [
            "{",
            r#"{"schemaVersion":999,"data":{}}"#,
            r#"{"host:22":42}"#,
        ] {
            std::fs::write(root.join("known_hosts.json"), content).unwrap();
            std::fs::write(root.join("known_hosts.last-good.bak"), "{}").unwrap();
            assert!(
                store
                    .pin_or_verify("host", 22, "attacker", true)
                    .await
                    .is_err()
            );
            assert_eq!(
                std::fs::read_to_string(root.join("known_hosts.json")).unwrap(),
                content
            );
        }
        std::fs::remove_file(root.join("known_hosts.json")).unwrap();
        assert!(
            store
                .pin_or_verify("host", 22, "attacker", true)
                .await
                .is_err()
        );
        std::fs::create_dir(root.join("known_hosts.json")).unwrap();
        assert!(
            store
                .pin_or_verify("host", 22, "attacker", true)
                .await
                .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn first_contact_is_only_pinned_when_the_connection_may_pin_it() {
        let root = std::env::temp_dir().join(format!("ftpeach-tofu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::new_at(root.clone());
        assert_eq!(
            store
                .pin_or_verify("host", 22, "first", false)
                .await
                .unwrap(),
            HostKeyPinOutcome::Unknown
        );
        assert_eq!(store.get_known_host_fingerprint("host", 22).await, None);
        store
            .trust_known_host_fingerprint("host", 22, None, "first")
            .await
            .unwrap();
        assert_eq!(
            store
                .pin_or_verify("host", 22, "first", false)
                .await
                .unwrap(),
            HostKeyPinOutcome::Matched
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The user confirmed one replacement. If the stored key moved on in
    /// between, that confirmation was about a different pair of keys.
    #[tokio::test]
    async fn a_confirmed_replacement_is_refused_once_the_stored_key_moves_on() {
        let root = std::env::temp_dir().join(format!("ftpeach-swap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::new_at(root.clone());
        store
            .trust_known_host_fingerprint("host", 22, None, "original")
            .await
            .unwrap();
        assert!(
            store
                .trust_known_host_fingerprint("host", 22, Some("stale"), "attacker")
                .await
                .is_err()
        );
        assert!(
            store
                .trust_known_host_fingerprint("host", 22, None, "attacker")
                .await
                .is_err()
        );
        assert_eq!(
            store
                .get_known_host_fingerprint("host", 22)
                .await
                .as_deref(),
            Some("original")
        );
        store
            .trust_known_host_fingerprint("host", 22, Some("original"), "replacement")
            .await
            .unwrap();
        assert_eq!(
            store
                .get_known_host_fingerprint("host", 22)
                .await
                .as_deref(),
            Some("replacement")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
