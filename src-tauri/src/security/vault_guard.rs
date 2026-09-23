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

/// How an attempt ended, as the rate limiter needs to see it.
///
/// Only a credential that was checked and refused may count against the
/// user. A request the limiter itself turned away, one the user cancelled,
/// and a storage failure that happened after the password was accepted are
/// all different things, and counting them as wrong passwords made the
/// lockout extend itself for reasons the user could not fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttemptOutcome {
    /// The credential was checked and accepted.
    Accepted,
    /// The credential was checked and refused.
    Rejected,
    /// The attempt never reached the credential check, or failed after it
    /// for a reason that is not the credential.
    Inconclusive,
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

/// The right to run one vault authentication, held until its outcome has
/// been recorded.
///
/// The permit used to be released at the end of the block that did the work,
/// which was before the caller reported what happened. Another attempt could
/// start in that gap and be judged against a rate-limit state that did not
/// yet know about the attempt before it. Recording the outcome is what gives
/// the permit up, so the two cannot come apart.
pub(crate) struct VaultPermit {
    guard: VaultGuard,
    permit: Option<OwnedSemaphorePermit>,
}

impl VaultPermit {
    /// Records how the attempt ended and releases the slot.
    pub(crate) async fn finish(mut self, outcome: AttemptOutcome) {
        self.guard.record(outcome).await;
        // Explicit, so the slot is free only after the state above is.
        self.permit = None;
    }
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
        drop(attempts);
        Ok(VaultPermit {
            guard: self.clone(),
            permit: Some(permit),
        })
    }

    async fn record(&self, outcome: AttemptOutcome) {
        match outcome {
            AttemptOutcome::Rejected => self.failed().await,
            AttemptOutcome::Accepted => self.succeeded().await,
            // The user proved nothing either way, so the limiter learns
            // nothing either way.
            AttemptOutcome::Inconclusive => {}
        }
    }

    async fn failed(&self) {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().await;
        attempts.failures.push_back(now);
        // A permit is only issued below the limit, so the history cannot
        // outgrow it; the truncate says so rather than relying on it.
        while attempts.failures.len() > self.max_attempts {
            attempts.failures.pop_front();
        }
        attempts.consecutive_failures = attempts.consecutive_failures.saturating_add(1);
        let exponent = attempts.consecutive_failures.saturating_sub(1).min(16);
        let delay = self
            .base_backoff
            .saturating_mul(1_u32 << exponent)
            .min(self.max_backoff);
        attempts.retry_at = Some(now + delay);
    }

    async fn succeeded(&self) {
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
        first.finish(AttemptOutcome::Inconclusive).await;
        assert!(waiting.await.unwrap().is_ok());

        let held = guard.acquire().await.unwrap();
        let cancelled = tokio::spawn({
            let guard = guard.clone();
            async move { guard.acquire().await }
        });
        cancelled.abort();
        held.finish(AttemptOutcome::Inconclusive).await;
        assert!(guard.acquire().await.is_ok());
    }

    #[tokio::test]
    async fn applies_backoff_window_and_success_reset() {
        let guard = guard();
        guard
            .acquire()
            .await
            .unwrap()
            .finish(AttemptOutcome::Rejected)
            .await;
        assert!(guard.acquire().await.is_err());
        tokio::time::sleep(Duration::from_millis(12)).await;
        guard
            .acquire()
            .await
            .unwrap()
            .finish(AttemptOutcome::Accepted)
            .await;
        assert!(guard.acquire().await.is_ok());

        for delay in [12, 22, 42] {
            guard
                .acquire()
                .await
                .unwrap()
                .finish(AttemptOutcome::Rejected)
                .await;
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        assert!(guard.acquire().await.is_err());
        tokio::time::sleep(Duration::from_millis(260)).await;
        guard
            .acquire()
            .await
            .unwrap()
            .finish(AttemptOutcome::Rejected)
            .await;
        assert!(guard.acquire().await.is_err());
        tokio::time::sleep(Duration::from_millis(12)).await;
        assert!(guard.acquire().await.is_ok());
    }

    /// A request the limiter turned away is not evidence about the
    /// password, so it must not lengthen the wait it was turned away by.
    #[tokio::test]
    async fn a_refused_request_does_not_extend_its_own_lockout() {
        let guard = guard();
        guard
            .acquire()
            .await
            .unwrap()
            .finish(AttemptOutcome::Rejected)
            .await;
        for _ in 0..20 {
            assert!(guard.acquire().await.is_err());
        }
        // Only the one real failure counts, so the first backoff step is
        // all that has to pass.
        tokio::time::sleep(Duration::from_millis(12)).await;
        assert!(guard.acquire().await.is_ok());
    }

    /// Something that went wrong after the password was accepted says
    /// nothing about the password.
    #[tokio::test]
    async fn an_inconclusive_attempt_leaves_the_history_alone() {
        let guard = guard();
        for _ in 0..10 {
            guard
                .acquire()
                .await
                .unwrap()
                .finish(AttemptOutcome::Inconclusive)
                .await;
        }
        assert!(guard.acquire().await.is_ok());
    }

    /// The outcome is recorded while the slot is still held, so a second
    /// attempt cannot be judged against a state that predates the first.
    #[tokio::test]
    async fn the_outcome_is_recorded_before_the_next_attempt_is_admitted() {
        let guard = guard();
        let permit = guard.acquire().await.unwrap();
        let waiting = tokio::spawn({
            let guard = guard.clone();
            async move { guard.acquire().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        permit.finish(AttemptOutcome::Rejected).await;
        // The waiter resumes only after the failure is on the books, so it
        // sees the backoff rather than an empty history.
        assert!(waiting.await.unwrap().is_err());
    }
}
