//! Harnesses compile the real parser/error sources, not copies or mock parsers.
#![allow(dead_code)]

#[path = "../../src/ipc.rs"]
mod ipc;
#[path = "../../src/protocol/list_parse.rs"]
mod list_parse;
#[path = "../../src/protocol/failure.rs"]
pub mod protocol;
#[path = "../../src/protocol/webdav/response.rs"]
mod response;
type BackendResult<T> = anyhow::Result<T>;

pub fn list(data: &[u8]) {
    if let Ok(text) = std::str::from_utf8(data) {
        // Fixed clock makes a saved input reproducible across calendar years.
        let now = chrono::DateTime::from_timestamp(1_781_524_800, 0).unwrap();
        for line in text.lines() {
            let _ = list_parse::parse_line(line, now);
            // The app currently uses LIST; exercise the dependency's MLSD parser too.
            let _ = suppaftp::list::ListParser::parse_mlsd(line);
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
