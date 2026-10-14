//! Deleting the staging file an upload or a copy between servers abandoned.

use crate::ipc::{CommandError, ErrorCode};
use crate::session::Sessions;
use crate::transfer::upload_staging::{
    REMOVE_ATTEMPTS as STAGING_REMOVE_ATTEMPTS, REMOVE_PAUSE as STAGING_REMOVE_PAUSE,
    log_staging_left,
};
use std::time::Duration;

/// How long a transfer waits for its staging file to go before it settles. A
/// server that stopped answering gets the rest of the cleanup in the
/// background, so a Stop does not sit in "Cancelling" for its timeouts.
const SETTLE_BUDGET: Duration = Duration::from_secs(10);

/// How a staging cleanup ended, as far as the caller has to know.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Cleanup {
    /// Nothing to tell: the file is gone, a removal is still at it in the
    /// background, or it was kept on purpose and reported otherwise.
    Done,
    /// The server would not let the file go; it stays, and the log says so.
    Left,
    /// No session to try with: the connection's teardown deletes the file.
    NoSession,
}

/// Only an attempt's randomly named staging file is eligible for cleanup.
/// A disconnected server may retain that artifact; never fall back to deleting
/// the final destination. Retries use a fresh staging file and restart upload.
///
/// Without a session the file is left to the connection's teardown, which is
/// what took the session away. A cleanup that outlasts [`SETTLE_BUDGET`] goes
/// on behind the caller and logs how it ended.
pub(crate) async fn cleanup_remote_partial(
    sessions: &Sessions,
    connection_id: &str,
    partial: &str,
) -> Cleanup {
    let (sessions, connection_id, owned) = (
        sessions.clone(),
        connection_id.to_owned(),
        partial.to_owned(),
    );
    let cleanup =
        tokio::spawn(async move { clean_staging(&sessions, &connection_id, &owned).await });
    match tokio::time::timeout(SETTLE_BUDGET, cleanup).await {
        Ok(ended) => ended.unwrap_or(Cleanup::NoSession),
        Err(_) => {
            log::warn!(
                "Still cleaning transfer staging file {partial}; the transfer settles meanwhile"
            );
            Cleanup::Done
        }
    }
}

async fn clean_staging(sessions: &Sessions, connection_id: &str, partial: &str) -> Cleanup {
    // Only the wait for the browsing connection is kept short. A removal cut
    // off mid-reply would cost FTP that connection, and the pane its listing
    // with it, so once started it gets as long as a server that still answers
    // could need. Err: the browsing connection is busy or not answering.
    let cleaned: Result<Cleanup, ()> = async {
        for attempt in 1..=STAGING_REMOVE_ATTEMPTS {
            {
                let slot = sessions.lookup_slot(connection_id);
                let Ok(mut guard) = tokio::time::timeout(Duration::from_secs(5), slot.lock()).await
                else {
                    return Err(());
                };
                let Some(session) = guard.as_mut() else {
                    log::warn!("No session to clean transfer staging file {partial}");
                    return Ok(Cleanup::NoSession);
                };
                if attempt == 1
                    && !crate::protocol::put_back_set_aside(session.browse_client.as_mut(), partial)
                        .await
                {
                    return Ok(Cleanup::Done);
                }
                let refused = match tokio::time::timeout(
                    Duration::from_secs(10),
                    session.browse_client.remove(partial, false),
                )
                .await
                {
                    Ok(Ok(())) => return Ok(Cleanup::Done),
                    Ok(Err(error)) => error,
                    Err(_) => return Err(()),
                };
                if CommandError::from_anyhow(&refused).code == ErrorCode::NotFound {
                    return Ok(Cleanup::Done);
                }
                if attempt == STAGING_REMOVE_ATTEMPTS {
                    log::warn!("Could not clean transfer staging file {partial}: {refused}");
                    log_staging_left(
                        session.browse_client.as_ref(),
                        partial,
                        &format!("{refused:#}"),
                    );
                    return Ok(Cleanup::Left);
                }
            }
            // A server on Windows refuses to delete a file that the stopped
            // upload's session still holds open, and that session takes a
            // moment to close after the client has gone. The pane may list
            // in between.
            tokio::time::sleep(STAGING_REMOVE_PAUSE).await;
        }
        Ok(Cleanup::Done)
    }
    .await;
    if let Ok(ended) = cleaned {
        return ended;
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
                let removed = match tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    backend.remove(&path, false),
                )
                .await
                {
                    Ok(result) => result,
                    Err(elapsed) => {
                        log_staging_left(backend.as_ref(), &path, "timed out");
                        // Cut off mid-reply, the connection must not serve again.
                        let _ = backend.disconnect().await;
                        return Err(elapsed.into());
                    }
                };
                if let Err(error) = &removed {
                    log_staging_left(backend.as_ref(), &path, &format!("{error:#}"));
                }
                removed
            })
        });
        Some(pool.run(uuid::Uuid::new_v4().to_string(), task).await)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(30), retry).await {
        Ok(Some(Err(error))) => {
            log::warn!("Could not clean transfer staging file {partial}: {error}");
            Cleanup::Left
        }
        Err(_) => {
            log::warn!("Timed out cleaning transfer staging file {partial}");
            Cleanup::Left
        }
        Ok(None) => {
            log::warn!("No session to clean transfer staging file {partial}");
            Cleanup::NoSession
        }
        Ok(Some(Ok(()))) => Cleanup::Done,
    }
}
