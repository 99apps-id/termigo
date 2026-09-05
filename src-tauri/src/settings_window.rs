use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::PhysicalPosition;

#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        // On macOS there is no parent to keep settings above the main window,
        // so it stays always-on-top there. On Windows/Linux the parent (below)
        // already keeps it above main without floating over other apps.
        #[cfg(target_os = "macos")]
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("termigo:settings-tab", t);
        }
        return Ok(());
    }

    // Fit the settings window inside the main window so it never spills past the
    // screen edge and hide its own close control on a small display. Preferred
    // size, but clamped to ~94% of the main window and floored so it still opens
    // sanely if the main window is tiny.
    let (win_w, win_h) = app
        .get_webview_window("main")
        .and_then(|m| {
            let scale = m.scale_factor().unwrap_or(1.0).max(0.5);
            m.inner_size()
                .ok()
                .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        })
        .unwrap_or((980.0, 760.0));
    // Hug the 640px content column (max-w-160 in SettingsApp) so the window
    // doesn't open far wider than its content with big empty side margins.
    let w = 840.0_f64.min(win_w * 0.94).max(560.0);
    let h = 760.0_f64.min(win_h * 0.94).max(460.0);
    let builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(w, h)
        .min_inner_size(w.min(560.0), h.min(440.0))
        .resizable(true)
        .center()
        .visible(false);

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    // macOS: skip parent() — child + always_on_top leaves the settings webview
    // behind the main window except while the parent is being dragged (#33).
    #[cfg(not(target_os = "macos"))]
    let builder = if let Some(main) = app.get_webview_window("main") {
        builder.parent(&main).map_err(|e| e.to_string())?
    } else {
        builder
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    // Only the Linux and macOS blocks below touch the handle, so on other
    // targets it is genuinely unused and would trip `-D warnings`.
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        allow(unused_variables)
    )]
    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag, so re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    // Keep settings above the main window on macOS (no parent relationship
    // exists there); on Windows/Linux the parent keeps it above main without
    // making it float over every other app.
    #[cfg(target_os = "macos")]
    let _ = window.set_always_on_top(true);

    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x
                + ((main_size.width as i32).saturating_sub(settings_size.width as i32)) / 2;
            let y = main_pos.y
                + ((main_size.height as i32).saturating_sub(settings_size.height as i32)) / 2;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = window.center();
        }
    }

    Ok(())
}
