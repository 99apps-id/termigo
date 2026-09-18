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

    // Settings has 11 horizontal tabs, window controls, and detailed forms.
    // Base sizing on the active monitor resolution so that all tabs, menus,
    // and close controls are fully visible and comfortable, regardless of
    // whether the main window happens to be small or unmaximized.
    let (mon_w, mon_h) = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|mon| {
            let scale = mon.scale_factor().max(0.5);
            let size = mon.size();
            (size.width as f64 / scale, size.height as f64 / scale)
        })
        .unwrap_or((1280.0, 800.0));

    // Target size 1000x720 gives ample room for all 11 tabs, traffic lights /
    // close controls, and multi-column settings sections without horizontal scroll.
    // Clamp to 94% width and 90% height of the monitor for smaller screens.
    let w = 1000.0_f64.min(mon_w * 0.94).max(680.0);
    let h = 720.0_f64.min(mon_h * 0.90).max(520.0);
    let min_w = 680.0_f64.min(w);
    let min_h = 500.0_f64.min(h);

    let builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(w, h)
        .min_inner_size(min_w, min_h)
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
            let mut x = main_pos.x
                + ((main_size.width as i32).saturating_sub(settings_size.width as i32)) / 2;
            let mut y = main_pos.y
                + ((main_size.height as i32).saturating_sub(settings_size.height as i32)) / 2;

            // Ensure the window never spills off the screen edges (which would hide
            // the macOS traffic lights on the top-left or push the window under the menu bar).
            if let Ok(Some(mon)) = main.current_monitor() {
                let mon_pos = mon.position();
                let mon_size = mon.size();
                let min_x = mon_pos.x + 8;
                let max_x = (mon_pos.x + mon_size.width as i32 - settings_size.width as i32 - 8).max(min_x);
                let min_y = mon_pos.y + 32;
                let max_y = (mon_pos.y + mon_size.height as i32 - settings_size.height as i32 - 8).max(min_y);
                x = x.clamp(min_x, max_x);
                y = y.clamp(min_y, max_y);
            } else {
                x = x.max(8);
                y = y.max(32);
            }
            let _ = window.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = window.center();
        }
    }

    Ok(())
}
