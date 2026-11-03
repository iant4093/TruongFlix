//! Keep library content below the opaque macOS title bar, including while scrolling.
use objc2::{msg_send, runtime::AnyObject};

pub fn configure_main(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    // Tauri's visible title-bar style also enables full-size content for its devtools workaround.
    // Restore a standard content area so artwork cannot extend behind the traffic-light controls.
    let native = window.ns_window()?.cast::<AnyObject>();
    unsafe {
        let style: usize = msg_send![native, styleMask];
        let _: () = msg_send![native, setStyleMask: style & !(1usize << 15)];
        let _: () = msg_send![native, setTitlebarAppearsTransparent: false];
    }
    Ok(())
}
