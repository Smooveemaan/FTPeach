use anyhow::Context;
use gtk::prelude::*;

const STYLE: &[u8] = br#"
window.ftpeach-main { background-color: transparent; transition: none; }
window.ftpeach-main decoration {
  background-color: transparent;
  background-image: none;
  border: 0;
  padding: 0;
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.32);
  margin: 8px;
  transition: none;
}
window.ftpeach-main.maximized decoration,
window.ftpeach-main.fullscreen decoration,
window.ftpeach-main.tiled decoration,
window.ftpeach-main.solid-csd decoration {
  border-radius: 0;
  box-shadow: none;
  margin: 0;
}
"#;

pub(crate) fn install(window: &tauri::WebviewWindow) -> anyhow::Result<()> {
    let window = window.gtk_window()?;
    let provider = gtk::CssProvider::new();
    provider.load_from_data(STYLE)?;
    let screen = GtkWindowExt::screen(&window).context("GTK window has no screen")?;
    gtk::StyleContext::add_provider_for_screen(
        &screen,
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
    window.style_context().add_class("ftpeach-main");
    // GTK owns the shadow and resize input region; the page keeps its own title bar.
    let titlebar = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    titlebar.set_no_show_all(true);
    window.set_titlebar(Some(&titlebar));
    window.set_decorated(true);
    Ok(())
}
