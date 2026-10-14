//! The saved passwords a settings export carries, sealed with a password the
//! user chooses for the file.
//!
//! Only the passwords and SSH key passphrases are sealed; addresses, accounts
//! and the rest of the file stay readable. Each secret travels with the
//! recipient it was saved for (a [`CredentialScope`]), and an import hands it
//! only to a bookmark with exactly that recipient: a file edited to send a
//! bookmark elsewhere leaves its password behind. That recipient is the
//! boundary of the protection. Two secrets saved for the same recipient can
//! be swapped unnoticed, and either way they reach that recipient. Only the
//! fixed header (format and KDF profile) is authenticated with the sealed
//! part, not the readable rest of the document.
//!
//! Version 1 accepts exactly one profile: Argon2id with 64 MiB, three passes,
//! one lane and a 256-bit key, and XChaCha20-Poly1305. Anything else is
//! refused before the KDF runs, so a file cannot make an import do more work.
use crate::ipc::{CommandError, ErrorCode};
use crate::security::credential_scope::CredentialScope;
use crate::security::sensitive_string::SensitiveString;
use anyhow::{Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The same minimum as the master password's.
pub const MIN_PASSWORD_CHARS: usize = 12;
/// As many as an import takes bookmarks.
pub const MAX_ENTRIES: usize = 2_000;
const MAX_SECRET_BYTES: usize = 4096;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const ALGORITHM: &str = "argon2id";
#[cfg(not(test))]
const MEMORY_KIB: u32 = 64 * 1024;
#[cfg(test)]
const MEMORY_KIB: u32 = 1024;
#[cfg(not(test))]
const ITERATIONS: u32 = 3;
#[cfg(test)]
const ITERATIONS: u32 = 1;
const PARALLELISM: u32 = 1;

/// The `formatVersion` of a document that carries a [`SecretsBlock`].
pub const FORMAT_VERSION: u32 = 2;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretsBlock {
    kdf: Kdf,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Kdf {
    algorithm: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

/// One bookmark's secrets as an export seals them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealEntry<'a> {
    /// The bookmark's id in the readable part of the same file.
    pub id: &'a str,
    pub scope: CredentialScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_passphrase: Option<&'a str>,
}

/// One bookmark's secrets as an import opens them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenedEntry {
    pub id: String,
    pub scope: CredentialScope,
    #[serde(default)]
    pub password: Option<SensitiveString>,
    #[serde(default)]
    pub key_passphrase: Option<SensitiveString>,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(CommandError::new(ErrorCode::InvalidInput, message))
}

/// The header the sealed part is bound to. Fixed by the checked profile.
fn associated_data() -> String {
    format!(
        "ftpeach-secrets|{FORMAT_VERSION}|{ALGORITHM}|{MEMORY_KIB}|{ITERATIONS}|{PARALLELISM}|xchacha20poly1305"
    )
}

pub fn validate_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(invalid(format!(
            "The export password must contain at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    Ok(())
}

async fn derive_key(password: &str, salt: Vec<u8>) -> Result<Zeroizing<Vec<u8>>> {
    let password = Zeroizing::new(password.to_owned());
    super::kdf_executor::run(move || {
        let params = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, Some(32))
            .map_err(|error| anyhow::anyhow!("invalid export KDF parameters: {error}"))?;
        let mut key = Zeroizing::new(vec![0u8; 32]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), &salt, &mut key)
            .map_err(|error| anyhow::anyhow!("deriving the export key: {error}"))?;
        Ok(key)
    })
    .await
}

fn cipher(key: &[u8]) -> Result<XChaCha20Poly1305> {
    XChaCha20Poly1305::new_from_slice(key).map_err(|_| anyhow::anyhow!("invalid export key"))
}

/// Seals `entries` with `password`. Salt and nonce are new every time.
pub async fn seal(password: &str, entries: &[SealEntry<'_>]) -> Result<SecretsBlock> {
    validate_password(password)?;
    let plain = Zeroizing::new(serde_json::to_vec(entries)?);
    let mut salt = vec![0u8; SALT_BYTES];
    let mut nonce = [0u8; NONCE_BYTES];
    getrandom::fill(&mut salt).context("generating the export salt")?;
    getrandom::fill(&mut nonce).context("generating the export nonce")?;
    let salt_text = BASE64.encode(&salt);
    let key = derive_key(password, salt).await?;
    let nonce = XNonce::try_from(nonce.as_slice()).map_err(|_| anyhow::anyhow!("invalid nonce"))?;
    let aad = associated_data();
    let sealed = cipher(&key)?
        .encrypt(
            &nonce,
            Payload {
                msg: &plain,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("sealing the exported passwords"))?;
    Ok(SecretsBlock {
        kdf: Kdf {
            algorithm: ALGORITHM.into(),
            memory_kib: MEMORY_KIB,
            iterations: ITERATIONS,
            parallelism: PARALLELISM,
            salt: salt_text,
        },
        nonce: BASE64.encode(nonce.as_slice()),
        ciphertext: BASE64.encode(sealed),
    })
}

/// Checks everything a block says about itself before a password is asked
/// for: the profile, and that salt, nonce and sealed part decode.
pub fn check(block: &SecretsBlock) -> Result<()> {
    let kdf = &block.kdf;
    if kdf.algorithm != ALGORITHM
        || kdf.memory_kib != MEMORY_KIB
        || kdf.iterations != ITERATIONS
        || kdf.parallelism != PARALLELISM
    {
        return Err(invalid(
            "secrets: the passwords are sealed in a way this version of FTPeach does not read",
        ));
    }
    let length = |text: &str| BASE64.decode(text).map(|bytes| bytes.len()).ok();
    if length(&kdf.salt) != Some(SALT_BYTES) {
        return Err(invalid("secrets.kdf.salt: invalid"));
    }
    if length(&block.nonce) != Some(NONCE_BYTES) {
        return Err(invalid("secrets.nonce: invalid"));
    }
    if length(&block.ciphertext).is_none() {
        return Err(invalid("secrets.ciphertext: invalid"));
    }
    Ok(())
}

/// Opens a block [`check`] accepted. A wrong password is `AuthFailed`;
/// anything wrong inside is a damaged file.
pub async fn open(password: &str, block: &SecretsBlock) -> Result<Vec<OpenedEntry>> {
    check(block)?;
    let salt = BASE64.decode(&block.kdf.salt)?;
    let nonce = BASE64.decode(&block.nonce)?;
    let sealed = BASE64.decode(&block.ciphertext)?;
    let key = derive_key(password, salt).await?;
    let nonce =
        XNonce::try_from(nonce.as_slice()).map_err(|_| invalid("secrets.nonce: invalid"))?;
    let aad = associated_data();
    let plain = Zeroizing::new(
        cipher(&key)?
            .decrypt(
                &nonce,
                Payload {
                    msg: &sealed,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| {
                anyhow::Error::new(CommandError::new(
                    ErrorCode::AuthFailed,
                    "The password does not open the passwords in this file",
                ))
            })?,
    );
    // Opened, so the file was sealed by someone who knew the password; what
    // is inside is still checked like the rest of the file.
    let entries: Vec<OpenedEntry> = serde_json::from_slice(&plain)
        .map_err(|error| invalid(format!("secrets: damaged contents ({error})")))?;
    if entries.len() > MAX_ENTRIES {
        return Err(invalid(format!("secrets: more than {MAX_ENTRIES} entries")));
    }
    let mut ids = std::collections::HashSet::new();
    for entry in &entries {
        if !ids.insert(entry.id.as_str()) {
            return Err(invalid(format!("secrets: {} appears twice", entry.id)));
        }
        let too_long = [&entry.password, &entry.key_passphrase]
            .into_iter()
            .flatten()
            .any(|secret| secret.expose().len() > MAX_SECRET_BYTES);
        if too_long {
            return Err(invalid(format!("secrets: {} is too long", entry.id)));
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(host: &str) -> CredentialScope {
        let site = serde_json::json!({"protocol": "ftp", "host": host, "user": "bob"});
        crate::security::credential_scope::site_scope(site.as_object().unwrap())
    }

    const PASSWORD: &str = "correct horse battery";

    async fn sealed() -> SecretsBlock {
        seal(
            PASSWORD,
            &[SealEntry {
                id: "a",
                scope: scope("a.example"),
                password: Some("secret"),
                key_passphrase: None,
            }],
        )
        .await
        .unwrap()
    }

    fn code(error: &anyhow::Error) -> ErrorCode {
        CommandError::from_anyhow(error).code
    }

    #[tokio::test]
    async fn sealed_secrets_open_with_the_password_only() {
        let block = sealed().await;
        let opened = open(PASSWORD, &block).await.unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].id, "a");
        assert_eq!(opened[0].scope, scope("a.example"));
        assert_eq!(opened[0].password.as_ref().unwrap().expose(), "secret");
        assert!(opened[0].key_passphrase.is_none());

        let wrong = open("not the password!", &block).await.err().unwrap();
        assert_eq!(code(&wrong), ErrorCode::AuthFailed);
    }

    #[tokio::test]
    async fn every_export_has_its_own_salt_and_nonce() {
        let (first, second) = (sealed().await, sealed().await);
        assert_ne!(first.kdf.salt, second.kdf.salt);
        assert_ne!(first.nonce, second.nonce);
    }

    #[tokio::test]
    async fn a_short_export_password_is_refused() {
        let error = seal("short", &[]).await.err().unwrap();
        assert_eq!(code(&error), ErrorCode::InvalidInput);
    }

    #[tokio::test]
    async fn another_kdf_profile_is_refused_before_any_work() {
        for change in [
            |block: &mut SecretsBlock| block.kdf.memory_kib *= 2,
            |block: &mut SecretsBlock| block.kdf.iterations += 1,
            |block: &mut SecretsBlock| block.kdf.parallelism = 4,
            |block: &mut SecretsBlock| block.kdf.algorithm = "argon2i".into(),
            |block: &mut SecretsBlock| block.kdf.salt = BASE64.encode([0u8; 8]),
            |block: &mut SecretsBlock| block.nonce = "not base64".into(),
        ] {
            let mut block = sealed().await;
            change(&mut block);
            assert_eq!(code(&check(&block).err().unwrap()), ErrorCode::InvalidInput);
        }
    }

    #[tokio::test]
    async fn a_changed_sealed_part_reads_as_a_wrong_password() {
        let mut block = sealed().await;
        let mut bytes = BASE64.decode(&block.ciphertext).unwrap();
        bytes[0] ^= 1;
        block.ciphertext = BASE64.encode(bytes);
        let error = open(PASSWORD, &block).await.err().unwrap();
        assert_eq!(code(&error), ErrorCode::AuthFailed);
    }

    /// Sealed by hand, so the contents can be what no export writes.
    async fn seal_raw(plain: &str) -> SecretsBlock {
        let mut block = sealed().await;
        let salt = BASE64.decode(&block.kdf.salt).unwrap();
        let key = derive_key(PASSWORD, salt).await.unwrap();
        let nonce = BASE64.decode(&block.nonce).unwrap();
        let sealed = cipher(&key)
            .unwrap()
            .encrypt(
                &XNonce::try_from(nonce.as_slice()).unwrap(),
                Payload {
                    msg: plain.as_bytes(),
                    aad: associated_data().as_bytes(),
                },
            )
            .unwrap();
        block.ciphertext = BASE64.encode(sealed);
        block
    }

    #[tokio::test]
    async fn repeated_ids_or_fields_inside_are_refused() {
        let scope = serde_json::to_string(&scope("a.example")).unwrap();
        for plain in [
            format!(r#"[{{"id":"a","scope":{scope}}},{{"id":"a","scope":{scope}}}]"#),
            format!(r#"[{{"id":"a","scope":{scope},"password":"x","password":"y"}}]"#),
            format!(r#"[{{"id":"a","scope":{scope},"comment":"x"}}]"#),
            format!(
                r#"[{{"id":"a","scope":{scope},"password":"{}"}}]"#,
                "x".repeat(5000)
            ),
        ] {
            let error = open(PASSWORD, &seal_raw(&plain).await).await.err().unwrap();
            assert_eq!(code(&error), ErrorCode::InvalidInput, "{plain}");
        }
    }
}
