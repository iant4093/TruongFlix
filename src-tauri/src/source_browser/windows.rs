use super::*;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler, WebResourceRequestedEventHandler};
use windows_webview::core::{w, PWSTR};
use windows_sys::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::MapWindowPoints,
    UI::WindowsAndMessaging::{
        GetParent, SetParent, SetWindowPos, ShowWindow, SW_HIDE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    },
};

pub fn install(
    browser: &WebviewWindow,
    rules: Arc<Rules>,
    url: tauri::Url,
    id: String,
) -> Result<(), String> {
    let target = browser.clone();
    browser.with_webview(move |platform| {
        let setup = || -> windows_webview::core::Result<()> { unsafe {
            let controller = platform.controller();
            let webview = controller.CoreWebView2()?;
            let env = platform.environment();
            webview.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
            let source = url.to_string();
            let mut cookie = 0;
            let app = target.app_handle().clone(); let message_id = id.clone();
            webview.add_WebMessageReceived(&WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let mut body = PWSTR::null(); let mut origin = PWSTR::null();
                args.TryGetWebMessageAsString(&mut body)?;
                let data = take_pwstr(body);
                if data.len() > MAX_EVENT { return Ok(()); }
                args.Source(&mut origin)?;
                let source = take_pwstr(origin); let app = app.clone(); let id = message_id.clone();
                tauri::async_runtime::spawn(async move { handle_message(&app, &id, &source, &data); });
                Ok(())
            })), &mut cookie)?;
            webview.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let request = args.Request()?;
                let mut uri = PWSTR::null(); request.Uri(&mut uri)?; let uri = take_pwstr(uri);
                let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                args.ResourceContext(&mut context)?;
                let kind = match context {
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST => "xmlhttprequest",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "subdocument",
                    _ => "other",
                };
                if rules.blocks(&uri, &source, kind) {
                    let response = env.CreateWebResourceResponse(None, 403, w!("Blocked by ad protection"), w!("Content-Length: 0\r\n"))?;
                    args.SetResponse(&response)?;
                }
                Ok(())
            })), &mut cookie)?;
            Ok(())
        }};
        match setup() {
            Ok(()) => {
                // Tauri holds the webview dispatcher lock during with_webview on Windows.
                // Re-entering navigate/show here deadlocks; dispatch after this callback returns.
                tauri::async_runtime::spawn(async move { finish_open(&target, url, &id); });
            }
            Err(_) => { let mut e = event(&id, "error"); e.message = Some("Ad protection could not be prepared. Update the WebView2 runtime and retry.".into()); publish(target.app_handle(), e); }
        }
    }).map_err(|e| e.to_string())
}

pub struct PaneParent {
    window: usize,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}
fn container(controller: &ICoreWebView2Controller) -> Result<HWND, String> {
    let mut hwnd = windows_webview::Win32::Foundation::HWND::default();
    unsafe { controller.ParentWindow(&mut hwnd) }.map_err(|e| e.to_string())?;
    Ok(hwnd.0)
}

pub fn pane_parent(parent: &tauri::webview::PlatformWebview) -> Result<PaneParent, String> {
    use windows_webview::Win32::Foundation::RECT;
    unsafe {
        let controller = parent.controller();
        let container = container(&controller)?;
        let window = GetParent(container);
        if window.is_null() {
            return Err("The library window is closed".into());
        }
        let mut bounds = RECT::default();
        controller.Bounds(&mut bounds).map_err(|e| e.to_string())?;
        let mut origin = POINT { x: bounds.left, y: bounds.top };
        MapWindowPoints(container, window, &mut origin, 1);
        Ok(PaneParent {
            window: window as usize,
            left: origin.x,
            top: origin.y,
            width: bounds.right - bounds.left,
            height: bounds.bottom - bounds.top,
        })
    }
}
pub fn place_pane(
    view: &tauri::webview::PlatformWebview,
    parent: PaneParent,
    rect: super::pane::PaneRect,
) -> Result<(), String> {
    use windows_webview::Win32::Foundation::RECT;
    unsafe {
        let controller = view.controller();
        let container = container(&controller)?;
        let window = parent.window as HWND;
        // Keep each WebView2 controller in its own Wry container. Sharing the
        // main controller's container can replace its transparent composition.
        if GetParent(container) != window {
            ShowWindow(container, SW_HIDE);
            if SetParent(container, window).is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let sx = f64::from(parent.width) / rect.viewport_width;
        let sy = f64::from(parent.height) / rect.viewport_height;
        let left = parent.left + (rect.x * sx).round() as i32;
        let top = parent.top + (rect.y * sy).round() as i32;
        let width = (rect.width * sx).round() as i32;
        let height = (rect.height * sy).round() as i32;
        controller
            .SetBounds(RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            })
            .map_err(|e| e.to_string())?;
        if SetWindowPos(
            container, std::ptr::null_mut(), left, top, width, height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        ) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        controller
            .NotifyParentWindowPositionChanged()
            .map_err(|e| e.to_string())?;
        controller.SetIsVisible(true).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn hide_pane(view: &tauri::webview::PlatformWebview, host: Option<usize>) -> Result<(), String> {
    unsafe {
        let controller = view.controller();
        let container = container(&controller)?;
        ShowWindow(container, SW_HIDE);
        let hidden = controller.SetIsVisible(false);
        // Wry destroys the container with its original window.
        if let Some(host) = host.map(|host| host as HWND) {
            if GetParent(container) != host && SetParent(container, host).is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        hidden.map_err(|e| e.to_string())
    }
}
