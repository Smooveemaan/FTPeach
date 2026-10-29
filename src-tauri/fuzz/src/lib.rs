//! Harnesses compile the real parser/error sources, not copies or mock parsers.
#![allow(dead_code)]

#[path = "../../src/protocol/failure.rs"]
mod failure;
#[path = "../../src/ipc.rs"]
mod ipc;
#[path = "../../src/protocol/limits.rs"]
mod limits;
#[path = "../../src/protocol/list_parse.rs"]
mod list_parse;
pub mod protocol {
    pub use crate::failure::fail;
    pub use crate::limits::{
        MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_TEXT_BYTES, MAX_RAW_DIRECTORY_ENTRIES,
    };
}
#[path = "../../src/protocol/remote_path.rs"]
mod remote_path;
#[path = "../../src/protocol/webdav/response.rs"]
mod response;
#[path = "../../src/runtime/update_staging.rs"]
mod update_staging;
#[path = "../../src/local_fs/windows_names.rs"]
mod windows_names;
type BackendResult<T> = anyhow::Result<T>;

pub fn list(data: &[u8]) {
    if let Ok(text) = std::str::from_utf8(data) {
        // Fixed clock makes a saved input reproducible across calendar years.
        let now = chrono::DateTime::from_timestamp(1_781_524_800, 0).unwrap();
        for line in text.lines() {
            let _ = list_parse::parse_line(line, now);
            let _ = list_parse::parse_mlsd_line(line);
        }
    }
}

pub fn propfind(data: &[u8]) {
    if let Ok(text) = std::str::from_utf8(data) {
        // Malformed responses may return errors; panics must reach libFuzzer.
        if let Ok(entries) = response::parse_propfind(text) {
            for entry in entries {
                let decoded = response::decode_href(&entry.href);
                let _ = response::href_basename(&decoded);
                if let Some(date) = entry.last_modified {
                    let _ = response::parse_http_date(&date);
                }
            }
        }
    }
}

/// One name or path per line; a tab splits a source from a destination.
pub fn names(data: &[u8]) {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    for line in text.lines() {
        if windows_names::validate_file_name(line).is_ok() {
            assert!(!windows_names::is_reserved_name(line), "{line:?}");
            assert!(!line.ends_with(['.', ' ']), "{line:?}");
            assert!(
                !line
                    .chars()
                    .any(|c| c.is_control() || "<>:\"|?*".contains(c)),
                "{line:?}"
            );
        }
        let (source, destination) = line.split_once('\t').unwrap_or((line, ""));
        let _ = remote_path::validate_remote_path(source);
        let _ = remote_path::validate_remote_relationship(source, destination);
        // Whatever the source spells, a name put under it is inside it.
        assert!(
            remote_path::validate_remote_relationship(source, &format!("{source}/x")).is_err(),
            "{source:?}"
        );
    }
}

/// A staged portable update: its checks never panic, and unpacking it writes
/// only inside the program's folder and never under `data`.
pub fn update(data: &[u8]) {
    #[cfg(any(unix, test))]
    for package in [
        update_staging::Package::MacApp,
        update_staging::Package::AppImage,
        update_staging::Package::Deb,
    ] {
        let _ = update_staging::update_package::check(
            data,
            package,
            "999.0.0",
            &semver::Version::new(0, 0, 1),
        );
    }
    let _ = update_staging::embedded_version(data);
    let _ = update_staging::check_portable_zip(data, "999.0.0", &semver::Version::new(0, 0, 1));
    if !data.starts_with(b"PK") {
        return;
    }
    let root = std::env::temp_dir().join(format!("ftpeach-fuzz-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let program = root.join("program");
    std::fs::create_dir_all(&program).unwrap();
    let zip = root.join("update.zip");
    std::fs::write(&zip, data).unwrap();
    let _ = update_staging::unpack(&zip, &program);
    let mut written = Vec::new();
    let mut pending = vec![root.clone()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                pending.push(path.clone());
            }
            written.push(path);
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    for path in written {
        if path == zip || path == program {
            continue;
        }
        let inside = path.strip_prefix(&program);
        assert!(inside.is_ok(), "{path:?} is outside the program's folder");
        let first = inside.unwrap().components().next().unwrap();
        assert!(
            !first.as_os_str().eq_ignore_ascii_case("data"),
            "{path:?} is under data"
        );
    }
}

pub fn ftp(data: &[u8]) {
    use std::sync::OnceLock;
    use tokio::io::AsyncWriteExt;
    static SERVER: OnceLock<(tokio::runtime::Runtime, tokio::net::TcpListener)> = OnceLock::new();
    let (runtime, listener) = SERVER.get_or_init(|| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        (runtime, listener)
    });
    runtime.block_on(async {
        // suppaftp accepts a TcpStream, not an injected reader. Bind only loopback,
        // write the finite input and close so truncated multiline replies reach EOF.
        // Reuse the listener across inputs: repeatedly binding ephemeral listening
        // ports exhausts local TCP resources during a sustained run.
        let address = listener.local_addr().unwrap();
        let server = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = socket.write_all(data).await;
        };
        let client = async {
            let socket = tokio::net::TcpStream::connect(address)
                .await
                .expect("connect to the loopback test server");
            let _ = suppaftp::tokio::AsyncFtpStream::connect_with_stream(socket).await;
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(server, client);
        })
        .await
        .expect("FTP response parser must finish on finite input");
    });
}

#[cfg(test)]
mod corpus_tests {
    #[test]
    fn replay_committed_corpora() {
        for (target, run) in [
            ("list_parse", super::list as fn(&[u8])),
            ("ftp_response", super::ftp),
            ("webdav_propfind", super::propfind),
            ("names_paths", super::names),
            ("update_package", super::update),
        ] {
            let directory = format!("{}/corpus/{target}", env!("CARGO_MANIFEST_DIR"));
            let seeds: Vec<_> = std::fs::read_dir(directory).unwrap().collect();
            assert!(!seeds.is_empty(), "missing corpus for {target}");
            for seed in seeds {
                run(&std::fs::read(seed.unwrap().path()).unwrap());
            }
        }
    }
}
