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

/// Only a guard against a server that lists folders without end: removal
/// walks an explicit stack, so real trees of any sane depth fit.
pub const MAX_REMOTE_REMOVE_DEPTH: u32 = 1024;

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

    /// Windows itself is the oracle: whatever a server names a file, the
    /// temp name must create one ordinary file of exactly that name, never
    /// a device, a stream or a differently named file whose type Open with
    /// would then misjudge. Seeded, so a failure reproduces; add the
    /// failing name to the explicit cases above.
    #[cfg(windows)]
    #[test]
    fn temp_names_create_exactly_the_named_file() {
        use rand::{RngExt, SeedableRng};
        const PIECES: &[&str] = &[
            "CON",
            "con",
            "PRN",
            "AUX",
            "NUL",
            "COM1",
            "lpt9",
            "COM\u{b9}",
            "LPT\u{b3}",
            "CONIN$",
            "CONOUT$",
            "CLOCK$",
            ".",
            "..",
            " ",
            ":",
            "::$DATA",
            "\\",
            "/",
            "*",
            "?",
            "\"",
            "<",
            ">",
            "|",
            "\0",
            "\u{1f}",
            "\u{7f}",
            "a",
            "txt",
            ".cmd",
            "\u{6587}",
            "\u{1f642}",
            "\u{301}",
            "\u{200b}",
            "\u{202e}",
            "~1",
            "$",
            "%",
            "\u{a0}",
            "\u{3000}",
        ];
        let dir = std::env::temp_dir().join(format!("ftpeach-temp-names-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let mut rng = rand::rngs::StdRng::seed_from_u64(0xf7ea_c400);
        for _ in 0..2_000 {
            let name: String = (0..rng.random_range(1..=5))
                .map(|_| PIECES[rng.random_range(0..PIECES.len())])
                .collect();
            let safe = safe_temp_name(&name);
            let path = dir.join(&safe);
            std::fs::write(&path, b"x")
                .unwrap_or_else(|error| panic!("{name:?} -> {safe:?}: {error}"));
            let listed: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(listed, [std::ffi::OsString::from(&safe)], "{name:?}");
            assert!(std::fs::metadata(&path).unwrap().is_file(), "{name:?}");
            std::fs::remove_file(&path).unwrap();
        }
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn recursive_remove_depth_limit_is_inclusive_and_bounded() {
        assert!(remote_remove_depth_allowed(0));
        assert!(remote_remove_depth_allowed(MAX_REMOTE_REMOVE_DEPTH));
        assert!(!remote_remove_depth_allowed(MAX_REMOTE_REMOVE_DEPTH + 1));
        assert!(!remote_remove_depth_allowed(u32::MAX));
    }
}
