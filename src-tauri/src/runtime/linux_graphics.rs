//! Disables WebKitGTK accelerated compositing when Linux has no hardware GPU
//! render device (for example Hyper-V `hyperv_drm`, `simpledrm`, or software
//! Mesa `llvmpipe`). Without a GPU render node, WebKitGTK runs its async
//! compositor on software OpenGL, causing interactive resize and maximize lag
//! behind the GTK window frame. Physical Linux desktops with a real GPU keep
//! full hardware-accelerated compositing untouched.

use std::ffi::OsStr;
use std::path::Path;

#[cfg(target_os = "linux")]
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
static DISABLED_REASON: OnceLock<&'static str> = OnceLock::new();

#[derive(Debug, Default)]
struct GraphicsProbe {
    webkit_override_set: bool,
    software_gl_forced: bool,
    sysfs_drm_readable: bool,
    has_hw_render_node: bool,
    has_nvidia_device: bool,
    has_wslg_gpu: bool,
}

fn env_is_truthy(value: Option<&OsStr>) -> bool {
    value
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(|raw| {
            matches!(
                raw.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

fn is_software_gallium_driver(value: Option<&OsStr>) -> bool {
    value
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(|raw| {
            matches!(
                raw.to_ascii_lowercase().as_str(),
                "llvmpipe" | "softpipe" | "swrast"
            )
        })
}

fn should_disable_compositing(probe: &GraphicsProbe) -> Option<&'static str> {
    if probe.webkit_override_set {
        return None;
    }
    if probe.software_gl_forced {
        return Some("software OpenGL forced by environment");
    }
    if probe.has_hw_render_node || probe.has_nvidia_device || probe.has_wslg_gpu {
        return None;
    }
    if !probe.sysfs_drm_readable {
        // A restricted sandbox may hide /sys/class/drm even when a GPU is
        // present; stay conservative and leave WebKitGTK's default intact.
        return None;
    }
    Some("no hardware GPU render device")
}

fn has_hardware_render_node_in(sysfs_drm: &Path, dev_dri: &Path) -> (bool, bool) {
    let Ok(entries) = std::fs::read_dir(sysfs_drm) else {
        return (false, false);
    };
    let mut saw_any_sysfs_render_node = false;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with("renderD") {
            continue;
        }
        saw_any_sysfs_render_node = true;
        let driver = std::fs::read_link(entry.path().join("device/driver"))
            .ok()
            .and_then(|target| target.file_name().map(|s| s.to_os_string()));
        if driver.as_deref() == Some(OsStr::new("vgem")) {
            continue;
        }
        return (true, true);
    }
    if !saw_any_sysfs_render_node
        && let Ok(dev_entries) = std::fs::read_dir(dev_dri)
        && dev_entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("renderD"))
        })
    {
        return (true, true);
    }
    (true, false)
}

#[cfg(target_os = "linux")]
fn probe_system() -> GraphicsProbe {
    let webkit_override_set = std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_some()
        || std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some()
        || std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_some();
    let software_gl_forced = env_is_truthy(std::env::var_os("LIBGL_ALWAYS_SOFTWARE").as_deref())
        || is_software_gallium_driver(std::env::var_os("GALLIUM_DRIVER").as_deref());
    let (sysfs_drm_readable, has_hw_render_node) =
        has_hardware_render_node_in(Path::new("/sys/class/drm"), Path::new("/dev/dri"));
    GraphicsProbe {
        webkit_override_set,
        software_gl_forced,
        sysfs_drm_readable,
        has_hw_render_node,
        has_nvidia_device: Path::new("/dev/nvidiactl").exists(),
        has_wslg_gpu: Path::new("/dev/dxg").exists(),
    }
}

/// Must be called at the very start of process startup before any threads,
/// GTK, or WebKitGTK are initialized.
#[cfg(target_os = "linux")]
pub(crate) fn configure_webkit_compositing() {
    let probe = probe_system();
    if let Some(reason) = should_disable_compositing(&probe) {
        // SAFETY: Called once at the very beginning of `app_lib::run()` before
        // Tokio, GTK, or any background thread is started.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        let _ = DISABLED_REASON.set(reason);
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn disabled_compositing_reason() -> Option<&'static str> {
    DISABLED_REASON.get().copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn respects_explicit_webkit_override() {
        let probe = GraphicsProbe {
            webkit_override_set: true,
            software_gl_forced: true,
            sysfs_drm_readable: true,
            ..GraphicsProbe::default()
        };
        assert_eq!(should_disable_compositing(&probe), None);
    }

    #[test]
    fn disables_compositing_when_software_gl_is_forced() {
        let probe = GraphicsProbe {
            software_gl_forced: true,
            sysfs_drm_readable: true,
            has_hw_render_node: true,
            ..GraphicsProbe::default()
        };
        assert_eq!(
            should_disable_compositing(&probe),
            Some("software OpenGL forced by environment")
        );
    }

    #[test]
    fn disables_compositing_on_display_only_vm_without_render_node() {
        let probe = GraphicsProbe {
            sysfs_drm_readable: true,
            ..GraphicsProbe::default()
        };
        assert_eq!(
            should_disable_compositing(&probe),
            Some("no hardware GPU render device")
        );
    }

    #[test]
    fn keeps_compositing_with_hardware_render_node_nvidia_or_wslg() {
        for probe in [
            GraphicsProbe {
                sysfs_drm_readable: true,
                has_hw_render_node: true,
                ..GraphicsProbe::default()
            },
            GraphicsProbe {
                sysfs_drm_readable: true,
                has_nvidia_device: true,
                ..GraphicsProbe::default()
            },
            GraphicsProbe {
                sysfs_drm_readable: true,
                has_wslg_gpu: true,
                ..GraphicsProbe::default()
            },
        ] {
            assert_eq!(should_disable_compositing(&probe), None);
        }
    }

    #[test]
    fn stays_conservative_when_sysfs_drm_is_unavailable() {
        let probe = GraphicsProbe {
            sysfs_drm_readable: false,
            ..GraphicsProbe::default()
        };
        assert_eq!(should_disable_compositing(&probe), None);
    }

    #[test]
    fn parses_software_gl_env_values() {
        assert!(env_is_truthy(Some(OsStr::new("1"))));
        assert!(env_is_truthy(Some(OsStr::new("true"))));
        assert!(env_is_truthy(Some(OsStr::new(" YES "))));
        assert!(!env_is_truthy(Some(OsStr::new("0"))));
        assert!(!env_is_truthy(None));

        assert!(is_software_gallium_driver(Some(OsStr::new("llvmpipe"))));
        assert!(is_software_gallium_driver(Some(OsStr::new("Softpipe"))));
        assert!(is_software_gallium_driver(Some(OsStr::new("swrast"))));
        assert!(!is_software_gallium_driver(Some(OsStr::new("radeonsi"))));
        assert!(!is_software_gallium_driver(None));
    }

    #[test]
    fn detects_card_only_sysfs_as_missing_hardware_render_node() {
        let base = std::env::temp_dir().join(format!("ftpeach-drm-test-{}", uuid::Uuid::new_v4()));
        let sysfs = base.join("sysfs");
        let dev = base.join("dev");
        fs::create_dir_all(sysfs.join("card0")).unwrap();
        fs::create_dir_all(&dev).unwrap();

        assert_eq!(has_hardware_render_node_in(&sysfs, &dev), (true, false));

        fs::create_dir_all(sysfs.join("renderD128")).unwrap();
        assert_eq!(has_hardware_render_node_in(&sysfs, &dev), (true, true));

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn ignores_vgem_software_render_node() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!("ftpeach-vgem-test-{}", uuid::Uuid::new_v4()));
        let sysfs = base.join("sysfs");
        let dev = base.join("dev");
        let driver_dir = base.join("drivers/vgem");
        fs::create_dir_all(sysfs.join("renderD128/device")).unwrap();
        fs::create_dir_all(&dev).unwrap();
        fs::create_dir_all(&driver_dir).unwrap();
        symlink(&driver_dir, sysfs.join("renderD128/device/driver")).unwrap();

        assert_eq!(has_hardware_render_node_in(&sysfs, &dev), (true, false));

        let _ = fs::remove_dir_all(&base);
    }
}
