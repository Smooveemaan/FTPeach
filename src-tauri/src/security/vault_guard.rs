use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

const ATTEMPT_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_ATTEMPTS: usize = 8;
const BASE_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

struct AttemptState {
    failures: VecDeque<Instant>,
    consecutive_failures: u32,
    retry_at: Option<Instant>,
}

/// Rate-limits authentication attempts and serializes vault commands.
/// The separate KDF executor retains its own slot until blocking work exits,
/// even when cancellation releases this command permit.
#[derive(Clone)]
pub(crate) struct VaultGuard {
    kdf_slot: Arc<Semaphore>,
    attempts: Arc<Mutex<AttemptState>>,
    attempt_window: Duration,
    max_attempts: usize,
    base_backoff: Duration,
    max_backoff: Duration,
}

pub(crate) struct VaultPermit {
    _permit: OwnedSemaphorePermit,
}

impl Default for VaultGuard {
    fn default() -> Self {
        Self::new(ATTEMPT_WINDOW, MAX_ATTEMPTS, BASE_BACKOFF, MAX_BACKOFF)
    }
}

impl VaultGuard {
    fn new(
        attempt_window: Duration,
        max_attempts: usize,
        base_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        Self {
            kdf_slot: Arc::new(Semaphore::new(1)),
            attempts: Arc::new(Mutex::new(AttemptState {
                failures: VecDeque::new(),
                consecutive_failures: 0,
                retry_at: None,
            })),
            attempt_window,
            max_attempts,
            base_backoff,
            max_backoff,
        }
    }

    pub(crate) async fn acquire(&self) -> anyhow::Result<VaultPermit> {
        let permit = self.kdf_slot.clone().acquire_owned().await.map_err(|_| {
            anyhow::anyhow!("Vault authentication failed or temporarily unavailable")
        })?;

        let now = Instant::now();
        let mut attempts = self.attempts.lock().await;
        let had_failures = !attempts.failures.is_empty();
        while attempts
            .failures
            .front()
            .is_some_and(|failed| now.duration_since(*failed) >= self.attempt_window)
        {
            attempts.failures.pop_front();
        }
        if had_failures && attempts.failures.is_empty() {
            attempts.consecutive_failures = 0;
            attempts.retry_at = None;
        }
        if attempts.retry_at.is_some_and(|retry_at| retry_at > now)
            || attempts.failures.len() >= self.max_attempts
        {
            anyhow::bail!("Vault authentication failed or temporarily unavailable");
        }
        Ok(VaultPermit { _permit: permit })
    }

    pub(crate) async fn failed(&self) {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().await;
        attempts.failures.push_back(now);
        attempts.consecutive_failures = attempts.consecutive_failures.saturating_add(1);
        let exponent = attempts.consecutive_failures.saturating_sub(1).min(16);
        let delay = self
            .base_backoff
            .saturating_mul(1_u32 << exponent)
            .min(self.max_backoff);
        attempts.retry_at = Some(now + delay);
    }

    pub(crate) async fn succeeded(&self) {
        let mut attempts = self.attempts.lock().await;
        attempts.failures.clear();
        attempts.consecutive_failures = 0;
        attempts.retry_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> VaultGuard {
        VaultGuard::new(
            Duration::from_millis(250),
            3,
            Duration::from_millis(10),
            Duration::from_millis(40),
        )
    }

    #[tokio::test]
    async fn serializes_parallel_work_and_recovers_after_cancellation() {
        let guard = guard();
        let first = guard.acquire().await.unwrap();
        let waiting = tokio::spawn({
            let guard = guard.clone();
            async move { guard.acquire().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(first);
        assert!(waiting.await.unwrap().is_ok());

        let held = guard.acquire().await.unwrap();
        let cancelled = tokio::spawn({
            let guard = guard.clone();
            async move { guard.acquire().await }
        });
        cancelled.abort();
        drop(held);
        assert!(guard.acquire().await.is_ok());
    }

    #[tokio::test]
    async fn applies_backoff_window_and_success_reset() {
        let guard = guard();
        let permit = guard.acquire().await.unwrap();
        guard.failed().await;
        drop(permit);
        assert!(guard.acquire().await.is_err());
        tokio::time::sleep(Duration::from_millis(12)).await;
        let permit = guard.acquire().await.unwrap();
        guard.succeeded().await;
        drop(permit);
        assert!(guard.acquire().await.is_ok());

        for delay in [12, 22, 42] {
            let permit = guard.acquire().await.unwrap();
            guard.failed().await;
            drop(permit);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        assert!(guard.acquire().await.is_err());
        tokio::time::sleep(Duration::from_millis(260)).await;
        let permit = guard.acquire().await.unwrap();
        guard.failed().await;
        drop(permit);
        assert!(guard.acquire().await.is_err());
        tokio::time::sleep(Duration::from_millis(12)).await;
        assert!(guard.acquire().await.is_ok());
    }
}
