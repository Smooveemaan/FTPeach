use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Inner {
    rate: f64, // bytes/sec; <= 0 means unlimited
    tokens: f64,
    last_refill: Instant,
}

pub struct RateLimiter(Mutex<Inner>);

impl RateLimiter {
    pub fn new(bytes_per_sec: u64) -> Self {
        let rate = bytes_per_sec as f64;
        Self(Mutex::new(Inner {
            rate,
            tokens: rate,
            last_refill: Instant::now(),
        }))
    }

    pub fn set_rate(&self, bytes_per_sec: u64) {
        let mut inner = self.0.lock().unwrap();
        inner.rate = bytes_per_sec as f64;
        inner.tokens = inner.rate;
        inner.last_refill = Instant::now();
    }

    pub fn current_rate(&self) -> f64 {
        self.0.lock().unwrap().rate
    }

    pub fn paced_chunk_size(&self, max: usize) -> usize {
        let rate = self.current_rate();
        if rate <= 0.0 || max == 0 {
            return max;
        }
        ((rate * PACING_INTERVAL_SECS) as usize).clamp(1, max)
    }

    pub async fn acquire_paced(&self, total: u64, mut on_slice: impl FnMut(u64)) {
        let mut remaining = total;
        while remaining > 0 {
            let slice = (self.paced_chunk_size(remaining as usize) as u64).min(remaining);
            self.acquire(slice).await;
            remaining -= slice;
            on_slice(slice);
        }
    }

    pub async fn acquire(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let mut remaining = bytes as f64;
        loop {
            let done = {
                let mut inner = self.0.lock().unwrap();
                if inner.rate <= 0.0 {
                    true
                } else {
                    let now = Instant::now();
                    let elapsed = now.duration_since(inner.last_refill).as_secs_f64();
                    inner.last_refill = now;
                    inner.tokens = (inner.tokens + elapsed * inner.rate).min(inner.rate);
                    let take = remaining.min(inner.tokens);
                    inner.tokens -= take;
                    remaining -= take;
                    remaining <= 0.0
                }
            };
            if done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

static SHARED: OnceLock<RateLimiter> = OnceLock::new();

pub fn shared() -> &'static RateLimiter {
    SHARED.get_or_init(|| RateLimiter::new(0))
}

/// How much wall-clock time a single paced read/write/acquire should cover.
/// Transfer loops move data (and report progress) in chunks this size at
/// most, so a slow rate limit still yields frequent, smooth updates instead
/// of one huge chunk being read/written in a burst and then a long silent
/// wait before the next progress tick.
const PACING_INTERVAL_SECS: f64 = 0.15;

/// Caps `max` to roughly `PACING_INTERVAL_SECS` worth of bytes at the
/// currently configured rate limit, so callers can shrink their read/write
/// chunk size under a slow limit. Returns `max` unchanged when unlimited.
pub fn paced_chunk_size(max: usize) -> usize {
    shared().paced_chunk_size(max)
}

/// Awaits `acquire()` for `total` bytes in rate-appropriate slices instead
/// of one lump sum, invoking `on_slice` after each slice is granted. Use
/// this when `total` bytes have already been read/written as a single
/// (possibly large) unit — e.g. an HTTP response chunk whose size isn't
/// under our control — so progress can still be reported incrementally
/// rather than jumping all at once after a long wait.
pub async fn acquire_paced(total: u64, on_slice: impl FnMut(u64)) {
    shared().acquire_paced(total, on_slice).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rate_zero_never_delays_acquire() {
        let limiter = RateLimiter::new(0);
        let start = Instant::now();
        limiter.acquire(10_000_000).await;
        assert!(start.elapsed() < Duration::from_millis(20));
    }

    #[tokio::test]
    async fn fresh_limiter_starts_with_full_bucket() {
        let limiter = RateLimiter::new(100_000); // 100 KB/s
        let start = Instant::now();
        limiter.acquire(100_000).await; // exactly one second's worth, already banked
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn exceeding_bucket_waits_for_refill() {
        let limiter = RateLimiter::new(100_000); // 100 KB/s
        limiter.acquire(100_000).await; // drain the initial full bucket
        let start = Instant::now();
        limiter.acquire(50_000).await; // needs ~0.5s to refill at this rate
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(350),
            "waited only {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_millis(1500),
            "waited too long: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn large_request_paid_in_installments() {
        let limiter = RateLimiter::new(50_000); // 50 KB/s
        let start = Instant::now();
        limiter.acquire(125_000).await;
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(1300),
            "waited only {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_millis(3000),
            "took far longer than the rate implies: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn set_rate_to_zero_unblocks_pending_acquire_promptly() {
        let limiter = std::sync::Arc::new(RateLimiter::new(1_000)); // tiny: 1 KB/s
        limiter.acquire(1_000).await; // drain the initial bucket
        let pending = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.acquire(100_000).await }) // would take ~100s
        };
        tokio::time::sleep(Duration::from_millis(80)).await;
        limiter.set_rate(0);
        let start = Instant::now();
        pending.await.unwrap();
        assert!(start.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn shared_is_a_process_wide_singleton() {
        assert!(std::ptr::eq(shared(), shared()));
    }
}
