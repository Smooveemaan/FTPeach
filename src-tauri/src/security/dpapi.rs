//! Secret encryption for saved-site passwords/passphrases.
//!
//! Deliberately a fresh DPAPI scheme (`CryptProtectData`/`CryptUnprotectData`
//! straight over the plaintext), not a byte-compatible reimplementation of
//! Electron's `safeStorage`. That would mean reproducing Chromium's
//! `os_crypt`: a `v11`-prefixed AES-128-CBC ciphertext (fixed IV) under a
//! master key that's itself DPAPI-protected and stored in a separate `Local
//! State` file — real work, not "call CryptProtectData once", and not worth
//! it for entries this app can just ask the user to re-enter. Anything
//! already encrypted by the Electron build's `safeStorage` will not decrypt
//! under this scheme; store.rs's `decrypt_secret` treats that as "no secret
//! saved" (see its comment) rather than a hard error.

use anyhow::Result;

#[cfg(not(windows))]
pub fn protect(_data: &[u8]) -> Result<Vec<u8>> {
    anyhow::bail!("DPAPI is only available on Windows")
}

#[cfg(not(windows))]
pub fn unprotect(_data: &[u8]) -> Result<Vec<u8>> {
    anyhow::bail!("DPAPI is only available on Windows")
}

#[cfg(windows)]
use anyhow::Context as _;
#[cfg(windows)]
use windows::Win32::Foundation::LocalFree;
#[cfg(windows)]
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
};
#[cfg(windows)]
use windows::core::PCWSTR;

#[cfg(windows)]
const ENTROPY: &[u8] = b"FTPeach/dpapi-entropy/v1";

#[cfg(windows)]
fn entropy_blob() -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr() as *mut u8,
    }
}

#[cfg(windows)]
pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let entropy = entropy_blob();
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(
            &input,
            PCWSTR::null(),
            Some(&entropy),
            None,
            None,
            0,
            &mut output,
        )
        .context("CryptProtectData failed")?;
        Ok(take_blob(output))
    }
}

#[cfg(windows)]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let entropy = entropy_blob();
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&input, None, Some(&entropy), None, None, 0, &mut output)
            .context("CryptUnprotectData failed")?;
        Ok(take_blob(output))
    }
}

#[cfg(windows)]
unsafe fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    unsafe {
        let bytes = if blob.pbData.is_null() || blob.cbData == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
        };
        if !blob.pbData.is_null() {
            std::ptr::write_bytes(blob.pbData, 0, blob.cbData as usize);
            let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                blob.pbData as *mut _,
            )));
        }
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_and_unprotects_secret_bytes_when_dpapi_profile_is_available() {
        let secret = b"ftpeach-dpapi-round-trip";

        let protected = match protect(secret) {
            Ok(protected) => protected,
            Err(error) => {
                eprintln!("DPAPI profile unavailable; round-trip skipped: {error:#}");
                return;
            }
        };
        let recovered = unprotect(&protected).unwrap();

        assert_ne!(protected, secret);
        assert_eq!(recovered, secret);
    }

    #[test]
    fn rejects_data_that_is_not_a_dpapi_blob() {
        assert!(unprotect(b"not-a-dpapi-payload").is_err());
    }
}
