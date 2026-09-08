use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, Utc};
use std::sync::OnceLock;

pub struct RawEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
    pub permissions: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

fn posix_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r#"^([\-ld])([\-rwxsStT]{9})\s+(\d+)\s+([^ ]+)\s+([^ ]+)\s+(\d+)\s+([^ ]+\s+\d{1,2}\s+(?:\d{1,2}:\d{1,2}|\d{4}))\s+(.+)$"#,
        )
        .unwrap()
    })
}

fn dos_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r#"^(\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*[AP]M)\s+(<DIR>)?([\d,]*)\s+(.+)$"#,
        )
        .unwrap()
    })
}

fn permissions_string(raw9: &str) -> Option<String> {
    if raw9.len() != 9 || !raw9.is_ascii() {
        return None;
    }
    let mut permissions = String::with_capacity(9);
    for triplet in raw9.as_bytes().chunks_exact(3) {
        permissions.push(if triplet[0] == b'r' { 'r' } else { '-' });
        permissions.push(if triplet[1] == b'w' { 'w' } else { '-' });
        permissions.push(if matches!(triplet[2], b'x' | b's' | b't') {
            'x'
        } else {
            '-'
        });
    }
    Some(permissions)
}

fn resolve_ambiguous_date(token: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if let Ok(date) = NaiveDate::parse_from_str(token, "%b %d %Y") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|dt| DateTime::from_naive_utc_and_offset(dt, Utc));
    }
    let this_year = now.year();
    let with_year = format!("{token} {this_year}");
    let mut parsed = NaiveDateTime::parse_from_str(&with_year, "%b %d %H:%M %Y").ok()?;
    let as_utc = DateTime::<Utc>::from_naive_utc_and_offset(parsed, Utc);
    if (as_utc - now).num_seconds() > 180 * 24 * 3600 {
        let with_prev_year = format!("{token} {}", this_year - 1);
        parsed = NaiveDateTime::parse_from_str(&with_prev_year, "%b %d %H:%M %Y").ok()?;
    }
    Some(DateTime::from_naive_utc_and_offset(parsed, Utc))
}

fn parse_dos_datetime(token: &str) -> Option<DateTime<Utc>> {
    let parsed = NaiveDateTime::parse_from_str(token, "%m-%d-%y %I:%M%p")
        .or_else(|_| NaiveDateTime::parse_from_str(token, "%m-%d-%y %I:%M %p"))
        .ok()?;
    Some(DateTime::from_naive_utc_and_offset(parsed, Utc))
}

pub fn parse_line(line: &str, now: DateTime<Utc>) -> Option<RawEntry> {
    if let Some(caps) = posix_re().captures(line) {
        let file_type = caps.get(1)?.as_str();
        let name_field = caps.get(8)?.as_str();
        let name = name_field
            .split(" -> ")
            .next()
            .unwrap_or(name_field)
            .to_string();
        return Some(RawEntry {
            name,
            is_directory: file_type == "d",
            size: caps.get(6)?.as_str().parse().ok()?,
            modified_at: resolve_ambiguous_date(caps.get(7)?.as_str(), now),
            permissions: permissions_string(caps.get(2)?.as_str()),
            owner: Some(caps.get(4)?.as_str().to_string()),
            group: Some(caps.get(5)?.as_str().to_string()),
        });
    }
    if let Some(caps) = dos_re().captures(line) {
        let is_directory = caps.get(2).is_some();
        let size = if is_directory {
            0
        } else {
            caps.get(3)
                .map(|m| m.as_str().replace(',', ""))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };
        return Some(RawEntry {
            name: caps.get(4)?.as_str().to_string(),
            is_directory,
            size,
            modified_at: parse_dos_datetime(caps.get(1)?.as_str()),
            permissions: None,
            owner: None,
            group: None,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_posix_line_with_year() {
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap();
        let entry = parse_line("-rw-r--r-- 1 user group 1234 Nov 5 2018 example.txt", now).unwrap();
        assert_eq!(entry.name, "example.txt");
        assert_eq!(entry.size, 1234);
        assert!(!entry.is_directory);
        assert_eq!(entry.owner.as_deref(), Some("user"));
        assert_eq!(entry.group.as_deref(), Some("group"));
        assert_eq!(entry.permissions.as_deref(), Some("rw-r--r--"));
        let modified = entry.modified_at.unwrap();
        assert_eq!(modified.year(), 2018);
        assert_eq!(modified.month(), 11);
        assert_eq!(modified.day(), 5);
    }

    #[test]
    fn resolves_ambiguous_recent_date_to_current_year() {
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap();
        let entry = parse_line("drwxr-xr-x 2 user group 4096 Jun 1 09:00 recent", now).unwrap();
        assert!(entry.is_directory);
        let modified = entry.modified_at.unwrap();
        assert_eq!(modified.year(), 2026);
        assert_eq!(modified.month(), 6);
        assert_eq!(modified.day(), 1);
    }

    #[test]
    fn rolls_back_a_year_when_guess_is_far_in_the_future() {
        // "now" is mid-June; "Dec 15" with the current year would be ~6
        // months out — past the window, so it must resolve to last December.
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap();
        let entry = parse_line("-rw-r--r-- 1 user group 10 Dec 15 08:00 file.txt", now).unwrap();
        let modified = entry.modified_at.unwrap();
        assert_eq!(modified.year(), 2025);
    }

    #[test]
    fn parses_dos_line() {
        let now = Utc::now();
        let entry = parse_line("04-08-14  03:09PM  8192 omar.txt", now).unwrap();
        assert_eq!(entry.name, "omar.txt");
        assert_eq!(entry.size, 8192);
        assert!(!entry.is_directory);
        assert!(entry.permissions.is_none());
    }

    #[test]
    fn parses_dos_directory() {
        let now = Utc::now();
        let entry = parse_line("04-08-14  03:09PM <DIR> docs", now).unwrap();
        assert!(entry.is_directory);
        assert_eq!(entry.size, 0);
    }

    #[test]
    fn strips_symlink_target_from_name() {
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap();
        let entry = parse_line(
            "lrwxrwxrwx 1 root root 9 Nov 5 2018 link -> /tmp/target",
            now,
        )
        .unwrap();
        assert_eq!(entry.name, "link");
    }

    #[test]
    fn unparseable_line_returns_none() {
        assert!(parse_line("total 42", Utc::now()).is_none());
    }

    #[test]
    fn generated_valid_list_lines_round_trip_names_sizes_and_kinds() {
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap();
        let alphabet = ["a", "Z", "0", "-", "_", " ", "é", "文件", "🙂"];
        let mut state = 0x5eed_u64;
        for case in 0..500_u64 {
            let mut name = String::from("n");
            for _ in 0..(1 + case % 24) {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                name.push_str(alphabet[(state as usize) % alphabet.len()]);
            }
            let size = state % 10_000_000;
            let posix = format!("-rw-r--r-- 1 owner group {size} Nov 5 2018 {name}");
            let parsed = parse_line(&posix, now).unwrap();
            assert_eq!(parsed.name, name);
            assert_eq!(parsed.size, size);
            assert!(!parsed.is_directory);

            let dos = format!("04-08-14  03:09PM <DIR> {name}");
            let parsed = parse_line(&dos, now).unwrap();
            assert_eq!(parsed.name, name);
            assert!(parsed.is_directory);
        }
    }

    #[test]
    fn arbitrary_generated_list_input_never_panics() {
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap();
        let mut state = 0xc0ffee_u64;
        for case in 0..2_000_u64 {
            let mut input = String::new();
            for _ in 0..(case % 128) {
                state = state
                    .wrapping_mul(2862933555777941757)
                    .wrapping_add(3037000493);
                let ch = char::from_u32(1 + (state % 0x10ffff) as u32).unwrap_or('\u{fffd}');
                input.push(ch);
            }
            assert!(std::panic::catch_unwind(|| parse_line(&input, now)).is_ok());
        }
    }
}

#[cfg(test)]
mod permission_tests {
    use super::permissions_string;

    #[test]
    fn normalizes_special_permission_bits() {
        assert_eq!(
            permissions_string("rwsr-Sr-t").as_deref(),
            Some("rwxr--r-x")
        );
        assert_eq!(
            permissions_string("--S--T--s").as_deref(),
            Some("--------x")
        );
        assert_eq!(
            permissions_string("rwxrwxrwx").as_deref(),
            Some("rwxrwxrwx")
        );
    }

    #[test]
    fn rejects_invalid_length_and_non_ascii() {
        for raw in ["", "rwx", "rwxrwxrwxr", "é-------"] {
            assert!(permissions_string(raw).is_none());
        }
    }
}
