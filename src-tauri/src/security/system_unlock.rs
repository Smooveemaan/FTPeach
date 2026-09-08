#[cfg(not(windows))]
use anyhow::{Result, bail};

#[cfg(windows)]
mod platform {
    use anyhow::{Context, Result};
    use windows::{
        Security::Credentials::UI::{
            UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
        },
        Win32::Foundation::HWND,
        Win32::Security::Cryptography::{
            BCRYPT_OAEP_PADDING_INFO, CERT_KEY_SPEC, MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_FLAGS,
            NCRYPT_HANDLE, NCRYPT_KEY_HANDLE, NCRYPT_LENGTH_PROPERTY, NCRYPT_PAD_OAEP_FLAG,
            NCRYPT_PROV_HANDLE, NCRYPT_RSA_ALGORITHM, NCRYPT_WINDOW_HANDLE_PROPERTY,
            NCryptCreatePersistedKey, NCryptDecrypt, NCryptDeleteKey, NCryptEncrypt,
            NCryptFinalizeKey, NCryptFreeObject, NCryptOpenKey, NCryptOpenStorageProvider,
            NCryptSetProperty,
        },
        Win32::System::WinRT::{
            IUserConsentVerifierInterop, RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize,
        },
        core::{HSTRING, PCWSTR, factory, w},
    };
    use windows_future::IAsyncOperation;

    struct WinRtApartment(bool);
    impl Drop for WinRtApartment {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: balances the one `RoInitialize` that succeeded on this
                // thread (`self.0`). The apartment lives in a `thread_local!`, so
                // this runs once, on the thread that initialized it, at thread exit.
                unsafe { RoUninitialize() };
            }
        }
    }
    thread_local! {
        // SAFETY: initializes the WinRT apartment for the calling thread. The
        // `thread_local!` initializer runs at most once per thread, and the
        // outcome is kept so `Drop` only uninitializes after a success.
        static WINRT_APARTMENT: WinRtApartment =
            WinRtApartment(unsafe { RoInitialize(RO_INIT_MULTITHREADED).is_ok() });
    }

    fn winrt_initialized() -> bool {
        WINRT_APARTMENT.with(|apartment| apartment.0)
    }

    struct Provider(NCRYPT_PROV_HANDLE);
    impl Drop for Provider {
        fn drop(&mut self) {
            // SAFETY: `self.0` is a live provider handle from a successful
            // `NCryptOpenStorageProvider`. `Provider` is its sole owner -- it is
            // neither `Copy` nor `Clone`, and the handle is not released anywhere
            // else -- so this frees it exactly once.
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.0.0));
            }
        }
    }
    struct Key(NCRYPT_KEY_HANDLE);
    impl Key {
        /// Deletes the persisted key.
        ///
        /// `NCryptDeleteKey` frees the handle itself: a handle may be passed to
        /// either it or `NCryptFreeObject`, never both. So the wrapper is
        /// forgotten rather than dropped -- letting `Drop` run here would free an
        /// already-freed handle.
        fn delete(self) -> Result<()> {
            let handle = self.0;
            std::mem::forget(self);
            // SAFETY: `handle` is a live key handle this `Key` owned, and the
            // `forget` above released it from that ownership, so nothing else
            // will free it. Flags are 0 (no `NCRYPT_SILENT_FLAG`).
            unsafe { NCryptDeleteKey(handle, 0) }.context("deleting Windows Hello credential")
        }
    }
    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: `self.0` is a live key handle from `NCryptOpenKey` or
            // `NCryptCreatePersistedKey` that `Key` solely owns. The one path
            // that releases a key by other means (`delete`) consumes `self` and
            // forgets it, so this never runs on an already-freed handle.
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.0.0));
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn provider() -> Result<Provider> {
        let mut handle = NCRYPT_PROV_HANDLE::default();
        // SAFETY: `handle` is a valid writable out-parameter, and
        // `MS_PLATFORM_CRYPTO_PROVIDER` is a 'static NUL-terminated wide string
        // from the `windows` crate. On success the handle goes straight into
        // `Provider`, which owns it from here on.
        unsafe { NCryptOpenStorageProvider(&mut handle, MS_PLATFORM_CRYPTO_PROVIDER, 0) }
            .context("Windows Hello platform key provider is unavailable")?;
        Ok(Provider(handle))
    }
    fn bind_window(key: NCRYPT_KEY_HANDLE, hwnd: isize) -> Result<()> {
        // SAFETY: `key` is a live key handle borrowed from a `Key` the caller
        // keeps alive across this call. `NCRYPT_WINDOW_HANDLE_PROPERTY` takes an
        // HWND-sized value, which is exactly the `isize` byte array below; that
        // temporary lives to the end of the statement, so past the call.
        unsafe {
            NCryptSetProperty(
                NCRYPT_HANDLE(key.0),
                NCRYPT_WINDOW_HANDLE_PROPERTY,
                &hwnd.to_ne_bytes(),
                NCRYPT_FLAGS(0),
            )
        }
        .context("binding Windows Hello prompt to the application window")
    }
    fn open(name: &str, hwnd: isize) -> Result<(Provider, Key)> {
        let provider = provider()?;
        let mut key = NCRYPT_KEY_HANDLE::default();
        let name = wide(name);
        // SAFETY: `provider.0` stays live for the call (`provider` is dropped
        // only at the end of this function), `key` is a valid writable
        // out-parameter, and `name` is NUL-terminated UTF-16 outliving the call.
        unsafe {
            NCryptOpenKey(
                provider.0,
                &mut key,
                PCWSTR(name.as_ptr()),
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
        }
        .context("Windows Hello credential is no longer available")?;
        // Take ownership before the next fallible step, so a failing
        // `bind_window` frees the handle instead of leaking it.
        let key = Key(key);
        bind_window(key.0, hwnd)?;
        Ok((provider, key))
    }

    pub fn available() -> bool {
        provider().is_ok()
            && winrt_initialized()
            && UserConsentVerifier::CheckAvailabilityAsync()
                .and_then(|operation| operation.get())
                .is_ok_and(|state| state == UserConsentVerifierAvailability::Available)
    }

    fn verify_user(hwnd: isize) -> Result<()> {
        if !winrt_initialized() {
            anyhow::bail!("Windows Hello could not be initialized");
        }
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .context("opening Windows Hello desktop interop")?;
        // SAFETY: `interop` is a live COM interface from `factory`. `hwnd` comes
        // from Tauri's own `WebviewWindow` via raw-window-handle, so it names a
        // window this process owns and keeps alive across the call. The `HSTRING`
        // temporary lives to the end of the statement, and the returned
        // `IAsyncOperation` is refcounted by the `windows` crate.
        let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(
                HWND(hwnd as *mut _),
                &HSTRING::from("Confirm system unlock for the FTPeach vault"),
            )
        }
        .context("starting Windows Hello verification")?;
        match operation
            .get()
            .context("waiting for Windows Hello verification")?
        {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => {
                anyhow::bail!("Windows Hello verification was canceled")
            }
            UserConsentVerificationResult::RetriesExhausted => {
                anyhow::bail!("Windows Hello retries were exhausted")
            }
            UserConsentVerificationResult::NotConfiguredForUser => {
                anyhow::bail!("Windows Hello is not configured for this user")
            }
            UserConsentVerificationResult::DisabledByPolicy => {
                anyhow::bail!("Windows Hello is disabled by policy")
            }
            UserConsentVerificationResult::DeviceBusy => {
                anyhow::bail!("Windows Hello authentication device is busy")
            }
            UserConsentVerificationResult::DeviceNotPresent => {
                anyhow::bail!("Windows Hello authentication device is unavailable")
            }
            _ => anyhow::bail!("Windows Hello verification failed"),
        }
    }

    pub fn register(name: &str, plaintext: &[u8], hwnd: isize) -> Result<Vec<u8>> {
        verify_user(hwnd)?;
        let provider = provider()?;
        let mut key = NCRYPT_KEY_HANDLE::default();
        let name_wide = wide(name);
        // SAFETY: `provider.0` stays live for the whole function, `key` is a
        // valid writable out-parameter, `NCRYPT_RSA_ALGORITHM` is a 'static wide
        // string from the `windows` crate, and `name_wide` is NUL-terminated
        // UTF-16 outliving the call.
        unsafe {
            NCryptCreatePersistedKey(
                provider.0,
                &mut key,
                NCRYPT_RSA_ALGORITHM,
                PCWSTR(name_wide.as_ptr()),
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
        }
        .context("creating Windows Hello credential")?;
        let key = Key(key);
        let bits: u32 = 2048;
        // SAFETY: `key` owns a live, not-yet-finalized key handle.
        // `NCRYPT_LENGTH_PROPERTY` takes a DWORD, which is exactly the `u32`
        // byte array below; that temporary lives to the end of the statement,
        // so past the call.
        unsafe {
            NCryptSetProperty(
                NCRYPT_HANDLE(key.0.0),
                NCRYPT_LENGTH_PROPERTY,
                &bits.to_ne_bytes(),
                NCRYPT_FLAGS(0),
            )
        }
        .context("configuring Windows Hello credential")?;
        bind_window(key.0, hwnd)?;
        // SAFETY: `key` owns a live key handle that is fully configured and not
        // yet finalized, which is the state `NCryptFinalizeKey` requires.
        if let Err(error) = unsafe { NCryptFinalizeKey(key.0, NCRYPT_FLAGS(0)) } {
            // Consumes `key`, so the handle is not freed twice -- see `Key::delete`.
            let _ = key.delete();
            return Err(error).context("registering Windows Hello credential");
        }
        encrypt(key.0, plaintext)
    }

    fn padding() -> BCRYPT_OAEP_PADDING_INFO {
        BCRYPT_OAEP_PADDING_INFO {
            pszAlgId: w!("SHA256"),
            pbLabel: std::ptr::null_mut(),
            cbLabel: 0,
        }
    }
    fn encrypt(key: NCRYPT_KEY_HANDLE, plaintext: &[u8]) -> Result<Vec<u8>> {
        let padding = padding();
        let mut size = 0;
        // SAFETY: `key` is a live, finalized key handle the caller keeps alive.
        // `padding` is a local outliving both calls, and its `pszAlgId` points at
        // a 'static wide literal. `None` for the output buffer is the documented
        // size query, which writes only `size`.
        unsafe {
            NCryptEncrypt(
                key,
                Some(plaintext),
                Some(&padding as *const _ as _),
                None,
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
        }
        .context("wrapping vault key with Windows Hello")?;
        let mut output = vec![0u8; size as usize];
        // SAFETY: as above, and `output` now holds exactly the `size` bytes the
        // query asked for, so the callee cannot write past its end.
        unsafe {
            NCryptEncrypt(
                key,
                Some(plaintext),
                Some(&padding as *const _ as _),
                Some(&mut output),
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
        }
        .context("wrapping vault key with Windows Hello")?;
        output.truncate(size as usize);
        Ok(output)
    }
    pub fn unwrap(name: &str, ciphertext: &[u8], hwnd: isize) -> Result<Vec<u8>> {
        verify_user(hwnd)?;
        let (_provider, key) = open(name, hwnd)?;
        let padding = padding();
        let mut size = 0;
        // SAFETY: `key` owns a live key handle, and `_provider` keeps the
        // provider that issued it alive for the whole function. `padding` is a
        // local outliving both calls, with a 'static `pszAlgId`. `None` for the
        // output buffer is the documented size query.
        unsafe {
            NCryptDecrypt(
                key.0,
                Some(ciphertext),
                Some(&padding as *const _ as _),
                None,
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
        }
        .context("Windows Hello verification was canceled or failed")?;
        let mut output = vec![0u8; size as usize];
        // SAFETY: as above, and `output` now holds exactly the `size` bytes the
        // query asked for, so the callee cannot write past its end.
        unsafe {
            NCryptDecrypt(
                key.0,
                Some(ciphertext),
                Some(&padding as *const _ as _),
                Some(&mut output),
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
        }
        .context("Windows Hello verification was canceled or failed")?;
        output.truncate(size as usize);
        Ok(output)
    }
    pub fn revoke(name: &str) -> Result<()> {
        let provider = provider()?;
        let mut key = NCRYPT_KEY_HANDLE::default();
        let name = wide(name);
        // SAFETY: `provider.0` stays live for the whole function, `key` is a
        // valid writable out-parameter, and `name` is NUL-terminated UTF-16
        // outliving the call.
        unsafe {
            NCryptOpenKey(
                provider.0,
                &mut key,
                PCWSTR(name.as_ptr()),
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
        }
        .context("opening Windows Hello credential")?;
        Key(key).delete()
    }
}

#[cfg(windows)]
pub use platform::*;

#[cfg(not(windows))]
pub fn available() -> bool {
    false
}
#[cfg(not(windows))]
pub fn register(_: &str, _: &[u8], _: isize) -> Result<Vec<u8>> {
    bail!("system unlock is unavailable on this platform")
}
#[cfg(not(windows))]
pub fn unwrap(_: &str, _: &[u8], _: isize) -> Result<Vec<u8>> {
    bail!("system unlock is unavailable on this platform")
}
#[cfg(not(windows))]
pub fn revoke(_: &str) -> Result<()> {
    bail!("system unlock is unavailable on this platform")
}
