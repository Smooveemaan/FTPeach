//! A versioned field envelope under a key held by Keychain or Secret Service.

use anyhow::{Context, Result, anyhow, ensure};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::Zeroizing;

const HEADER: &[u8] = b"FTPS\x01";
const NONCE: usize = 24;

fn load_key(entry: &keyring::Entry, create: bool) -> Result<Zeroizing<Vec<u8>>> {
    let key = match entry.get_secret() {
        Ok(key) => Zeroizing::new(key),
        Err(keyring::Error::NoEntry) if create => {
            let mut key = Zeroizing::new(vec![0; 32]);
            getrandom::fill(&mut key).context("generating system protection key")?;
            entry
                .set_secret(&key)
                .context("saving system protection key")?;
            // Do not save ciphertext until the key has survived a read back.
            ensure!(
                Zeroizing::new(entry.get_secret()?) == key,
                "system protection key did not persist"
            );
            key
        }
        Err(error) => return Err(error).context("reading system protection key"),
    };
    ensure!(key.len() == 32, "invalid system protection key");
    Ok(key)
}

fn with_key<T>(create: bool, operation: impl FnOnce(&[u8]) -> Result<T>) -> Result<T> {
    // Serialize first-use creation and reads across every store in this process.
    static ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ACCESS
        .lock()
        .map_err(|_| anyhow!("system protection unavailable"))?;
    // Separate desktop sessions can bypass the application's single-instance lock.
    #[cfg(not(test))]
    let _account_lock = {
        let directory = dirs::data_dir()
            .context("system protection data directory unavailable")?
            .join("com.smooveemaan.ftpeach");
        std::fs::create_dir_all(&directory)?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("system-protection.lock"))?;
        lock.lock()
            .context("locking system protection key access")?;
        lock
    };
    #[cfg(not(test))]
    let entry = &keyring::Entry::new("com.smooveemaan.ftpeach", "system-protection-v1")?;
    // Unit tests must neither prompt nor change the signed-in user's keychain.
    #[cfg(test)]
    let entry = {
        use std::sync::OnceLock;
        static ENTRY: OnceLock<keyring::Entry> = OnceLock::new();
        ENTRY.get_or_init(|| {
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
        })
    };
    let key = load_key(entry, create).context(
        "System password storage is unavailable. Set up a master password in Security settings",
    )?;
    operation(&key)
}

/// Seals a saved field with the account's system-held key.
pub(crate) fn protect(data: &[u8]) -> Result<Vec<u8>> {
    with_key(true, |key| seal(data, key))
}

/// Opens a saved field without creating a key if the original is missing.
pub(crate) fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    // Validate before asking the keychain, and never create a key while reading.
    envelope(data)?;
    with_key(false, |key| open(data, key))
}

fn seal(data: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0; NONCE];
    getrandom::fill(&mut nonce).context("generating system protection nonce")?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| anyhow!("invalid system protection key"))?;
    let sealed = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: data,
                aad: HEADER,
            },
        )
        .map_err(|_| anyhow!("protecting saved secret"))?;
    Ok([HEADER, &nonce, &sealed].concat())
}

fn envelope(data: &[u8]) -> Result<(&[u8], &[u8])> {
    let rest = data
        .strip_prefix(HEADER)
        .context("unsupported system protection format")?;
    ensure!(rest.len() >= NONCE + 16, "damaged saved secret");
    Ok(rest.split_at(NONCE))
}

fn open(data: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    let (nonce, sealed) = envelope(data)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| anyhow!("invalid system protection key"))?;
    cipher
        .decrypt(
            &XNonce::try_from(nonce).map_err(|_| anyhow!("damaged saved secret"))?,
            Payload {
                msg: sealed,
                aad: HEADER,
            },
        )
        .map_err(|_| anyhow!("saved secret could not be opened"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_randomized_authenticated_and_versioned() {
        let key = [7; 32];
        let sealed = seal(b"saved password", &key).unwrap();
        assert_eq!(open(&sealed, &key).unwrap(), b"saved password");
        assert_ne!(sealed, seal(b"saved password", &key).unwrap());
        assert!(open(&sealed, &[8; 32]).is_err());
        for index in [0, 4, 5, sealed.len() - 1] {
            let mut changed = sealed.clone();
            changed[index] ^= 1;
            assert!(open(&changed, &key).is_err());
        }
        for length in 0..sealed.len() {
            assert!(open(&sealed[..length], &key).is_err());
        }
        assert_eq!(open(&seal(b"", &key).unwrap(), &key).unwrap(), b"");
    }

    #[test]
    fn missing_or_invalid_key_is_never_replaced_during_a_read() {
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        assert!(load_key(&entry, false).is_err());
        assert!(matches!(entry.get_secret(), Err(keyring::Error::NoEntry)));
        let key = load_key(&entry, true).unwrap();
        assert_eq!(load_key(&entry, false).unwrap(), key);
        assert_eq!(load_key(&entry, true).unwrap(), key);
        entry.set_secret(b"bad key").unwrap();
        assert!(load_key(&entry, true).is_err());
        assert_eq!(entry.get_secret().unwrap(), b"bad key");
    }

    #[test]
    fn a_locked_or_unavailable_keychain_never_replaces_the_key() {
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        entry.set_secret(&[9; 32]).unwrap();
        let mock = entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap();
        for create in [false, true] {
            mock.set_error(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::other("locked"),
            )));
            assert!(load_key(&entry, create).is_err());
            assert_eq!(entry.get_secret().unwrap(), [9; 32]);
        }
    }

    #[test]
    fn protection_round_trip_uses_the_same_account_key() {
        let sealed = protect(b"site or proxy password").unwrap();
        assert_eq!(unprotect(&sealed).unwrap(), b"site or proxy password");
        assert!(unprotect(b"foreign DPAPI blob").is_err());
    }
}
