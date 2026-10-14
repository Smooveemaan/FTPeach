//! Keep Windows WebView rasterization integral while preserving the requested UI size.

use anyhow::Result;
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

pub(crate) struct InterfaceScale(Mutex<f64>);

impl Default for InterfaceScale {
    fn default() -> Self {
        Self(Mutex::new(1.0))
    }
}

impl InterfaceScale {
    pub(crate) fn set(&self, scale: f64) -> std::result::Result<(), &'static str> {
        if !scale.is_finite() || !(0.8..=1.5).contains(&scale) {
            return Err("Interface scale must be between 0.8 and 1.5");
        }
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = scale;
        Ok(())
    }

    fn get(&self) -> f64 {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The main window's smallest size, as `minWidth`/`minHeight` in tauri.conf.json.
const MIN_SIZE: (f64, f64) = (480.0, 520.0);

/// The smallest window that still gives the page `MIN_SIZE` CSS pixels at
/// this interface scale, as far as the work area holds it.
fn scaled_min_size(scale: f64, work: (f64, f64)) -> (f64, f64) {
    let fit = |base: f64, room: f64| (base * scale).min(room).max(base);
    (fit(MIN_SIZE.0, work.0), fit(MIN_SIZE.1, work.1))
}

/// Grows the main window's minimum with the interface scale, and the window
/// with it: a program's resize is not held to the minimum, so it is done here.
fn fit_min_size(window: &WebviewWindow) -> Result<()> {
    let work = match window.current_monitor().map_err(scale_error)? {
        Some(monitor) => {
            let area = monitor
                .work_area()
                .size
                .to_logical::<f64>(monitor.scale_factor());
            (area.width, area.height)
        }
        None => (f64::INFINITY, f64::INFINITY),
    };
    let (width, height) = scaled_min_size(window.state::<InterfaceScale>().get(), work);
    window
        .set_min_size(Some(tauri::LogicalSize::new(width, height)))
        .map_err(scale_error)?;
    let size = window
        .inner_size()
        .map_err(scale_error)?
        .to_logical::<f64>(window.scale_factor().map_err(scale_error)?);
    if !window.is_maximized().map_err(scale_error)? && (size.width < width || size.height < height)
    {
        window
            .set_size(tauri::LogicalSize::new(
                size.width.max(width),
                size.height.max(height),
            ))
            .map_err(scale_error)?;
    }
    Ok(())
}

fn scale_error(error: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("Could not apply interface scale: {error}")
}

/// Reapply the latest preference after a native monitor DPI change.
pub(crate) fn refresh(window: &WebviewWindow) {
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = apply(&window).await {
            log::warn!("Could not refresh interface scale: {error:?}");
        }
    });
}

/// Completes only after the window thread has applied the latest preference.
pub(crate) async fn apply(window: &WebviewWindow) -> Result<()> {
    zoom(window).await?;
    if window.label() == "main" {
        fit_min_size(window)?;
    }
    Ok(())
}

async fn zoom(window: &WebviewWindow) -> Result<()> {
    #[cfg(windows)]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let target = window.clone();
        window
            .with_webview(move |webview| {
                // Read both values on the UI thread, so a queued DPI refresh cannot
                // restore an older preference after a newer renderer request.
                let result = target.scale_factor().map_err(scale_error).and_then(|dpi| {
                    let scale = target.state::<InterfaceScale>().get();
                    configure(&webview.controller(), dpi * scale).map_err(scale_error)
                });
                let _ = send.send(result);
            })
            .map_err(scale_error)?;
        receive.await.map_err(scale_error)?
    }
    #[cfg(not(windows))]
    {
        window
            .set_zoom(window.state::<InterfaceScale>().get())
            .map_err(scale_error)
    }
}

#[cfg(windows)]
fn configure(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    zoom: f64,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows::core::{BOOL, Interface};

    unsafe {
        let raster = controller.cast::<ICoreWebView2Controller3>()?;
        let (mut old_scale, mut old_zoom, mut old_auto) = (1.0, 1.0, BOOL::default());
        raster.RasterizationScale(&mut old_scale)?;
        raster.ShouldDetectMonitorScaleChanges(&mut old_auto)?;
        controller.ZoomFactor(&mut old_zoom)?;
        let result = (|| {
            // WRY owns Bounds in physical pixels. Only page zoom follows monitor
            // DPI; fractional native rasterization exposes a flashing edge on resize.
            raster.SetShouldDetectMonitorScaleChanges(false)?;
            raster.SetRasterizationScale(1.0)?;
            controller.SetZoomFactor(zoom)
        })();
        if result.is_err() {
            let _ = raster.SetRasterizationScale(old_scale);
            let _ = controller.SetZoomFactor(old_zoom);
            let _ = raster.SetShouldDetectMonitorScaleChanges(old_auto.as_bool());
        }
        result
    }
}

/// Checks the real controller in the isolated packaged smoke process.
#[cfg(all(windows, feature = "smoke-test"))]
pub(crate) async fn smoke_check(window: &WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows::core::{BOOL, Interface};

    apply(window).await.map_err(|e| format!("{e:?}"))?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window.with_webview(move |webview| {
        let result = (|| -> Result<(), String> {
            let expected = target.scale_factor().map_err(|e| e.to_string())?
                * target.state::<InterfaceScale>().get();
            let controller = webview.controller();
            let raster = controller.cast::<ICoreWebView2Controller3>().map_err(|e| e.to_string())?;
            let (mut scale, mut zoom, mut auto) = (0.0, 0.0, BOOL::default());
            unsafe {
                raster.RasterizationScale(&mut scale).map_err(|e| e.to_string())?;
                raster.ShouldDetectMonitorScaleChanges(&mut auto).map_err(|e| e.to_string())?;
                controller.ZoomFactor(&mut zoom).map_err(|e| e.to_string())?;
            }
            if scale != 1.0 || auto.as_bool() || (zoom - expected).abs() > 0.0001 {
                return Err(format!("Unexpected WebView scale: raster={scale}, auto={auto:?}, zoom={zoom}, expected={expected}"));
            }
            Ok(())
        })();
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_smallest_window_grows_with_the_scale_as_far_as_the_screen_holds() {
        let roomy = (2560.0, 1400.0);
        assert_eq!(scaled_min_size(1.0, roomy), MIN_SIZE);
        assert_eq!(scaled_min_size(0.8, roomy), MIN_SIZE);
        assert_eq!(scaled_min_size(1.5, roomy), (720.0, 780.0));
        // 1920x1080 at 200 % with a taskbar: no taller than the work area,
        // and never below the minimum the page was made for.
        assert_eq!(scaled_min_size(1.5, (960.0, 516.0)), (720.0, 520.0));
    }

    #[test]
    fn invalid_requests_preserve_the_latest_preference() {
        let scale = InterfaceScale::default();
        scale.set(1.125).unwrap();
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.79, 1.51] {
            assert!(scale.set(invalid).is_err());
            assert_eq!(scale.get(), 1.125);
        }
        for valid in [0.8, 1.0, 1.5] {
            scale.set(valid).unwrap();
            assert_eq!(scale.get(), valid);
        }
    }
}
