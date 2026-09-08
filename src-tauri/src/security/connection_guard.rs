/// Accepts only a literal child name from an untrusted remote listing.
///
/// Rejecting separators and dot segments here protects every downstream path
/// consumer from traversal.
pub fn is_safe_path_segment(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['\\', '/', '\r', '\n'])
}

/// Rejects control characters in a full renderer-provided remote path.
///
/// Unlike [`is_safe_path_segment`], this accepts `/` but blocks CR/LF command
/// injection before a protocol backend interpolates the path into a request.
pub fn is_safe_remote_path_argument(path: &str) -> bool {
    !path.is_empty() && !path.contains(['\r', '\n'])
}

pub const MAX_REMOTE_REMOVE_DEPTH: u32 = 40;

pub fn remote_remove_depth_allowed(depth: u32) -> bool {
    depth <= MAX_REMOTE_REMOVE_DEPTH
}

/// Checks whether a remote name is valid for a Windows temporary file.
///
/// Path traversal is handled separately by [`is_safe_path_segment`].
pub fn safe_temp_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (c as u32) <= 0x1f
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        "file".to_string()
    } else if is_windows_reserved_name(cleaned) {
        format!("_{cleaned}")
    } else {
        cleaned.to_string()
    }
}

fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_path_segment_rejects_traversal() {
        assert!(!is_safe_path_segment(".."));
        assert!(!is_safe_path_segment("."));
        assert!(!is_safe_path_segment(""));
        assert!(!is_safe_path_segment("a/b"));
        assert!(!is_safe_path_segment("a\\b"));
        assert!(is_safe_path_segment("normal.txt"));
    }

    #[test]
    fn safe_path_segment_rejects_embedded_crlf() {
        assert!(!is_safe_path_segment("evil\r\nDELE /other"));
        assert!(!is_safe_path_segment("evil\nDELE /other"));
        assert!(!is_safe_path_segment("evil\rDELE /other"));
    }

    #[test]
    fn safe_remote_path_argument_rejects_crlf_injection_but_allows_normal_paths() {
        assert!(is_safe_remote_path_argument("/home/user/new folder"));
        assert!(!is_safe_remote_path_argument(""));
        assert!(!is_safe_remote_path_argument("/x\r\nDELE /other/file"));
        assert!(!is_safe_remote_path_argument("/x\nDELE /other/file"));
        assert!(!is_safe_remote_path_argument("/x\rDELE /other/file"));
    }

    #[test]
    fn temp_name_strips_forbidden_chars_and_trailing_dots() {
        assert_eq!(safe_temp_name("a:b*c.txt"), "a_b_c.txt");
        assert_eq!(safe_temp_name("trailing. "), "trailing");
        assert_eq!(safe_temp_name(""), "file");
        assert_eq!(safe_temp_name("..."), "file");
    }

    #[test]
    fn temp_name_handles_windows_devices_controls_and_unicode_edges() {
        for reserved in [
            "CON", "con.txt", "PRN", "AUX.log", "NUL", "COM1.txt", "com9", "LPT1", "lpt9.bin",
        ] {
            assert!(safe_temp_name(reserved).starts_with('_'), "{reserved}");
        }
        assert_eq!(safe_temp_name("COM0.txt"), "COM0.txt");
        assert_eq!(safe_temp_name("LPT10.txt"), "LPT10.txt");
        assert_eq!(safe_temp_name("nul_device.txt"), "nul_device.txt");
        assert_eq!(safe_temp_name("a\0b\u{1f}c"), "a_b_c");
        assert_eq!(safe_temp_name("文件🙂.txt"), "文件🙂.txt");
        assert_eq!(safe_temp_name("name\u{301}"), "name\u{301}");
    }

    #[test]
    fn recursive_remove_depth_limit_is_inclusive_and_bounded() {
        assert!(remote_remove_depth_allowed(0));
        assert!(remote_remove_depth_allowed(MAX_REMOTE_REMOVE_DEPTH));
        assert!(!remote_remove_depth_allowed(MAX_REMOTE_REMOVE_DEPTH + 1));
        assert!(!remote_remove_depth_allowed(u32::MAX));
    }
}
