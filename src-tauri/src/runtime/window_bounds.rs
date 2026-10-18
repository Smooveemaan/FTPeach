use crate::store::{JsonMap, Store};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};

const MIN_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 520.0;
const DEBOUNCE_MS: u64 = 400;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

pub fn sanitize_bounds(
    monitors: &[(f64, f64, f64, f64)],
    bounds: Option<Bounds>,
) -> Option<Bounds> {
    let bounds = bounds?;
    if !(bounds.width.is_finite() && bounds.height.is_finite()) {
        return None;
    }
    // Not rounded: at a scale such as 125% a whole logical size is not the
    // physical one that was saved.
    let width = bounds.width.max(MIN_WIDTH);
    let height = bounds.height.max(MIN_HEIGHT);
    let (Some(x), Some(y)) = (bounds.x, bounds.y) else {
        return Some(Bounds {
            width,
            height,
            x: None,
            y: None,
        });
    };
    let x = x.round();
    let y = y.round();
    let on_screen = monitors
        .iter()
        .any(|&(ax, ay, aw, ah)| x < ax + aw && x + width > ax && y < ay + ah && y + height > ay);
    if on_screen {
        Some(Bounds {
            width,
            height,
            x: Some(x),
            y: Some(y),
        })
    } else {
        Some(Bounds {
            width,
            height,
            x: None,
            y: None,
        })
    }
}

fn parse_bounds(value: Option<&Value>) -> Option<Bounds> {
    let obj = value?.as_object()?;
    let width = obj.get("width")?.as_f64()?;
    let height = obj.get("height")?.as_f64()?;
    let x = obj.get("x").and_then(Value::as_f64);
    let y = obj.get("y").and_then(Value::as_f64);
    Some(Bounds {
        width,
        height,
        x,
        y,
    })
}

/// Sets the page area to `width` by `height` logical pixels. Until the window
/// without decorations is first sized, Windows still counts a title bar in
/// its frame, and the first request leaves the page that much taller; the
/// second is measured against the frame the window really has.
fn restore_size(window: &WebviewWindow, width: f64, height: f64) {
    for _ in 0..2 {
        let _ = window.set_size(LogicalSize::new(width, height));
    }
}

pub async fn apply_saved_and_show(window: WebviewWindow, store: Store) {
    let settings = store.get_settings().await;
    let saved = parse_bounds(settings.get("windowBounds"));
    let maximized = settings
        .get("windowMaximized")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let monitors: Vec<(f64, f64, f64, f64)> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let wa = m.work_area();
            (
                wa.position.x as f64 / sf,
                wa.position.y as f64 / sf,
                wa.size.width as f64 / sf,
                wa.size.height as f64 / sf,
            )
        })
        .collect();

    let saved = sanitize_bounds(&monitors, saved);
    if let Some(b) = saved {
        restore_size(&window, b.width, b.height);
    }
    // A test run keeps the saved size, so a restart can be measured, but
    // stays off every screen.
    #[cfg(feature = "smoke-test")]
    if super::e2e_browser::active() {
        return super::e2e_browser::show_in_background(&window);
    }
    if let Some(Bounds {
        x: Some(x),
        y: Some(y),
        ..
    }) = saved
    {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
    if maximized {
        let _ = window.maximize();
    }
    let _ = window.show();
}

#[derive(Clone)]
pub struct BoundsPersister {
    store: Store,
    generation: Arc<AtomicU64>,
}

impl BoundsPersister {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn schedule(&self, window: WebviewWindow) {
        let r#gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
            if this.generation.load(Ordering::SeqCst) != r#gen {
                return; // superseded by a later move/resize
            }
            this.persist_now(&window).await;
        });
    }

    pub async fn persist_now(&self, window: &WebviewWindow) {
        let maximized = window.is_maximized().unwrap_or(false);
        let mut patch = JsonMap::new();
        patch.insert("windowMaximized".into(), Value::Bool(maximized));
        // The outer size counts the frame around the page, which set_size
        // does not: saved, it would grow the window by it at every start.
        if !maximized && let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
            let sf = window.scale_factor().unwrap_or(1.0);
            let bounds = serde_json::json!({
                "width": size.width as f64 / sf,
                "height": size.height as f64 / sf,
                "x": pos.x as f64 / sf,
                "y": pos.y as f64 / sf,
            });
            patch.insert("windowBounds".into(), bounds);
        }
        let _ = self.store.set_settings(patch).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(width: f64, height: f64, x: Option<f64>, y: Option<f64>) -> Bounds {
        Bounds {
            width,
            height,
            x,
            y,
        }
    }

    #[test]
    fn none_in_none_out() {
        assert_eq!(sanitize_bounds(&[], None), None);
    }

    #[test]
    fn enforces_minimum_size() {
        let got = sanitize_bounds(
            &[(0.0, 0.0, 1920.0, 1080.0)],
            Some(bounds(100.0, 100.0, Some(0.0), Some(0.0))),
        );
        assert_eq!(
            got,
            Some(bounds(MIN_WIDTH, MIN_HEIGHT, Some(0.0), Some(0.0)))
        );
    }

    #[test]
    fn missing_position_keeps_only_size() {
        let got = sanitize_bounds(
            &[(0.0, 0.0, 1920.0, 1080.0)],
            Some(bounds(800.0, 600.0, None, None)),
        );
        assert_eq!(got, Some(bounds(800.0, 600.0, None, None)));
    }

    #[test]
    fn on_screen_position_is_kept() {
        let monitors = [(0.0, 0.0, 1920.0, 1080.0)];
        let got = sanitize_bounds(
            &monitors,
            Some(bounds(800.0, 600.0, Some(100.0), Some(100.0))),
        );
        assert_eq!(got, Some(bounds(800.0, 600.0, Some(100.0), Some(100.0))));
    }

    #[test]
    fn off_screen_position_is_dropped_but_size_kept() {
        // A monitor that used to be at x=1920 (a second display to the
        // right) is gone — the saved window would open entirely off-screen.
        let monitors = [(0.0, 0.0, 1920.0, 1080.0)];
        let got = sanitize_bounds(
            &monitors,
            Some(bounds(800.0, 600.0, Some(2000.0), Some(100.0))),
        );
        assert_eq!(got, Some(bounds(800.0, 600.0, None, None)));
    }

    #[test]
    fn position_overlapping_any_monitor_counts_as_on_screen() {
        let monitors = [(0.0, 0.0, 1920.0, 1080.0), (1920.0, 0.0, 1920.0, 1080.0)];
        let got = sanitize_bounds(
            &monitors,
            Some(bounds(800.0, 600.0, Some(1800.0), Some(100.0))),
        );
        assert_eq!(got, Some(bounds(800.0, 600.0, Some(1800.0), Some(100.0))));
    }

    #[test]
    fn a_fractional_size_is_kept_as_saved() {
        let got = sanitize_bounds(&[], Some(bounds(708.8, 513.6, None, None)));
        assert_eq!(got, Some(bounds(708.8, 520.0, None, None)));
    }

    #[test]
    fn non_finite_dimensions_are_rejected() {
        let got = sanitize_bounds(
            &[(0.0, 0.0, 1920.0, 1080.0)],
            Some(bounds(f64::NAN, 600.0, None, None)),
        );
        assert_eq!(got, None);
    }
}
