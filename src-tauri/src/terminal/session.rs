//! PTY/shell negotiation and streaming I/O loop for a single SSH terminal channel.

use super::{CreditState, MAX_IN_FLIGHT_BYTES, TerminalEvent, TerminalEventSink, TerminalInput};
use base64::Engine;
use russh::{ChannelMsg, Pty};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_COALESCE_BYTES: usize = 16 * 1024;
const OUTPUT_COALESCE_DELAY: Duration = Duration::from_millis(10);
const TERM_NAME: &str = "xterm-256color";
/// RFC 8160: tell the remote PTY line discipline that input bytes are UTF-8 so
/// canonical-mode editing (e.g. Backspace) erases whole multibyte characters.
const PTY_MODES: &[(Pty, u32)] = &[(Pty::IUTF8, 1)];

pub(super) enum ShellOpenError {
    Refused(String),
    Lost(String),
}

fn client_utf8_locale_env() -> Vec<(&'static str, String)> {
    let mut vars = Vec::new();
    for key in ["LANG", "LC_CTYPE"] {
        if let Ok(value) = std::env::var(key) {
            let lower = value.to_ascii_lowercase();
            if lower.contains("utf-8") || lower.contains("utf8") {
                vars.push((key, value));
            }
        }
    }
    vars
}

pub(super) async fn open_pty_shell(
    channel: &mut russh::Channel<russh::client::Msg>,
    cols: u32,
    rows: u32,
) -> Result<Vec<u8>, ShellOpenError> {
    let mut early_output = Vec::new();

    channel
        .request_pty(true, TERM_NAME, cols, rows, 0, 0, PTY_MODES)
        .await
        .map_err(|error| ShellOpenError::Lost(format!("PTY request failed: {error}")))?;
    wait_for_reply(
        channel,
        &mut early_output,
        "The server refused to allocate a terminal (PTY)",
    )
    .await?;

    // Forward client UTF-8 locale hints best-effort (like OpenSSH SendEnv);
    // servers without AcceptEnv simply ignore `want_reply = false` env requests.
    for (key, value) in client_utf8_locale_env() {
        let _ = channel.set_env(false, key, value).await;
    }

    channel
        .request_shell(true)
        .await
        .map_err(|error| ShellOpenError::Lost(format!("Shell request failed: {error}")))?;
    wait_for_reply(
        channel,
        &mut early_output,
        "The server refused to start an interactive shell",
    )
    .await?;

    Ok(early_output)
}

async fn wait_for_reply(
    channel: &mut russh::Channel<russh::client::Msg>,
    early_output: &mut Vec<u8>,
    refusal_message: &str,
) -> Result<(), ShellOpenError> {
    let wait = async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => {
                    return Err(ShellOpenError::Refused(refusal_message.to_owned()));
                }
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let remaining = MAX_IN_FLIGHT_BYTES.saturating_sub(early_output.len());
                    if remaining > 0 {
                        let take = remaining.min(data.len());
                        early_output.extend_from_slice(&data[..take]);
                    }
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                    return Err(ShellOpenError::Refused(refusal_message.to_owned()));
                }
                Some(_) => {}
            }
        }
    };
    tokio::time::timeout(HANDSHAKE_TIMEOUT, wait)
        .await
        .unwrap_or_else(|_| {
            Err(ShellOpenError::Lost(
                "Timed out waiting for server terminal response".to_owned(),
            ))
        })
}

pub(super) async fn run_terminal_loop(
    mut channel: russh::Channel<russh::client::Msg>,
    early_output: Vec<u8>,
    mut input_rx: mpsc::Receiver<TerminalInput>,
    credit: Arc<CreditState>,
    sink: TerminalEventSink,
) {
    let mut pending = early_output;
    let mut flush_deadline: Option<Instant> = None;
    let mut exit_code: Option<u32> = None;
    let mut closed_locally = false;

    if !pending.is_empty() && !flush_output(&mut pending, &mut flush_deadline, &credit, &sink) {
        let _ = channel.close().await;
        return;
    }

    loop {
        let notified = credit.notify.notified();
        tokio::pin!(notified);
        // Enable the waiter before reading the atomic counter so an ack()
        // racing with this check can never leave us parked.
        notified.as_mut().enable();
        let can_read = credit.in_flight.load(Ordering::Acquire) < MAX_IN_FLIGHT_BYTES;

        tokio::select! {
            biased;

            cmd = input_rx.recv() => {
                match cmd {
                    Some(TerminalInput::Write(bytes)) => {
                        if channel.data_bytes(bytes).await.is_err() {
                            break;
                        }
                    }
                    Some(TerminalInput::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(TerminalInput::Close) | None => {
                        closed_locally = true;
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        break;
                    }
                }
            }

            _ = async {
                match flush_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            }, if flush_deadline.is_some() => {
                if !flush_output(&mut pending, &mut flush_deadline, &credit, &sink) {
                    closed_locally = true;
                    let _ = channel.close().await;
                    break;
                }
            }

            msg = channel.wait(), if can_read => {
                match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if !data.is_empty() {
                            pending.extend_from_slice(&data);
                            if pending.len() >= OUTPUT_COALESCE_BYTES {
                                if !flush_output(&mut pending, &mut flush_deadline, &credit, &sink) {
                                    closed_locally = true;
                                    let _ = channel.close().await;
                                    break;
                                }
                            } else if flush_deadline.is_none() {
                                flush_deadline = Some(Instant::now() + OUTPUT_COALESCE_DELAY);
                            }
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Eof) => {
                        if !pending.is_empty()
                            && !flush_output(&mut pending, &mut flush_deadline, &credit, &sink)
                        {
                            closed_locally = true;
                            let _ = channel.close().await;
                            break;
                        }
                    }
                    Some(ChannelMsg::Close) | None => {
                        if !pending.is_empty() {
                            let _ = flush_output(&mut pending, &mut flush_deadline, &credit, &sink);
                        }
                        break;
                    }
                    Some(_) => {}
                }
            }

            _ = &mut notified, if !can_read => {}
        }
    }

    if closed_locally {
        let _ = sink(TerminalEvent::Closed { reason: None });
    } else {
        let _ = sink(TerminalEvent::Exit { code: exit_code });
    }
}

fn flush_output(
    pending: &mut Vec<u8>,
    flush_deadline: &mut Option<Instant>,
    credit: &CreditState,
    sink: &TerminalEventSink,
) -> bool {
    *flush_deadline = None;
    if pending.is_empty() {
        return true;
    }
    let chunk = std::mem::take(pending);
    let bytes = chunk.len();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&chunk);
    credit.in_flight.fetch_add(bytes, Ordering::AcqRel);
    sink(TerminalEvent::Output {
        data: encoded,
        bytes,
    })
    .is_ok()
}
