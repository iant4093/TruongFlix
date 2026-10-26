//! Windows video surface for the built-in player.
//!
//! WebView2 lives in its own child HWND, and Windows won't let a sibling child HWND show through
//! it (the "airspace" problem). Instead mpv renders (`--wid`) into a borderless popup window that
//! sits directly *behind* the TruongFlix window, matching its client area. The TruongFlix window
//! is transparent on Windows (DWM blur-behind), so wherever the page is transparent the video shows
//! through. While playing full-window, the popup *owns* the main window: Windows always keeps owned
//! windows above their owner, so the UI can never fall behind the video.
//!
//! Mini-player: ownership flips — the popup becomes owned *by* the main window, so it floats above
//! the page in a corner. It is click-through (HTTRANSPARENT), so the page handles all input.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, GetStockObject, BLACK_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW, IsIconic, RegisterClassExW,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWLP_HWNDPARENT, GWL_EXSTYLE, HTTRANSPARENT, MA_NOACTIVATE,
    SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, WM_MOUSEACTIVATE, WM_NCHITTEST, WNDCLASSEXW,
    WS_CLIPCHILDREN, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};

/// The video popup and the main window it is attached to (as integers so they're `Send`).
static VIDEO: AtomicIsize = AtomicIsize::new(0);
static MAIN: AtomicIsize = AtomicIsize::new(0);
/// Mini-player rectangle in CSS pixels relative to the main window's client area.
static MINI: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        // Never take focus away from the TruongFlix window.
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        // Clicks pass through to the TruongFlix window underneath (same thread).
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn class_name() -> &'static [u16] {
    static CLASS: OnceLock<Vec<u16>> = OnceLock::new();
    CLASS.get_or_init(|| {
        let name = wide("TruongFlixVideoSurface");
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
                hbrBackground: GetStockObject(BLACK_BRUSH),
                lpszMenuName: std::ptr::null(),
                lpszClassName: name.as_ptr(),
                hIconSm: std::ptr::null_mut(),
            };
            RegisterClassExW(&wc);
        }
        name
    })
}

/// Client area of the main window in screen coordinates (physical pixels).
unsafe fn client_rect_on_screen(main: HWND) -> RECT {
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    GetClientRect(main, &mut rect);
    let mut origin = POINT { x: 0, y: 0 };
    ClientToScreen(main, &mut origin);
    RECT { left: origin.x, top: origin.y, right: origin.x + rect.right, bottom: origin.y + rect.bottom }
}

/// Creates the video popup behind `main` and returns its HWND for mpv's `wid`. Main thread only.
pub fn attach(main_hwnd: isize) -> Result<isize, String> {
    release();
    destroy();
    *MINI.lock().unwrap() = None;
    unsafe {
        let main = main_hwnd as HWND;
        let r = client_rect_on_screen(main);
        let title = wide("TruongFlix Video");
        let video = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name().as_ptr(),
            title.as_ptr(),
            WS_POPUP | WS_CLIPCHILDREN,
            r.left,
            r.top,
            (r.right - r.left).max(1),
            (r.bottom - r.top).max(1),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        if video.is_null() {
            return Err("Couldn’t create the video window".into());
        }
        VIDEO.store(video as isize, Ordering::Release);
        MAIN.store(main_hwnd, Ordering::Release);
        // Owned windows normally lose their taskbar button; keep TruongFlix in the taskbar.
        let ex = GetWindowLongPtrW(main, GWL_EXSTYLE);
        SetWindowLongPtrW(main, GWL_EXSTYLE, ex | WS_EX_APPWINDOW as isize);
        apply_ownership(false);
        ShowWindow(video, SW_SHOWNOACTIVATE);
        sync();
        Ok(video as isize)
    }
}

/// Full-window: the popup owns the main window (UI above video).
/// Mini: the main window owns the popup (video above UI).
unsafe fn apply_ownership(mini: bool) {
    let (video, main) = (VIDEO.load(Ordering::Acquire) as HWND, MAIN.load(Ordering::Acquire) as HWND);
    if video.is_null() || main.is_null() {
        return;
    }
    if mini {
        SetWindowLongPtrW(main, GWLP_HWNDPARENT, 0);
        SetWindowLongPtrW(video, GWLP_HWNDPARENT, main as isize);
    } else {
        SetWindowLongPtrW(video, GWLP_HWNDPARENT, 0);
        SetWindowLongPtrW(main, GWLP_HWNDPARENT, video as isize);
    }
}

/// Switches between full-window and mini-player (`rect` in CSS pixels). Main thread only.
pub fn set_layout(mini: Option<(f64, f64, f64, f64)>) {
    *MINI.lock().unwrap() = mini;
    unsafe { apply_ownership(mini.is_some()) };
    sync();
}

/// Keeps the popup glued to the main window (move/resize/fullscreen/minimize).
pub fn sync() {
    let (video, main) = (VIDEO.load(Ordering::Acquire) as HWND, MAIN.load(Ordering::Acquire) as HWND);
    if video.is_null() || main.is_null() {
        return;
    }
    unsafe {
        if IsIconic(main) != 0 {
            ShowWindow(video, SW_HIDE);
            return;
        }
        let client = client_rect_on_screen(main);
        let mini = *MINI.lock().unwrap();
        let (x, y, w, h, insert_after) = match mini {
            Some((mx, my, mw, mh)) => {
                let scale = GetDpiForWindow(main).max(96) as f64 / 96.0;
                // Above the main window: insert at the top of the owner's z-order group.
                (
                    client.left + (mx * scale).round() as i32,
                    client.top + (my * scale).round() as i32,
                    (mw * scale).round() as i32,
                    (mh * scale).round() as i32,
                    std::ptr::null_mut(), // HWND_TOP
                )
            }
            None => (client.left, client.top, client.right - client.left, client.bottom - client.top, main),
        };
        SetWindowPos(video, insert_after, x, y, w.max(1), h.max(1), SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

/// Detaches the UI from the video popup and hides it (playback is stopping). Main thread only.
pub fn release() {
    let main = MAIN.swap(0, Ordering::AcqRel) as HWND;
    let video = VIDEO.load(Ordering::Acquire) as HWND;
    unsafe {
        if !main.is_null() {
            SetWindowLongPtrW(main, GWLP_HWNDPARENT, 0);
        }
        if !video.is_null() {
            SetWindowLongPtrW(video, GWLP_HWNDPARENT, 0);
            ShowWindow(video, SW_HIDE);
        }
    }
}

/// Destroys the popup once mpv no longer renders into it. Main thread only.
pub fn destroy() {
    let video = VIDEO.swap(0, Ordering::AcqRel) as HWND;
    if !video.is_null() {
        unsafe {
            DestroyWindow(video);
        }
    }
}
