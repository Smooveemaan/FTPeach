use super::BackendResult;
use crate::ipc::ErrorCode;
use crate::protocol::fail;
use anyhow::{Context, bail};
use chrono::{DateTime, Utc};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::StatusCode;

pub(super) fn status_error(status: u16, operation: &str) -> anyhow::Error {
    let code = match status {
        401 | 407 => ErrorCode::AuthFailed,
        403 => ErrorCode::PermissionDenied,
        404 => ErrorCode::NotFound,
        408 | 504 => ErrorCode::TimedOut,
        416 => ErrorCode::IntegrityMismatch,
        409 | 412 => ErrorCode::InvalidInput,
        _ => ErrorCode::Internal,
    };
    fail(code, format!("WebDAV {operation} returned HTTP {status}"))
}

pub(super) fn validate_content_range(
    value: Option<&str>,
    start: u64,
    expected_total: Option<u64>,
) -> BackendResult<()> {
    let value = value.ok_or_else(|| mismatch("missing Content-Range on resumed response"))?;
    let range = value
        .strip_prefix("bytes ")
        .ok_or_else(|| mismatch("invalid Content-Range unit"))?;
    let (span, total) = range
        .split_once('/')
        .ok_or_else(|| mismatch("malformed Content-Range"))?;
    let (actual_start, end) = span
        .split_once('-')
        .ok_or_else(|| mismatch("malformed Content-Range span"))?;
    let actual_start: u64 = actual_start
        .parse()
        .map_err(|_| mismatch("invalid Content-Range start"))?;
    let end: u64 = end
        .parse()
        .map_err(|_| mismatch("invalid Content-Range end"))?;
    if actual_start != start || end < actual_start {
        return Err(mismatch(format!(
            "Content-Range {value} does not match requested offset {start}"
        )));
    }
    if total != "*" {
        let total: u64 = total
            .parse()
            .map_err(|_| mismatch("invalid Content-Range total"))?;
        if end >= total {
            return Err(mismatch("Content-Range end exceeds total length"));
        }
    }
    if let Some(expected) = expected_total {
        let actual: u64 = total
            .parse()
            .map_err(|_| mismatch("invalid Content-Range total"))?;
        if actual != expected || end.checked_add(1) != Some(actual) {
            return Err(mismatch(format!(
                "Content-Range total {actual} does not match expected {expected}"
            )));
        }
    }
    Ok(())
}

/// Every way a resumed response can disagree with the range we asked for is
/// the same failure to the renderer: the bytes we'd append can't be trusted.
/// The code is what travels; `detail` only says which way it disagreed.
fn mismatch(detail: impl std::fmt::Display) -> anyhow::Error {
    fail(
        ErrorCode::IntegrityMismatch,
        "The server's resumed response does not match the requested range",
    )
    .context(detail.to_string())
}

pub(super) fn resumed_response_start(status: StatusCode, requested: u64) -> BackendResult<u64> {
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Err(mismatch("server rejected resume offset with 416"));
    }
    if requested > 0 && status != StatusCode::PARTIAL_CONTENT {
        return Ok(0);
    }
    Ok(requested)
}

#[derive(Default)]
pub(super) struct RawEntry {
    pub(super) href: String,
    pub(super) is_dir: bool,
    pub(super) size: Option<u64>,
    pub(super) last_modified: Option<String>,
}

fn local_name_lower(raw: &str) -> String {
    raw.to_ascii_lowercase()
}

/// Namespace-agnostic PROPFIND parser based on DAV local element names.
pub(super) fn parse_propfind(xml: &str) -> BackendResult<Vec<RawEntry>> {
    let mut reader = Reader::from_str(xml);
    let mut entries = Vec::new();
    let mut current: Option<RawEntry> = None;
    let mut properties: Option<RawEntry> = None;
    let mut prop_status = None;
    let mut response_status = None;
    let mut current_tag: Option<String> = None;
    let mut text = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let local = local_name_lower(event.local_name().as_ref());
                match local.as_str() {
                    "response" => {
                        current = Some(RawEntry::default());
                        response_status = None;
                    }
                    "propstat" => {
                        properties = Some(RawEntry::default());
                        prop_status = None;
                    }
                    "collection" => {
                        if let Some(p) = &mut properties {
                            p.is_dir = true;
                        }
                    }
                    "href" | "getcontentlength" | "getlastmodified" | "status" => {
                        text.clear();
                        current_tag = Some(local);
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(event)) => {
                if local_name_lower(event.local_name().as_ref()) == "collection"
                    && let Some(p) = &mut properties
                {
                    p.is_dir = true;
                }
            }
            Ok(Event::Text(event)) => {
                if current_tag.is_some() {
                    let decoded = event.xml10_content();
                    let unescaped = quick_xml::escape::unescape(&decoded)
                        .context("unescaping PROPFIND text")?;
                    text.push_str(&unescaped);
                }
            }
            Ok(Event::End(event)) => {
                let local = local_name_lower(event.local_name().as_ref());
                match local.as_str() {
                    "href" => {
                        if let Some(entry) = &mut current {
                            entry.href = text.trim().to_string();
                        }
                        current_tag = None;
                    }
                    "getcontentlength" => {
                        if let Some(entry) = &mut properties {
                            entry.size = text.trim().parse().ok();
                        }
                        current_tag = None;
                    }
                    "getlastmodified" => {
                        if let Some(entry) = &mut properties {
                            entry.last_modified = Some(text.trim().to_string());
                        }
                        current_tag = None;
                    }
                    "status" => {
                        let status = text
                            .split_whitespace()
                            .nth(1)
                            .and_then(|s| s.parse::<u16>().ok());
                        if properties.is_some() {
                            prop_status = status;
                        } else {
                            response_status = status;
                        }
                        current_tag = None;
                    }
                    "propstat" => {
                        if let (Some(entry), Some(props)) = (&mut current, properties.take())
                            && prop_status.is_some_and(|code| (200..300).contains(&code))
                        {
                            entry.is_dir |= props.is_dir;
                            if props.size.is_some() {
                                entry.size = props.size;
                            }
                            if props.last_modified.is_some() {
                                entry.last_modified = props.last_modified;
                            }
                        }
                    }
                    "response" => {
                        if response_status.is_some_and(|code| !(200..300).contains(&code)) {
                            return Err(status_error(response_status.unwrap(), "response"));
                        }
                        if let Some(entry) = current.take() {
                            entries.push(entry);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => bail!("error parsing PROPFIND XML response: {error}"),
            _ => {}
        }
    }
    Ok(entries)
}

/// Percent-decodes an href after removing an optional scheme and host.
pub(super) fn decode_href(href: &str) -> String {
    let path = if href.starts_with("http://") || href.starts_with("https://") {
        reqwest::Url::parse(href)
            .map(|url| url.path().to_string())
            .unwrap_or_else(|_| href.to_string())
    } else {
        href.to_string()
    };
    percent_encoding::percent_decode_str(&path)
        .decode_utf8_lossy()
        .into_owned()
}

pub(super) fn href_basename(decoded: &str) -> String {
    decoded
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

pub(super) fn parse_http_date(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|date| date.with_timezone(&Utc))
}
