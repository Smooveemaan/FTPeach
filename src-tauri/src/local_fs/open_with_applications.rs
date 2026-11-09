//! Discovers applications that can open a file or extension for the Open with menu.
//! On macOS, uses LaunchServices (LSCopyDefaultApplicationURLForURL, LSCopyApplicationURLsForURL,
//! and LSCopyDisplayNameForURL). On other platforms, returns an empty list.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCandidate {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::ApplicationCandidate;
    use std::ffi::{CStr, CString, c_void};
    use std::path::{Path, PathBuf};

    #[link(name = "CoreServices", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateWithFileSystemPath(
            allocator: *const c_void,
            file_path: *const c_void,
            path_style: isize,
            is_directory: u8,
        ) -> *const c_void;
        fn CFURLCopyFileSystemPath(an_url: *const c_void, path_style: isize) -> *const c_void;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const std::ffi::c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFStringGetLength(the_string: *const c_void) -> isize;
        fn CFStringGetCString(
            the_string: *const c_void,
            buffer: *mut std::ffi::c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
        fn CFArrayGetCount(the_array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(the_array: *const c_void, idx: isize) -> *const c_void;
        fn CFRelease(cf: *const c_void);

        fn LSCopyDefaultApplicationURLForURL(
            in_url: *const c_void,
            in_role_mask: u32,
            out_error: *mut *const c_void,
        ) -> *const c_void;
        fn LSCopyApplicationURLsForURL(in_url: *const c_void, in_role_mask: u32) -> *const c_void;
        fn LSCopyDisplayNameForURL(
            in_url: *const c_void,
            out_display_name: *mut *const c_void,
        ) -> i32;
    }

    const K_CFURL_POSIX_PATH_STYLE: isize = 0;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;
    const K_LS_ROLES_ALL: u32 = 0xFFFFFFFF;

    struct CfRef(*const c_void);
    impl Drop for CfRef {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: self.0 is a non-null retained CoreFoundation object.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn cf_string_to_string(cf_str: *const c_void) -> Option<String> {
        if cf_str.is_null() {
            return None;
        }
        // SAFETY: Queries the UTF-8 representation of the CFStringRef into a sized buffer.
        unsafe {
            let len = CFStringGetLength(cf_str);
            let max_bytes = (len * 4 + 1) as usize;
            let mut buf = vec![0u8; max_bytes];
            let ok = CFStringGetCString(
                cf_str,
                buf.as_mut_ptr() as *mut _,
                max_bytes as isize,
                K_CF_STRING_ENCODING_UTF8,
            );
            if ok != 0 {
                CStr::from_ptr(buf.as_ptr() as *const _)
                    .to_str()
                    .ok()
                    .map(str::to_owned)
            } else {
                None
            }
        }
    }

    fn cf_url_to_path(cf_url: *const c_void) -> Option<PathBuf> {
        if cf_url.is_null() {
            return None;
        }
        // SAFETY: CFURLCopyFileSystemPath returns a retained CFStringRef (Create Rule).
        let path_cf = unsafe { CFURLCopyFileSystemPath(cf_url, K_CFURL_POSIX_PATH_STYLE) };
        if path_cf.is_null() {
            return None;
        }
        let _guard = CfRef(path_cf);
        cf_string_to_string(path_cf).map(PathBuf::from)
    }

    fn display_name_for_url(cf_url: *const c_void, fallback_path: &Path) -> String {
        let mut display_name_cf: *const c_void = std::ptr::null();
        // SAFETY: LSCopyDisplayNameForURL copies the display name into out_display_name (Create Rule).
        let status = unsafe { LSCopyDisplayNameForURL(cf_url, &mut display_name_cf) };
        if status == 0 && !display_name_cf.is_null() {
            let _guard = CfRef(display_name_cf);
            if let Some(name) = cf_string_to_string(display_name_cf) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_owned();
                }
            }
        }
        fallback_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("App")
            .to_owned()
    }

    fn cf_url_for_path(path: &Path, is_directory: bool) -> Option<CfRef> {
        let c_str = CString::new(path.to_string_lossy().as_bytes()).ok()?;
        // SAFETY: CFStringCreateWithCString allocates a retained CFStringRef from valid C string.
        let cf_path = unsafe {
            CFStringCreateWithCString(std::ptr::null(), c_str.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if cf_path.is_null() {
            return None;
        }
        let _path_guard = CfRef(cf_path);
        // SAFETY: CFURLCreateWithFileSystemPath creates a retained CFURLRef from CFStringRef.
        let cf_url = unsafe {
            CFURLCreateWithFileSystemPath(
                std::ptr::null(),
                cf_path,
                K_CFURL_POSIX_PATH_STYLE,
                if is_directory { 1 } else { 0 },
            )
        };
        if cf_url.is_null() {
            None
        } else {
            Some(CfRef(cf_url))
        }
    }

    pub fn query_applications(file_name: &str) -> Vec<ApplicationCandidate> {
        let path = Path::new(file_name);
        let exists = path.exists();
        let (query_path, _temp_dir) = if exists {
            (path.to_path_buf(), None)
        } else {
            let base = path
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_else(|| "document.txt".to_string());
            let dir = std::env::temp_dir().join(format!("ftpeach-ls-{}", uuid::Uuid::new_v4()));
            let _ = std::fs::create_dir_all(&dir);
            let temp_file = dir.join(&base);
            let _ = std::fs::File::create(&temp_file);
            (temp_file, Some(dir))
        };

        struct DirGuard(Option<PathBuf>);
        impl Drop for DirGuard {
            fn drop(&mut self) {
                if let Some(dir) = self.0.take() {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        }
        let _guard = DirGuard(_temp_dir);

        let Some(cf_url) = cf_url_for_path(&query_path, false) else {
            return Vec::new();
        };

        // 1. Default application
        // SAFETY: LSCopyDefaultApplicationURLForURL returns a retained CFURLRef or null.
        let default_url = unsafe {
            LSCopyDefaultApplicationURLForURL(cf_url.0, K_LS_ROLES_ALL, std::ptr::null_mut())
        };
        let default_guard = if !default_url.is_null() {
            Some(CfRef(default_url))
        } else {
            None
        };
        let default_path = default_guard.as_ref().and_then(|g| cf_url_to_path(g.0));
        let default_candidate = default_path.as_ref().map(|path| {
            let name = display_name_for_url(default_guard.as_ref().unwrap().0, path);
            ApplicationCandidate {
                name,
                path: path.to_string_lossy().into_owned(),
                is_default: true,
            }
        });

        // 2. All applications capable of opening this URL
        // SAFETY: LSCopyApplicationURLsForURL returns a retained CFArrayRef of CFURLRefs or null.
        let apps_array = unsafe { LSCopyApplicationURLsForURL(cf_url.0, K_LS_ROLES_ALL) };
        let mut others: Vec<ApplicationCandidate> = Vec::new();
        if !apps_array.is_null() {
            let _array_guard = CfRef(apps_array);
            // SAFETY: CFArrayGetCount queries count from non-null CFArrayRef.
            let count = unsafe { CFArrayGetCount(apps_array) };
            for i in 0..count {
                // SAFETY: CFArrayGetValueAtIndex returns borrowed pointer from CFArrayRef.
                let item_url = unsafe { CFArrayGetValueAtIndex(apps_array, i) };
                if let Some(p) = cf_url_to_path(item_url) {
                    if default_path.as_ref() == Some(&p) {
                        continue;
                    }
                    let name = display_name_for_url(item_url, &p);
                    let path_str = p.to_string_lossy().into_owned();
                    if !others.iter().any(|existing| existing.path == path_str) {
                        others.push(ApplicationCandidate {
                            name,
                            path: path_str,
                            is_default: false,
                        });
                    }
                }
            }
        }

        // Sort others alphabetically by display name (case-insensitive)
        others.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        let mut result = Vec::new();
        if let Some(def) = default_candidate {
            result.push(def);
        }
        result.extend(others);
        result
    }
}

#[cfg(not(target_os = "macos"))]
mod non_macos {
    use super::ApplicationCandidate;

    pub fn query_applications(_file_name: &str) -> Vec<ApplicationCandidate> {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
pub use macos::query_applications;

#[cfg(not(target_os = "macos"))]
pub use non_macos::query_applications;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_candidate_serializes_to_camel_case() {
        let candidate = ApplicationCandidate {
            name: "TextEdit".to_string(),
            path: "/System/Applications/TextEdit.app".to_string(),
            is_default: true,
        };
        let json = serde_json::to_value(&candidate).unwrap();
        assert_eq!(json["name"], "TextEdit");
        assert_eq!(json["path"], "/System/Applications/TextEdit.app");
        assert_eq!(json["isDefault"], true);
    }

    #[test]
    fn non_macos_query_returns_empty_list() {
        #[cfg(not(target_os = "macos"))]
        {
            let apps = query_applications("readme.txt");
            assert!(apps.is_empty());
        }
    }
}
