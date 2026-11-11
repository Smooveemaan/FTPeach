#[cfg(not(any(windows, target_os = "macos")))]
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
            NCRYPT_PROV_HANDLE, NCRYPT_RSA_ALGORITHM, NCRYPT_SILENT_FLAG,
            NCRYPT_WINDOW_HANDLE_PROPERTY, NCryptCreatePersistedKey, NCryptDecrypt,
            NCryptDeleteKey, NCryptEncrypt, NCryptFinalizeKey, NCryptFreeObject, NCryptOpenKey,
            NCryptOpenStorageProvider, NCryptSetProperty,
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
                .and_then(|operation| operation.join())
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
            .join()
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
    /// Whether this computer's platform provider holds the key `name`. A
    /// provider that cannot be opened holds nothing.
    pub fn exists(name: &str) -> bool {
        let Ok(provider) = provider() else {
            return false;
        };
        let mut key = NCRYPT_KEY_HANDLE::default();
        let name = wide(name);
        // SAFETY: `provider.0` stays live for the whole function, `key` is a
        // valid writable out-parameter, and `name` is NUL-terminated UTF-16
        // outliving the call. `NCRYPT_SILENT_FLAG` keeps Windows from asking
        // the user anything.
        let opened = unsafe {
            NCryptOpenKey(
                provider.0,
                &mut key,
                PCWSTR(name.as_ptr()),
                CERT_KEY_SPEC(0),
                NCRYPT_SILENT_FLAG,
            )
        };
        // The handle is owned from here, so it is freed, not leaked.
        opened.map(|()| Key(key)).is_ok()
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

#[cfg(target_os = "macos")]
mod macos {
    use anyhow::{Context, Result, bail, ensure};
    use sha2::{Digest, Sha256};
    use std::ffi::c_void;

    #[allow(dead_code)]
    pub const TOUCH_ID_SCHEME: &str = "touch-id-v1";
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;
    const K_SEC_ACCESS_CONTROL_USER_PRESENCE: usize = 1 << 0;

    #[link(name = "Security", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    #[link(name = "LocalAuthentication", kind = "framework")]
    unsafe extern "C" {
        static kSecClass: *const c_void;
        static kSecClassGenericPassword: *const c_void;
        static kSecUseDataProtectionKeychain: *const c_void;
        static kSecAttrService: *const c_void;
        static kSecAttrAccount: *const c_void;
        static kSecAttrAccessControl: *const c_void;
        static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: *const c_void;
        static kSecValueData: *const c_void;
        static kSecReturnData: *const c_void;
        static kSecReturnAttributes: *const c_void;
        static kSecMatchLimit: *const c_void;
        static kSecMatchLimitOne: *const c_void;
        static kSecUseAuthenticationUI: *const c_void;
        static kSecUseAuthenticationUIFail: *const c_void;
        static kSecUseOperationPrompt: *const c_void;

        fn SecAccessControlCreateWithFlags(
            allocator: *const c_void,
            protection: *const c_void,
            flags: usize,
            error: *mut *const c_void,
        ) -> *const c_void;

        fn SecItemAdd(attributes: *const c_void, result: *mut *const c_void) -> i32;
        fn SecItemCopyMatching(query: *const c_void, result: *mut *const c_void) -> i32;
        fn SecItemDelete(query: *const c_void) -> i32;

        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        static kCFBooleanTrue: *const c_void;

        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;

        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const std::ffi::c_char,
            encoding: u32,
        ) -> *const c_void;

        fn CFDataCreate(allocator: *const c_void, bytes: *const u8, length: isize)
        -> *const c_void;
        fn CFDataGetLength(the_data: *const c_void) -> isize;
        fn CFDataGetBytePtr(the_data: *const c_void) -> *const u8;

        fn CFRelease(cf: *const c_void);

        fn objc_getClass(name: *const std::ffi::c_char) -> *const c_void;
        fn sel_registerName(name: *const std::ffi::c_char) -> *const c_void;
        fn objc_msgSend();
    }

    struct CfRef(*const c_void);
    impl Drop for CfRef {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: self.0 is a non-null retained CoreFoundation object owned solely by this CfRef.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn cf_string(s: &str) -> Result<CfRef> {
        let c_str = std::ffi::CString::new(s).context("converting string to CString")?;
        // SAFETY: CFStringCreateWithCString allocates a retained CFStringRef from a valid NUL-terminated C string.
        let ptr = unsafe {
            CFStringCreateWithCString(std::ptr::null(), c_str.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if ptr.is_null() {
            bail!("allocating CFString failed");
        }
        Ok(CfRef(ptr))
    }

    fn cf_data(bytes: &[u8]) -> Result<CfRef> {
        // SAFETY: CFDataCreate allocates a retained CFDataRef copying bytes from the slice.
        let ptr = unsafe { CFDataCreate(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize) };
        if ptr.is_null() {
            bail!("allocating CFData failed");
        }
        Ok(CfRef(ptr))
    }

    fn cf_dictionary(keys: &[*const c_void], values: &[*const c_void]) -> Result<CfRef> {
        ensure!(keys.len() == values.len(), "keys and values count mismatch");
        // SAFETY: CFDictionaryCreate retains each key and value using standard CF callbacks.
        let ptr = unsafe {
            CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                keys.len() as isize,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )
        };
        if ptr.is_null() {
            bail!("allocating CFDictionary failed");
        }
        Ok(CfRef(ptr))
    }

    fn service_name() -> Result<CfRef> {
        let service = format!("{}.vault", crate::app_config::identifier());
        cf_string(&service)
    }

    pub fn available() -> bool {
        // SAFETY: Invokes [LAContext canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:]
        // via Objective-C runtime message dispatch. All object pointers are checked non-null.
        unsafe {
            let cls = objc_getClass(c"LAContext".as_ptr());
            if cls.is_null() {
                return false;
            }
            let sel_alloc = sel_registerName(c"alloc".as_ptr());
            let sel_init = sel_registerName(c"init".as_ptr());
            let sel_can_eval = sel_registerName(c"canEvaluatePolicy:error:".as_ptr());
            let sel_release = sel_registerName(c"release".as_ptr());

            let msg_send_id: unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_void =
                std::mem::transmute(objc_msgSend as *const ());
            let ctx = msg_send_id(cls, sel_alloc);
            if ctx.is_null() {
                return false;
            }
            let ctx = msg_send_id(ctx, sel_init);
            if ctx.is_null() {
                return false;
            }

            let msg_send_can: unsafe extern "C" fn(
                *const c_void,
                *const c_void,
                isize,
                *mut *const c_void,
            ) -> u8 = std::mem::transmute(objc_msgSend as *const ());

            let mut error: *const c_void = std::ptr::null();
            // LAPolicyDeviceOwnerAuthentication = 2: Touch ID or Mac user password.
            let can_eval = msg_send_can(ctx, sel_can_eval, 2, &mut error);

            let msg_send_void: unsafe extern "C" fn(*const c_void, *const c_void) =
                std::mem::transmute(objc_msgSend as *const ());
            msg_send_void(ctx, sel_release);

            can_eval != 0
        }
    }

    pub fn exists(name: &str) -> bool {
        let Ok(service) = service_name() else {
            return false;
        };
        let Ok(account) = cf_string(name) else {
            return false;
        };
        // SAFETY: Queries Keychain item attributes with UI forbidden to test presence silently.
        unsafe {
            let keys = [
                kSecClass,
                kSecUseDataProtectionKeychain,
                kSecAttrService,
                kSecAttrAccount,
                kSecReturnAttributes,
                kSecMatchLimit,
                kSecUseAuthenticationUI,
            ];
            let values = [
                kSecClassGenericPassword,
                kCFBooleanTrue,
                service.0,
                account.0,
                kCFBooleanTrue,
                kSecMatchLimitOne,
                kSecUseAuthenticationUIFail,
            ];
            let Ok(dict) = cf_dictionary(&keys, &values) else {
                return false;
            };
            let mut result: *const c_void = std::ptr::null();
            let status = SecItemCopyMatching(dict.0, &mut result);
            if !result.is_null() {
                CFRelease(result);
            }
            // 0 (errSecSuccess), -25293 (errSecAuthFailed), or -25308 (errSecInteractionNotAllowed)
            status == 0 || status == -25293 || status == -25308
        }
    }

    pub fn register(name: &str, plaintext: &[u8], _hwnd: isize) -> Result<Vec<u8>> {
        let service = service_name()?;
        let account = cf_string(name)?;
        let value = cf_data(plaintext)?;

        // SAFETY: Creates access control requiring user presence (Touch ID or device passcode).
        let ptr = unsafe {
            let mut error: *const c_void = std::ptr::null();
            SecAccessControlCreateWithFlags(
                std::ptr::null(),
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                K_SEC_ACCESS_CONTROL_USER_PRESENCE,
                &mut error,
            )
        };
        if ptr.is_null() {
            bail!("creating access control for Keychain item failed");
        }
        let access = CfRef(ptr);

        let _ = revoke(name);

        // SAFETY: Adds Keychain generic password item sealed with user presence access control.
        let status = unsafe {
            let keys = [
                kSecClass,
                kSecUseDataProtectionKeychain,
                kSecAttrService,
                kSecAttrAccount,
                kSecAttrAccessControl,
                kSecValueData,
            ];
            let values = [
                kSecClassGenericPassword,
                kCFBooleanTrue,
                service.0,
                account.0,
                access.0,
                value.0,
            ];
            let dict = cf_dictionary(&keys, &values)?;
            SecItemAdd(dict.0, std::ptr::null_mut())
        };
        if status != 0 {
            if status == -34018 {
                bail!(
                    "registering Touch ID credential in Keychain failed: errSecMissingEntitlement (-34018; Touch ID requires a signed application with Keychain entitlements and a matching provisioning profile)"
                );
            }
            bail!("registering Touch ID credential in Keychain failed: SecItemAdd status {status}");
        }

        let wrapped = Sha256::digest(plaintext).to_vec();
        // Confirm access to the protected item before enabling system unlock.
        super::confirm_registration(|| unwrap(name, &wrapped, 0).map(|_| ()), || revoke(name))?;
        Ok(wrapped)
    }

    pub fn unwrap(name: &str, ciphertext: &[u8], _hwnd: isize) -> Result<Vec<u8>> {
        let service = service_name()?;
        let account = cf_string(name)?;
        let prompt = cf_string("Confirm system unlock for the FTPeach vault")?;

        // SAFETY: SecItemCopyMatching prompts user for biometric or passcode via kSecAccessControlUserPresence.
        let (result_ptr, status) = unsafe {
            let keys = [
                kSecClass,
                kSecUseDataProtectionKeychain,
                kSecAttrService,
                kSecAttrAccount,
                kSecReturnData,
                kSecMatchLimit,
                kSecUseOperationPrompt,
            ];
            let values = [
                kSecClassGenericPassword,
                kCFBooleanTrue,
                service.0,
                account.0,
                kCFBooleanTrue,
                kSecMatchLimitOne,
                prompt.0,
            ];
            let dict = cf_dictionary(&keys, &values)?;
            let mut result: *const c_void = std::ptr::null();
            let status = SecItemCopyMatching(dict.0, &mut result);
            (result, status)
        };
        if status != 0 || result_ptr.is_null() {
            if status == -34018 {
                bail!(
                    "Touch ID verification failed: errSecMissingEntitlement (-34018; Touch ID requires a signed application with Keychain entitlements and a matching provisioning profile)"
                );
            }
            if status == -128 {
                bail!("Touch ID verification was canceled");
            }
            bail!("Touch ID verification was canceled or failed (status {status})");
        }
        let result = CfRef(result_ptr);
        let (len, ptr) = unsafe { (CFDataGetLength(result.0), CFDataGetBytePtr(result.0)) };
        if len <= 0 || ptr.is_null() {
            bail!("invalid key data in Keychain");
        }
        let data = unsafe { std::slice::from_raw_parts(ptr, len as usize).to_vec() };

        if !ciphertext.is_empty() {
            let digest = Sha256::digest(&data);
            if digest.as_slice() != ciphertext {
                bail!("Keychain credential does not match the expected vault key");
            }
        }
        Ok(data)
    }

    pub fn revoke(name: &str) -> Result<()> {
        let service = service_name()?;
        let account = cf_string(name)?;
        // SAFETY: Deletes matching generic password item from Keychain without user prompt.
        let status = unsafe {
            let keys = [
                kSecClass,
                kSecUseDataProtectionKeychain,
                kSecAttrService,
                kSecAttrAccount,
            ];
            let values = [
                kSecClassGenericPassword,
                kCFBooleanTrue,
                service.0,
                account.0,
            ];
            let dict = cf_dictionary(&keys, &values)?;
            SecItemDelete(dict.0)
        };
        if status != 0 && status != -25300
        /* errSecItemNotFound */
        {
            bail!(
                "deleting Touch ID credential from Keychain failed: SecItemDelete status {status}"
            );
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use macos::*;

/// The computer's key store as the vault uses it. A vault can be carried to
/// another computer; its keys cannot, so the vault asks which of its
/// credentials this computer holds. Tests stand in for Windows Hello here.
pub const HELLO_SCHEME: &str = "windows-hello-v1";
#[allow(dead_code)]
pub const TOUCH_ID_SCHEME: &str = "touch-id-v1";

pub trait Keys: Send + Sync {
    /// The scheme identifier for this provider (e.g. "windows-hello-v1" or "touch-id-v1").
    fn scheme(&self) -> &'static str {
        HELLO_SCHEME
    }
    /// Whether this computer holds the key named `name`. Asks nothing of the user.
    fn exists(&self, name: &str) -> bool;
    fn register(&self, name: &str, plaintext: &[u8], hwnd: isize) -> anyhow::Result<Vec<u8>>;
    fn unwrap(&self, name: &str, ciphertext: &[u8], hwnd: isize) -> anyhow::Result<Vec<u8>>;
    fn revoke(&self, name: &str) -> anyhow::Result<()>;
}

/// Windows Hello and the Microsoft Platform Crypto Provider.
pub struct PlatformKeys;

impl Keys for PlatformKeys {
    fn scheme(&self) -> &'static str {
        #[cfg(target_os = "macos")]
        {
            TOUCH_ID_SCHEME
        }
        #[cfg(not(target_os = "macos"))]
        {
            HELLO_SCHEME
        }
    }
    fn exists(&self, name: &str) -> bool {
        exists(name)
    }
    fn register(&self, name: &str, plaintext: &[u8], hwnd: isize) -> anyhow::Result<Vec<u8>> {
        register(name, plaintext, hwnd)
    }
    fn unwrap(&self, name: &str, ciphertext: &[u8], hwnd: isize) -> anyhow::Result<Vec<u8>> {
        unwrap(name, ciphertext, hwnd)
    }
    fn revoke(&self, name: &str) -> anyhow::Result<()> {
        revoke(name)
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn available() -> bool {
    false
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn exists(_: &str) -> bool {
    false
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn register(_: &str, _: &[u8], _: isize) -> Result<Vec<u8>> {
    bail!("system unlock is unavailable on this platform")
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn unwrap(_: &str, _: &[u8], _: isize) -> Result<Vec<u8>> {
    bail!("system unlock is unavailable on this platform")
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn revoke(_: &str) -> Result<()> {
    bail!("system unlock is unavailable on this platform")
}

#[cfg(test)]
mod tests {
    /// Asked of the real key store: a name nobody registered is not there,
    /// and asking shows no prompt, with or without a platform provider.
    #[test]
    fn a_key_nobody_registered_does_not_exist() {
        let name = format!("FTPeach-vault-test-{}", uuid::Uuid::new_v4());
        assert!(!super::exists(&name));
    }

    #[test]
    fn platform_keys_scheme_matches_expected() {
        #[cfg(not(target_os = "macos"))]
        use super::HELLO_SCHEME;
        use super::Keys;
        #[cfg(target_os = "macos")]
        use super::TOUCH_ID_SCHEME;
        let keys = super::PlatformKeys;
        #[cfg(target_os = "macos")]
        assert_eq!(keys.scheme(), TOUCH_ID_SCHEME);
        #[cfg(not(target_os = "macos"))]
        assert_eq!(keys.scheme(), HELLO_SCHEME);
    }
}

#[cfg(any(target_os = "macos", test))]
fn confirm_registration(
    confirm: impl FnOnce() -> anyhow::Result<()>,
    revoke: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    if let Err(error) = confirm() {
        let _ = revoke();
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod registration_tests {
    use super::confirm_registration;

    #[test]
    fn failed_confirmation_revokes_the_new_credential() {
        let mut revoked = false;
        let error = confirm_registration(
            || anyhow::bail!("authentication cancelled"),
            || {
                revoked = true;
                anyhow::bail!("cleanup failed")
            },
        )
        .unwrap_err();
        assert!(revoked);
        assert_eq!(error.to_string(), "authentication cancelled");
    }

    #[test]
    fn confirmed_credential_is_kept() {
        confirm_registration(|| Ok(()), || panic!("confirmed credential must remain")).unwrap();
    }
}
