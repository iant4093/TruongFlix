use super::*;
use objc2::{
    class, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, ProtocolObject},
    DeclaredClass, MainThreadOnly,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSString};
use objc2_web_kit::{WKScriptMessage, WKScriptMessageHandler, WKUserContentController};

pub struct ReceiverState {
    app: tauri::AppHandle,
    request_id: String,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ReceiverState]
    pub struct SourceMessageReceiver;
    unsafe impl NSObjectProtocol for SourceMessageReceiver {}
    unsafe impl WKScriptMessageHandler for SourceMessageReceiver {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            unsafe {
                if !message.frameInfo().isMainFrame() {
                    return;
                }
                let Ok(body) = message.body().downcast::<NSString>() else {
                    return;
                };
                if body.len() > MAX_EVENT {
                    return;
                }
                let Some(url) = message
                    .frameInfo()
                    .request()
                    .URL()
                    .and_then(|u| u.absoluteString())
                else {
                    return;
                };
                let app = self.ivars().app.clone();
                let id = self.ivars().request_id.clone();
                let data = body.to_string();
                let source = url.to_string();
                tauri::async_runtime::spawn(async move {
                    handle_message(&app, &id, &source, &data);
                });
            }
        }
    }
);

pub fn install(
    browser: &WebviewWindow,
    rules: Arc<Rules>,
    url: tauri::Url,
    id: String,
) -> Result<(), String> {
    let target = browser.clone();
    browser.with_webview(move |platform| unsafe {
        let controller = Retained::<WKUserContentController>::retain(platform.controller().cast()).unwrap();
        let receiver = MainThreadMarker::new().unwrap().alloc::<SourceMessageReceiver>().set_ivars(ReceiverState { app: target.app_handle().clone(), request_id: id.clone() });
        let receiver: Retained<SourceMessageReceiver> = msg_send![super(receiver), init];
        controller.addScriptMessageHandler_name(ProtocolObject::from_ref(&*receiver), &NSString::from_str("truongflixSource"));
        let store: *mut AnyObject = msg_send![class!(WKContentRuleListStore), defaultStore];
        let json = NSString::from_str(&rules.webkit);
        let name = NSString::from_str("TruongFlixSourceFilters");
        let done = block2::RcBlock::new(move |list: *mut AnyObject, error: *mut AnyObject| {
            let app = target.app_handle();
            let active = app.state::<SourceState>().0.lock().unwrap().as_ref().is_some_and(|s| s.request_id == id);
            if !active { return; }
            if list.is_null() || !error.is_null() {
                let mut e = event(&id, "error"); e.message = Some("Ad protection could not be prepared. Close and reopen the source browser to retry.".into());
                publish(app, e); return;
            }
            let _: () = msg_send![&*controller, addContentRuleList:list];
            finish_open(&target, url.clone(), &id);
        });
        let _: () = msg_send![store, compileContentRuleListForIdentifier:&*name, encodedContentRuleList:&*json, completionHandler:&*done];
    }).map_err(|e| e.to_string())
}

pub struct PaneParent {
    view: usize,
    content: usize,
}
pub fn pane_parent(parent: &tauri::webview::PlatformWebview) -> Result<PaneParent, String> {
    unsafe {
        let window = parent.ns_window().cast::<AnyObject>();
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return Err("The library window is closed".into());
        }
        Ok(PaneParent {
            view: parent.inner() as usize,
            content: content as usize,
        })
    }
}
pub fn place_pane(
    view: &tauri::webview::PlatformWebview,
    parent: PaneParent,
    rect: super::pane::PaneRect,
) -> Result<(), String> {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    unsafe {
        let source = view.inner().cast::<AnyObject>();
        let origin = parent.view as *mut AnyObject;
        let content = parent.content as *mut AnyObject;
        let bounds: NSRect = msg_send![origin, bounds];
        let scale = bounds.size.width / rect.viewport_width;
        let inset = (bounds.size.height - rect.viewport_height * scale).max(0.0);
        let y = rect.y * scale + inset;
        let height = rect.height * scale;
        let flipped: bool = msg_send![origin, isFlipped];
        let y = if flipped {
            y
        } else {
            bounds.size.height - y - height
        };
        let local = NSRect::new(
            NSPoint::new(rect.x * scale, y),
            NSSize::new(rect.width * scale, height),
        );
        let frame: NSRect = msg_send![content, convertRect: local, fromView: origin];
        let _: () = msg_send![source, removeFromSuperview];
        let _: () = msg_send![source, setAutoresizingMask: 0usize];
        let _: () = msg_send![source, setFrame: frame];
        let _: () = msg_send![content, addSubview: source, positioned: 1isize, relativeTo: origin];
        let _: () = msg_send![source, setHidden: false];
    }
    Ok(())
}
pub fn hide_pane(view: &tauri::webview::PlatformWebview, detach: bool) -> Result<(), String> {
    unsafe {
        let source = view.inner().cast::<AnyObject>();
        let _: () = msg_send![source, setHidden: true];
        if detach {
            let _: () = msg_send![source, removeFromSuperview];
        }
    }
    Ok(())
}
