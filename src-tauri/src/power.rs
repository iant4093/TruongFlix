//! Emits `system-pause` when the screen locks, the display sleeps or the computer goes to sleep
//! (including closing a laptop lid), so playback can pause instead of carrying on unseen.
//! While something plays, `keep_awake` stops the display from sleeping and the screen from
//! locking on its own; a lock the user starts still pauses playback.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static AWAKE: Mutex<bool> = Mutex::new(false);

/// Keeps the display on (so the screen doesn't idle-lock) while `on` is true.
#[tauri::command]
pub fn keep_awake(on: bool) -> Result<(), String> {
    let mut awake = AWAKE.lock().map_err(|e| e.to_string())?;
    if *awake == on {
        return Ok(());
    }
    awake::set(on)?;
    *awake = on;
    Ok(())
}

#[cfg(windows)]
mod awake {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0};

    /// One power request for the app's lifetime (shown by `powercfg /requests`). Unlike
    /// `SetThreadExecutionState` it isn't tied to the calling thread.
    static REQUEST: OnceLock<usize> = OnceLock::new();

    fn request() -> Result<usize, String> {
        if let Some(handle) = REQUEST.get() {
            return Ok(*handle);
        }
        // Leaked on purpose: Windows keeps a pointer to the reason for the request's lifetime.
        let reason: &'static mut [u16] = Box::leak("Playing video in TruongFlix\0".encode_utf16().collect::<Vec<u16>>().into_boxed_slice());
        let context = REASON_CONTEXT {
            Version: 0,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 { SimpleReasonString: reason.as_mut_ptr() },
        };
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() || handle as isize == -1 {
            return Err("Windows refused the power request".into());
        }
        Ok(*REQUEST.get_or_init(|| handle as usize))
    }

    pub fn set(on: bool) -> Result<(), String> {
        let handle = request()? as windows_sys::Win32::Foundation::HANDLE;
        for kind in [PowerRequestDisplayRequired, PowerRequestSystemRequired] {
            let ok = unsafe { if on { PowerSetRequest(handle, kind) } else { PowerClearRequest(handle, kind) } };
            if ok == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod awake {
    use objc2_foundation::NSString;
    use std::ffi::c_void;
    use std::sync::Mutex;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(kind: *const c_void, level: u32, name: *const c_void, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    const LEVEL_ON: u32 = 255;
    static ASSERTION: Mutex<Option<u32>> = Mutex::new(None);

    pub fn set(on: bool) -> Result<(), String> {
        let mut current = ASSERTION.lock().map_err(|e| e.to_string())?;
        if let Some(id) = current.take() {
            unsafe { IOPMAssertionRelease(id) };
        }
        if on {
            // NSString is toll-free bridged with CFString.
            let kind = NSString::from_str("PreventUserIdleDisplaySleep");
            let name = NSString::from_str("Playing video in TruongFlix");
            let mut id = 0u32;
            let status = unsafe {
                IOPMAssertionCreateWithName(&*kind as *const NSString as *const c_void, LEVEL_ON, &*name as *const NSString as *const c_void, &mut id)
            };
            if status != 0 {
                return Err(format!("macOS refused the power assertion ({status})"));
            }
            *current = Some(id);
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod awake {
    pub fn set(_on: bool) -> Result<(), String> {
        Ok(())
    }
}

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

#[cfg(test)]
mod tests {
    #[test]
    fn keep_awake_turns_on_and_off() {
        super::keep_awake(true).unwrap();
        super::keep_awake(true).unwrap();
        super::keep_awake(false).unwrap();
        super::keep_awake(false).unwrap();
    }
}
