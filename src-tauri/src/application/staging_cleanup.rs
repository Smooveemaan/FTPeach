//! Deleting the staging file an upload or a copy between servers abandoned.

use crate::ipc::{CommandError, ErrorCode};
use crate::session::Sessions;
use crate::transfer::upload_staging::{
    REMOVE_ATTEMPTS as STAGING_REMOVE_ATTEMPTS, REMOVE_PAUSE as STAGING_REMOVE_PAUSE,
};
use std::time::Duration;

/// Only an attempt's randomly named staging file is eligible for cleanup.
/// A disconnected server may retain that artifact; never fall back to deleting
/// the final destination. Retries use a fresh staging file and restart upload.
///
/// Says whether a session was there to try. Without one the file is left to
/// the connection's teardown, which is what took the session away.
pub(crate) async fn cleanup_remote_partial(
    sessions: &Sessions,
    connection_id: &str,
    partial: &str,
) -> bool {
    // Only the wait for the browsing connection is kept short. A removal cut
    // off mid-reply would cost FTP that connection, and the pane its listing
    // with it, so once started it gets as long as a server that still answers
    // could need.
    let cleaned = async {
        for attempt in 1..=STAGING_REMOVE_ATTEMPTS {
            let refused = {
                let slot = sessions.lookup_slot(connection_id);
                let Ok(mut guard) = tokio::time::timeout(Duration::from_secs(5), slot.lock()).await
                else {
                    return Some(false);
                };
                let Some(session) = guard.as_mut() else {
                    log::warn!("No session to clean transfer staging file {partial}");
                    return None;
                };
                if attempt == 1
                    && !crate::protocol::put_back_set_aside(session.browse_client.as_mut(), partial)
                        .await
                {
                    return Some(true);
                }
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    session.browse_client.remove(partial, false),
                )
                .await
                {
                    Ok(Ok(())) => return Some(true),
                    Ok(Err(error)) => error,
                    Err(_) => return Some(false),
                }
            };
            if CommandError::from_anyhow(&refused).code == ErrorCode::NotFound {
                return Some(true);
            }
            if attempt == STAGING_REMOVE_ATTEMPTS {
                log::warn!("Could not clean transfer staging file {partial}: {refused}");
                return Some(true);
            }
            // A server on Windows refuses to delete a file that the stopped
            // upload's session still holds open, and that session takes a
            // moment to close after the client has gone. The pane may list
            // in between.
            tokio::time::sleep(STAGING_REMOVE_PAUSE).await;
        }
        Some(true)
    };
    match cleaned.await {
        None => return false,
        Some(true) => return true,
        Some(false) => {}
    }
    // The browsing connection is busy or no longer answering. A transfer
    // connection is free to try, now that this upload has let go of its own.
    log::warn!(
        "Timed out cleaning transfer staging file {partial}; retrying on a transfer connection"
    );
    let retry = async {
        let pool = sessions.pool_for(connection_id).await?;
        let path = partial.to_owned();
        let task: crate::transfer::transfer_pool::TaskFn = Box::new(move |backend| {
            Box::pin(async move {
                if !crate::protocol::put_back_set_aside(backend.as_mut(), &path).await {
                    return Ok(());
                }
                match tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    backend.remove(&path, false),
                )
                .await
                {
                    Ok(result) => result,
                    Err(elapsed) => {
                        // Cut off mid-reply, the connection must not serve again.
                        let _ = backend.disconnect().await;
                        Err(elapsed.into())
                    }
                }
            })
        });
        Some(pool.run(uuid::Uuid::new_v4().to_string(), task).await)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(30), retry).await {
        Ok(Some(Err(error))) => {
            log::warn!("Could not clean transfer staging file {partial}: {error}");
        }
        Err(_) => log::warn!("Timed out cleaning transfer staging file {partial}"),
        Ok(None) => {
            log::warn!("No session to clean transfer staging file {partial}");
            return false;
        }
        Ok(Some(Ok(()))) => {}
    }
    true
}
