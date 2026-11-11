use super::ApplicationCandidate;
use std::path::Path;
use windows::{
    Win32::UI::Shell::{ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR_FRIENDLYAPPNAME, AssocQueryStringW},
    core::{PCWSTR, PWSTR},
};

/// Names the default handler; Windows dispatches it so packaged apps and shell verbs work too.
pub fn query_applications(file_name: &str) -> Vec<ApplicationCandidate> {
    let Some(extension) = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
    else {
        return Vec::new();
    };
    if extension.contains('\0') {
        return Vec::new();
    }
    let extension: Vec<u16> = format!(".{extension}").encode_utf16().chain([0]).collect();
    let mut size = 0;
    // SAFETY: the first call queries the buffer length for a terminated extension.
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCSTR_FRIENDLYAPPNAME,
            PCWSTR(extension.as_ptr()),
            PCWSTR::null(),
            None,
            &mut size,
        )
    };
    if result.is_err() || size == 0 {
        return Vec::new();
    }
    let mut name = vec![0u16; size as usize];
    // SAFETY: name has the capacity reported above; both pointers remain valid for the call.
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCSTR_FRIENDLYAPPNAME,
            PCWSTR(extension.as_ptr()),
            PCWSTR::null(),
            Some(PWSTR(name.as_mut_ptr())),
            &mut size,
        )
    };
    if result.is_err() {
        return Vec::new();
    }
    let name = String::from_utf16_lossy(
        &name[..name
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(name.len())],
    );
    if name.is_empty() {
        return Vec::new();
    }
    vec![ApplicationCandidate {
        name,
        path: String::new(),
        is_default: true,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_resolves_a_text_default_without_replacing_shell_dispatch() {
        let candidates = query_applications("report.txt");
        assert_eq!(candidates.len(), 1);
        assert!(!candidates[0].name.is_empty());
        assert!(candidates[0].is_default);
        assert!(candidates[0].path.is_empty());
        assert!(query_applications("report.ftpeach-no-association-735928").is_empty());
        assert!(query_applications("README").is_empty());
    }
}
