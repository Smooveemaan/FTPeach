//! `vault.dat`: the vault's secrets, sealed with its 32-byte data key.
//!
//! `FTPV`, a format version byte, a random 24-byte nonce, then
//! XChaCha20-Poly1305 over the entries with those first five bytes as
//! associated data. An entry is a little-endian u32 length and the name,
//! then the same for the value. The whole file is rewritten on every change.

use super::stronghold_snapshot::Secrets;
use anyhow::{Context, Result, anyhow, ensure};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::Zeroizing;

const HEADER: &[u8] = b"FTPV\x01";
const NONCE: usize = 24;

pub(crate) fn seal(secrets: &Secrets, key: &[u8]) -> Result<Vec<u8>> {
    let mut plain = Zeroizing::new(Vec::with_capacity(
        secrets
            .iter()
            .map(|(name, value)| 8 + name.len() + value.len())
            .sum(),
    ));
    for (name, value) in secrets {
        for part in [name.as_slice(), value.as_slice()] {
            let size = u32::try_from(part.len()).context("vault secret too large")?;
            plain.extend_from_slice(&size.to_le_bytes());
            plain.extend_from_slice(part);
        }
    }
    let mut nonce = [0u8; NONCE];
    getrandom::fill(&mut nonce).context("generating vault nonce")?;
    let sealed = cipher(key)?
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &plain,
                aad: HEADER,
            },
        )
        .map_err(|_| anyhow!("sealing vault"))?;
    Ok([HEADER, &nonce, &sealed].concat())
}

pub(crate) fn open(file: &[u8], key: &[u8]) -> Result<Secrets> {
    let rest = file
        .strip_prefix(HEADER)
        .context("unsupported vault file version")?;
    ensure!(rest.len() >= NONCE, "damaged vault");
    let (nonce, sealed) = rest.split_at(NONCE);
    let plain = Zeroizing::new(
        cipher(key)?
            .decrypt(
                &XNonce::try_from(nonce).map_err(|_| anyhow!("damaged vault"))?,
                Payload {
                    msg: sealed,
                    aad: HEADER,
                },
            )
            .map_err(|_| anyhow!("damaged vault"))?,
    );
    fn part(input: &mut &[u8]) -> Result<Vec<u8>> {
        let (size, rest) = input.split_at_checked(4).context("damaged vault")?;
        let size = u32::from_le_bytes(size.try_into().expect("four bytes")) as usize;
        let (part, rest) = rest.split_at_checked(size).context("damaged vault")?;
        *input = rest;
        Ok(part.to_vec())
    }
    let mut input = plain.as_slice();
    let mut secrets = Secrets::new();
    while !input.is_empty() {
        let name = part(&mut input)?;
        secrets.insert(name, Zeroizing::new(part(&mut input)?));
    }
    Ok(secrets)
}

fn cipher(key: &[u8]) -> Result<XChaCha20Poly1305> {
    XChaCha20Poly1305::new_from_slice(key).map_err(|_| anyhow!("invalid vault key"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_secrets_open_only_with_their_key_and_untouched() {
        let mut secrets = Secrets::new();
        secrets.insert(b"site:a:password".to_vec(), Zeroizing::new(b"one".to_vec()));
        secrets.insert(b"empty".to_vec(), Zeroizing::new(Vec::new()));
        let file = seal(&secrets, &[1; 32]).unwrap();
        assert_eq!(open(&file, &[1; 32]).unwrap(), secrets);
        assert!(
            open(&seal(&Secrets::new(), &[1; 32]).unwrap(), &[1; 32])
                .unwrap()
                .is_empty()
        );
        assert!(open(&file, &[2; 32]).is_err());
        for position in [4, 5, file.len() - 1] {
            let mut damaged = file.clone();
            damaged[position] ^= 1;
            assert!(open(&damaged, &[1; 32]).is_err(), "{position}");
        }
        assert!(open(&file[..20], &[1; 32]).is_err());
    }
}
