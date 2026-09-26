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
