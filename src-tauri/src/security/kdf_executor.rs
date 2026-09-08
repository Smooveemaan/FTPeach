//! Cancellation does not release the KDF slot until the blocking work exits.
use anyhow::{Context, Result};
use std::sync::{Arc, LazyLock};
static SLOT: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));

pub(super) async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = SLOT.clone().acquire_owned().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .context("vault KDF task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_caller_does_not_release_running_computation() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let caller = tokio::spawn(run(move || {
            let _ = started_tx.send(());
            release_rx.recv()?;
            Ok(())
        }));
        started_rx.await.unwrap();
        caller.abort();
        let _ = caller.await;
        assert!(SLOT.try_acquire().is_err());
        release_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), run(|| Ok(())))
            .await
            .unwrap()
            .unwrap();
    }
}
