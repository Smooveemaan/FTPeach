//! Reads the `vault.hold` snapshot FTPeach 0.5 and earlier wrote with
//! Stronghold 2.1, once, so its secrets move into the current vault file.
//! Only what FTPeach ever put there is understood: one client whose store
//! holds the secrets, no Stronghold vault records.
//!
//! The layers, outside in: `PARTI` and version 3.0; an age v1 file with one
//! scrypt recipient whose passphrase is the 32-byte vault key; an LZ4 block;
//! the bincode 1 encoding of the client state.

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD as BASE64};
use chacha20poly1305::{ChaCha20Poly1305, Nonce, aead::Aead, aead::KeyInit};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

pub(crate) type Secrets = BTreeMap<Vec<u8>, Zeroizing<Vec<u8>>>;

const HEADER: &[u8] = b"PARTI\x03\x00";
/// FTPeach always wrote with work factor 0, its key being random; the bound
/// only keeps a hostile file from asking for gigabytes.
const MAX_WORK_FACTOR: u8 = 16;
const CHUNK: usize = 64 * 1024;
const TAG: usize = 16;
/// Far beyond any real vault; a bound on what the decompressor may produce.
const MAX_PLAIN: usize = 64 * 1024 * 1024;

pub(crate) fn read(file: &[u8], key: &[u8]) -> Result<Secrets> {
    let age = file
        .strip_prefix(HEADER)
        .context("not a Stronghold 2 snapshot")?;
    let compressed = decrypt_age(age, key)?;
    let state = decompress(&compressed)?;
    parse_state(&state)
}

fn line(input: &mut &[u8]) -> Result<Vec<u8>> {
    let end = input
        .iter()
        .position(|&b| b == b'\n')
        .context("damaged snapshot header")?;
    let line = input[..end].to_vec();
    *input = &input[end + 1..];
    Ok(line)
}

fn decrypt_age(age: &[u8], key: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let mut rest = age;
    ensure!(
        line(&mut rest)? == b"age-encryption.org/v1",
        "damaged snapshot header"
    );
    let stanza = line(&mut rest)?;
    let stanza = stanza
        .strip_prefix(b"-> scrypt ")
        .context("damaged snapshot header")?;
    let (salt, work_factor) = std::str::from_utf8(stanza)
        .ok()
        .and_then(|stanza| stanza.split_once(' '))
        .context("damaged snapshot header")?;
    let salt = BASE64.decode(salt).context("damaged snapshot header")?;
    let work_factor: u8 = work_factor.parse().context("damaged snapshot header")?;
    ensure!(
        salt.len() == 16 && work_factor <= MAX_WORK_FACTOR,
        "damaged snapshot header"
    );
    let body = BASE64
        .decode(line(&mut rest)?)
        .context("damaged snapshot header")?;
    // The MAC covers the header up to and including `---`.
    let mac_start = age.len() - rest.len();
    let mac_line = line(&mut rest)?;
    let mac = BASE64
        .decode(
            mac_line
                .strip_prefix(b"--- ")
                .context("damaged snapshot header")?,
        )
        .context("damaged snapshot header")?;

    let mut scrypt_salt = b"age-encryption.org/v1/scrypt".to_vec();
    scrypt_salt.extend_from_slice(&salt);
    let mut wrap_key = Zeroizing::new([0u8; 32]);
    let params = scrypt::Params::new(work_factor, 8, 1).map_err(|_| anyhow!("snapshot KDF"))?;
    scrypt::scrypt(key, &scrypt_salt, &params, wrap_key.as_mut_slice())
        .map_err(|_| anyhow!("snapshot KDF"))?;
    let file_key = Zeroizing::new(
        ChaCha20Poly1305::new_from_slice(wrap_key.as_slice())
            .map_err(|_| anyhow!("snapshot key"))?
            .decrypt(&Nonce::default(), body.as_slice())
            .map_err(|_| anyhow!("the snapshot does not open with this vault key"))?,
    );
    ensure!(file_key.len() == 16, "damaged snapshot header");

    let mut hmac_key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, &file_key)
        .expand(b"header", hmac_key.as_mut_slice())
        .map_err(|_| anyhow!("snapshot key"))?;
    let mut hmac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(hmac_key.as_slice())
        .map_err(|_| anyhow!("snapshot key"))?;
    hmac.update(&age[..mac_start + 3]);
    hmac.verify_slice(&mac)
        .map_err(|_| anyhow!("damaged snapshot header"))?;

    ensure!(rest.len() >= 16 + TAG, "damaged snapshot");
    let (nonce, mut payload) = rest.split_at(16);
    let mut payload_key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(nonce), &file_key)
        .expand(b"payload", payload_key.as_mut_slice())
        .map_err(|_| anyhow!("snapshot key"))?;
    let cipher = ChaCha20Poly1305::new_from_slice(payload_key.as_slice())
        .map_err(|_| anyhow!("snapshot key"))?;
    let mut plain = Zeroizing::new(Vec::with_capacity(payload.len()));
    let mut counter = 0u128;
    loop {
        let size = payload.len().min(CHUNK + TAG);
        ensure!(size >= TAG, "damaged snapshot");
        let last = size == payload.len();
        let mut chunk_nonce = Nonce::default();
        chunk_nonce[..11].copy_from_slice(&counter.to_be_bytes()[5..]);
        chunk_nonce[11] = u8::from(last);
        let chunk = Zeroizing::new(
            cipher
                .decrypt(&chunk_nonce, &payload[..size])
                .map_err(|_| anyhow!("damaged snapshot"))?,
        );
        plain.extend_from_slice(&chunk);
        payload = &payload[size..];
        if last {
            return Ok(plain);
        }
        counter += 1;
    }
}

/// An LZ4 block as Stronghold's own encoder wrote it: the last sequence may
/// end after its literals.
fn decompress(mut input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    fn take<'a>(input: &mut &'a [u8], size: usize) -> Result<&'a [u8]> {
        ensure!(input.len() >= size, "damaged snapshot contents");
        let (head, tail) = input.split_at(size);
        *input = tail;
        Ok(head)
    }
    fn length(input: &mut &[u8], mut value: usize) -> Result<usize> {
        if value == 15 {
            loop {
                let extra = take(input, 1)?[0];
                value += usize::from(extra);
                if extra != 0xFF {
                    break;
                }
            }
        }
        Ok(value)
    }
    // Room for the usual ratio up front: a reallocation leaves a copy behind.
    let mut output = Zeroizing::new(Vec::with_capacity(input.len() * 2));
    while !input.is_empty() {
        let token = take(&mut input, 1)?[0];
        let literal = length(&mut input, usize::from(token >> 4))?;
        output.extend_from_slice(take(&mut input, literal)?);
        if input.is_empty() {
            break;
        }
        let offset = usize::from(u16::from_le_bytes(
            take(&mut input, 2)?.try_into().expect("two bytes"),
        ));
        let size = length(&mut input, usize::from(token & 0xF))? + 4;
        ensure!(
            offset != 0 && offset <= output.len() && output.len() + size <= MAX_PLAIN,
            "damaged snapshot contents"
        );
        // Byte by byte: the copy may overlap what it is producing.
        let start = output.len() - offset;
        for i in start..start + size {
            let byte = output[i];
            output.push(byte);
        }
    }
    Ok(output)
}

/// `HashMap<ClientId, (HashMap<VaultId, Key>, DbView, Cache<Vec<u8>, Vec<u8>>)>`
/// in bincode 1: lengths are u64, little-endian.
fn parse_state(mut input: &[u8]) -> Result<Secrets> {
    fn take<'a>(input: &mut &'a [u8], size: usize) -> Result<&'a [u8]> {
        ensure!(input.len() >= size, "damaged snapshot contents");
        let (head, tail) = input.split_at(size);
        *input = tail;
        Ok(head)
    }
    fn length(input: &mut &[u8]) -> Result<usize> {
        let value = u64::from_le_bytes(take(input, 8)?.try_into().expect("eight bytes"));
        usize::try_from(value).context("damaged snapshot contents")
    }
    let input = &mut input;
    ensure!(length(input)? == 1, "unexpected snapshot contents");
    take(input, 24)?; // ClientId
    ensure!(
        length(input)? == 0 && length(input)? == 0,
        "the snapshot holds Stronghold vault records, which FTPeach never wrote"
    );
    let mut secrets = Secrets::new();
    for _ in 0..length(input)? {
        let size = length(input)?;
        let key = take(input, size)?.to_vec();
        let size = length(input)?;
        let value = Zeroizing::new(take(input, size)?.to_vec());
        match take(input, 1)?[0] {
            0 => {}
            // An expiry FTPeach never set: seconds and nanoseconds.
            1 => {
                take(input, 12)?;
            }
            _ => bail!("damaged snapshot contents"),
        }
        secrets.insert(key, value);
    }
    Ok(secrets)
}

#[cfg(test)]
#[path = "stronghold_snapshot_tests.rs"]
mod tests;
