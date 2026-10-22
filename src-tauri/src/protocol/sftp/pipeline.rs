//! Reads and writes a file over SFTP with several requests in flight, the
//! way SFTP clients reach a usable speed over a slow link.
use super::*;

/// Read ahead in bounded batches, restoring offset order before writing locally.
/// Each request fills its own interval: a short DATA packet is not EOF.
pub(super) async fn read_pipelined(
    raw: &Arc<RawSftpSession>,
    handle: &str,
    writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    start: u64,
    total: Option<u64>,
    progress: &ProgressSink,
) -> BackendResult<u64> {
    let mut offset = start;
    loop {
        let capacity = crate::transfer::rate_limiter::paced_chunk_size(CHUNK_SIZE);
        // Under a bandwidth cap, avoid multiplying the paced read-ahead by 16.
        let window = if capacity < CHUNK_SIZE {
            1
        } else {
            READ_WINDOW
        };
        let mut pending = tokio::task::JoinSet::new();
        for index in 0..window {
            let position = offset
                .checked_add((index * capacity) as u64)
                .context("SFTP read offset overflow")?;
            let session = raw.clone();
            let handle = handle.to_owned();
            pending.spawn(async move {
                let mut bytes = Vec::with_capacity(capacity);
                while bytes.len() < capacity {
                    let at = position
                        .checked_add(bytes.len() as u64)
                        .context("SFTP read offset overflow")?;
                    let want = (capacity - bytes.len()) as u32;
                    match session.read(handle.as_str(), at, want).await {
                        Ok(data) if data.data.is_empty() => break,
                        Ok(data) => {
                            anyhow::ensure!(
                                data.data.len() <= want as usize,
                                "SFTP server exceeded requested read length"
                            );
                            bytes.extend_from_slice(&data.data);
                        }
                        Err(SftpClientError::Status(status))
                            if status.status_code == StatusCode::Eof =>
                        {
                            break;
                        }
                        Err(error) => return Err(error).context("reading from server"),
                    }
                }
                Ok::<_, anyhow::Error>((index, bytes))
            });
        }
        let mut blocks = vec![Vec::new(); window];
        let mut error = None;
        // Settle submitted requests before the caller closes the remote handle.
        while let Some(reply) = pending.join_next().await {
            match reply
                .context("SFTP read task failed")
                .and_then(|reply| reply)
            {
                Ok((index, bytes)) => blocks[index] = bytes,
                Err(err) => {
                    if error.is_none() {
                        error = Some(err);
                    }
                }
            }
        }
        if let Some(error) = error {
            return Err(error);
        }
        let mut eof = false;
        for bytes in blocks {
            anyhow::ensure!(
                !eof || bytes.is_empty(),
                "SFTP server returned data beyond EOF"
            );
            eof |= bytes.len() < capacity;
            let next = offset
                .checked_add(bytes.len() as u64)
                .context("SFTP read offset overflow")?;
            crate::protocol::transfer_file::validate_resume_offset(next, total)?;
            if !bytes.is_empty() {
                crate::transfer::rate_limiter::shared()
                    .acquire(bytes.len() as u64)
                    .await;
                tokio::time::timeout(TRANSFER_STALL_TIMEOUT, writer.write_all(&bytes))
                    .await
                    .context("SFTP download destination stalled")??;
                offset = next;
                progress(ProgressInfo::Progress {
                    bytes: offset,
                    total: total.unwrap_or(0),
                });
            }
        }
        if eof {
            crate::protocol::transfer_file::validate_length(offset, total)?;
            return Ok(offset);
        }
    }
}

/// Bound both memory and outstanding requests. Offsets are explicit: APPEND
/// must not be used with concurrent writes, whose replies can arrive in any order.
pub(super) async fn write_pipelined(
    raw: &Arc<RawSftpSession>,
    handle: &str,
    reader: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
    start: u64,
    total: u64,
    progress: &ProgressSink,
) -> BackendResult<u64> {
    let mut pending = tokio::task::JoinSet::new();
    let mut offset = start;
    let mut acknowledged = start;
    let mut error = None;
    let mut eof = false;
    let mut buf = vec![0; CHUNK_SIZE];
    while !eof || !pending.is_empty() {
        if !eof && pending.len() < WRITE_WINDOW {
            let capacity = crate::transfer::rate_limiter::paced_chunk_size(buf.len());
            match tokio::time::timeout(TRANSFER_STALL_TIMEOUT, reader.read(&mut buf[..capacity]))
                .await
                .unwrap_or_else(|_| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "SFTP upload source stalled",
                    ))
                }) {
                Ok(0) => eof = true,
                Ok(n) => {
                    crate::transfer::rate_limiter::shared()
                        .acquire(n as u64)
                        .await;
                    let session = raw.clone();
                    let handle = handle.to_owned();
                    let data = buf[..n].to_vec();
                    let position = offset;
                    pending.spawn(async move {
                        session
                            .write(handle, position, data)
                            .await
                            .context("writing to server")?;
                        Ok::<u64, anyhow::Error>(n as u64)
                    });
                    offset += n as u64;
                    continue;
                }
                Err(err) => {
                    error = Some(anyhow::Error::new(err).context("reading upload source"));
                    eof = true;
                }
            }
        }
        if let Some(reply) = pending.join_next().await {
            match reply
                .context("SFTP write task failed")
                .and_then(|result| result)
            {
                Ok(n) => {
                    acknowledged += n;
                    if error.is_none() {
                        progress(ProgressInfo::Progress {
                            bytes: acknowledged,
                            total,
                        });
                    }
                }
                Err(err) => {
                    if error.is_none() {
                        error = Some(err);
                    }
                    eof = true;
                }
            }
        }
    }
    // All submitted writes have settled before CLOSE, including on failure.
    if let Some(error) = error {
        return Err(error);
    }
    Ok(acknowledged)
}
