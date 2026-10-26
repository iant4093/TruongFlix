//! Emits `system-pause` when the screen locks, the display sleeps or the computer goes to sleep
//! (including closing a laptop lid), so playback can pause instead of carrying on unseen.

use serde::Serialize;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Serialize)]
struct Pause {
    reason: &'static str,
}

fn emit(reason: &'static str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("system-pause", Pause { reason });
    }
}

/// Starts listening. Call once, on the main thread.
pub fn start(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        platform::start();
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::emit;
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    unsafe fn observe(center: *mut AnyObject, name: &str, reason: &'static str) {
        let name = NSString::from_str(name);
        let block = RcBlock::new(move |_note: *mut AnyObject| emit(reason));
        let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
        let nil: *mut AnyObject = std::ptr::null_mut();
        // The returned observer token is kept for the app's lifetime.
        let token: *mut AnyObject = msg_send![center, addObserverForName: &*name, object: nil, queue: queue, usingBlock: &*block];
        let _: *mut AnyObject = msg_send![token, retain];
    }

    pub fn start() {
        unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let center: *mut AnyObject = msg_send![workspace, notificationCenter];
            observe(center, "NSWorkspaceWillSleepNotification", "sleep");
            observe(center, "NSWorkspaceScreensDidSleepNotification", "display");
            let distributed: *mut AnyObject = msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
            observe(distributed, "com.apple.screenIsLocked", "lock");
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::emit;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassExW, PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSEXW,
        WS_EX_TOOLWINDOW, WS_POPUP, WTS_SESSION_LOCK,
    };

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_WTSSESSION_CHANGE if wparam as u32 == WTS_SESSION_LOCK => emit("lock"),
            WM_POWERBROADCAST if wparam as u32 == PBT_APMSUSPEND => emit("sleep"),
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub fn start() {
        let class: Vec<u16> = "TruongFlixPowerWatcher\0".encode_utf16().collect();
        unsafe {
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: 0,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
                hIconSm: std::ptr::null_mut(),
            };
            RegisterClassExW(&wc);
            // A hidden top-level window (message-only windows don't get power broadcasts).
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            if !hwnd.is_null() {
                WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn start() {}
}
