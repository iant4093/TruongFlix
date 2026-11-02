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
