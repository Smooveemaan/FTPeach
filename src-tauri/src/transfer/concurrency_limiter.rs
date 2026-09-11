use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

#[derive(Default)]
pub struct ConcurrencyLimiter {
    state: Mutex<(usize, usize)>, // limit (zero is unlimited), active transfers
    changed: Notify,
}

pub struct Permit(Arc<ConcurrencyLimiter>);

impl ConcurrencyLimiter {
    pub fn set_limit(&self, limit: usize) {
        self.state.lock().unwrap().0 = limit;
        self.changed.notify_waiters();
    }

    pub fn try_acquire(self: &Arc<Self>) -> Option<Arc<Permit>> {
        let mut state = self.state.lock().unwrap();
        if state.0 != 0 && state.1 >= state.0 {
            return None;
        }
        state.1 += 1;
        Some(Arc::new(Permit(self.clone())))
    }

    pub async fn acquire(self: &Arc<Self>) -> Arc<Permit> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(permit) = self.try_acquire() {
                return permit;
            }
            changed.await;
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().1 -= 1;
        self.0.changed.notify_waiters();
    }
}

pub fn shared() -> Arc<ConcurrencyLimiter> {
    static SHARED: OnceLock<Arc<ConcurrencyLimiter>> = OnceLock::new();
    SHARED.get_or_init(Arc::default).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lowering_limit_waits_for_active_transfers_and_zero_wakes_waiters() {
        let limiter = Arc::new(ConcurrencyLimiter::default());
        limiter.set_limit(2);
        let first = limiter.acquire().await;
        let second = limiter.acquire().await;
        limiter.set_limit(1);
        assert!(limiter.try_acquire().is_none());
        drop(first);
        assert!(limiter.try_acquire().is_none());
        drop(second);
        let held = limiter.acquire().await;
        let waiting_limiter = limiter.clone();
        let waiting = tokio::spawn(async move { waiting_limiter.acquire().await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        limiter.set_limit(0);
        let permit = tokio::time::timeout(std::time::Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap();
        drop((held, permit));
        assert_eq!(limiter.state.lock().unwrap().1, 0);
    }
}
