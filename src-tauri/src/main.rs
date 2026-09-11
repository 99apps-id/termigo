// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: This block calls into the Objective-C runtime to disable the
        // macOS press-and-hold character popup. This is a pure configuration
        // change to a system defaults domain — no user input is processed, no
        // memory is dereferenced beyond the well-known NSUserDefaults API, and
        // the operation is idempotent. It is intentionally `unsafe` because
        // FFI into Objective-C requires an unsafe block per Rust's guarantees.
        use objc2::msg_send;
        use objc2_foundation::{ns_string, NSUserDefaults};
        unsafe {
            let defaults = NSUserDefaults.standardUserDefaults();
            let key = ns_string!("ApplePressAndHoldEnabled");
            let _: () = msg_send![&defaults, setBool: false, forKey: key];
        }
    }

    termigo_lib::run()
}
