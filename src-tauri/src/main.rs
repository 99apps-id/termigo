// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    {
        // Disable the macOS press-and-hold character popup.
        //
        // These are objc2-foundation's declared methods rather than a raw
        // `msg_send!`, because the safe wrappers exist for both calls: the
        // macro form needed an `unsafe` block and, as written, did not compile
        // on macOS at all - `NSUserDefaults.standardUserDefaults()` is method
        // syntax on a type, which is E0423.
        use objc2_foundation::{ns_string, NSUserDefaults};
        let defaults = NSUserDefaults::standardUserDefaults();
        // `ns_string!` already yields `&NSString`, which is what the setter takes.
        defaults.setBool_forKey(false, ns_string!("ApplePressAndHoldEnabled"));
    }

    #[cfg(target_os = "linux")]
    {
        // Fix WebKitGTK freeze / hang on Linux (especially with NVIDIA, Mesa, Wayland & X11).
        // WebKitGTK 2.40+ DMA-BUF renderer frequently causes deadlocks where the window renders
        // but becomes completely unclickable, cannot resize or maximize, and ignores all events.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    termigo_lib::run()
}
