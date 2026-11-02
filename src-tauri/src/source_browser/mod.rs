//! An isolated, persistent source browser with a narrow untrusted-data bridge.
use crate::source_blocker::{self, Rules};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{
    webview::{NewWindowResponse, WebviewWindowBuilder},
    Emitter, Manager, WebviewUrl, WebviewWindow,
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(feature = "source-browser-smoke")]
pub mod smoke;
#[cfg(target_os = "windows")]
mod windows;
const LABEL: &str = "source-browser";
const MAX_EVENT: usize = 180_000;
#[derive(Default)]
pub struct SourceState(pub Mutex<Option<Session>>);
#[derive(Clone)]
pub struct Session {
    request_id: String,
    origin: String,
    imdb_id: String,
    pending: Option<String>,
    manual: bool,
    releases: Vec<Release>,
    page: u32,
    challenge_shown: bool,
    rules: Option<Arc<Rules>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    id: String,
    imdb_id: String,
    title: String,
    seeders: Option<u64>,
    size: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEvent {
    request_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    releases: Option<Vec<Release>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    magnet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
fn event(id: &str, kind: &str) -> SourceEvent {
    SourceEvent {
        request_id: id.into(),
        kind: kind.into(),
        page: None,
        releases: None,
        magnet: None,
        release_id: None,
        message: None,
    }
}
fn publish(app: &tauri::AppHandle, e: SourceEvent) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit_to("main", "source-browser", e);
    });
}

/// The platform bridge only accepts bounded data from the source's top-level origin.
/// It never dispatches commands supplied by the remote page.
fn handle_message(app: &tauri::AppHandle, id: &str, origin: &str, data: &str) {
    if data.len() > MAX_EVENT {
        return;
    }
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(data) else {
        return;
    };
    let state = app.state::<SourceState>();
    let mut guard = state.0.lock().unwrap();
    let Some(session) = guard.as_mut().filter(|s| s.request_id == id) else {
        return;
    };
    if raw["requestId"].as_str() != Some(id)
        || tauri::Url::parse(origin)
            .ok()
            .map(|u| u.origin().ascii_serialization())
            .as_ref()
            != Some(&session.origin)
    {
        return;
    }
    if raw["kind"] == "challenge" {
        if session.challenge_shown {
            return;
        }
        session.challenge_shown = true;
        drop(guard);
        if let Some(browser) = app.get_webview_window(LABEL) {
            let _ = browser.show();
            let _ = browser.set_focus();
        }
        publish(app, event(id, "challenge"));
        return;
    }
    if raw["kind"] == "cosmetic" {
        let origin = session.origin.clone();
        let rules = session.rules.clone();
        drop(guard);
        let Some(rules) = rules else {
            return;
        };
        let names = |key: &str| {
            raw[key]
                .as_array()
                .map(|a| {
                    a.iter()
                        .take(3000)
                        .filter_map(|v| v.as_str().filter(|s| s.len() < 150).map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let selectors = rules.cosmetic(&origin, names("classes"), names("ids"));
        if !selectors.is_empty() {
            if let Some(browser) = app.get_webview_window(LABEL) {
                let css = selectors
                    .into_iter()
                    .map(|s| format!("{s} {{ display:none !important; }}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let quoted = serde_json::to_string(&css).unwrap();
                let _ = browser.eval(format!("(() => {{ let s=document.getElementById('truongflix-ad-protection'); if(!s){{s=document.createElement('style');s.id='truongflix-ad-protection';document.head?.appendChild(s);}} if(s.textContent!=={quoted})s.textContent={quoted}; }})()"));
            }
        }
        return;
    }
    if let Ok(mut e) = serde_json::from_str::<SourceEvent>(data) {
        if e.kind == "results" && e.page == Some(session.page) {
            let rows: Vec<_> = e
                .releases
                .take()
                .unwrap_or_default()
                .into_iter()
                .take(100)
                .filter(|r| {
                    r.imdb_id == session.imdb_id
                        && !r.id.is_empty()
                        && r.id.len() <= 20
                        && r.id.bytes().all(|c| c.is_ascii_digit())
                        && !r.title.is_empty()
                        && r.title.len() <= 1000
                        && r.size.len() < 100
                })
                .collect();
            session.releases = rows.clone();
            session.challenge_shown = false;
            e.releases = Some(rows);
            drop(guard);
            publish(app, e);
        }
    }
}
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Source controls are only available to the library window".into())
    }
}
fn valid_id(id: &str) -> bool {
    id.len() >= 7
        && id.len() <= 14
        && id.starts_with("tt")
        && id[2..].bytes().all(|c| c.is_ascii_digit())
}
fn source_origin(raw: &str) -> Result<String, String> {
    let url =
        tauri::Url::parse(raw.trim()).map_err(|_| "Enter the source website's HTTPS address")?;
    let host = url.host_str().unwrap_or_default().trim_end_matches('.');
    if url.scheme() != "https"
        || !host.contains('.')
        || !url.username().is_empty()
        || url.password().is_some()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.parse::<std::net::IpAddr>().is_ok()
    {
        return Err(
            "Use a public HTTPS source website without login details in its address".into(),
        );
    }
    Ok(url.origin().ascii_serialization())
}
fn supported_magnet(url: &tauri::Url) -> bool {
    url.scheme() == "magnet"
        && url.as_str().len() <= 16_384
        && librqbit::Magnet::parse(url.as_str())
            .ok()
            .is_some_and(|m| m.as_id20().is_some())
}
fn handle_navigation(app: &tauri::AppHandle, id: &str, url: &tauri::Url) -> bool {
    let state = app.state::<SourceState>();
    let mut guard = state.0.lock().unwrap();
    let Some(session) = guard.as_mut().filter(|s| s.request_id == id) else {
        return false;
    };
    if url.scheme() == "magnet" {
        if supported_magnet(url) {
            let pending = session.pending.take();
            if pending.is_some() || session.manual {
                let mut e = event(id, "magnet");
                e.magnet = Some(url.to_string());
                e.release_id = pending;
                publish(app, e);
            }
        } else {
            let mut e = event(id, "error");
            e.message =
                Some("This magnet does not contain a supported BitTorrent v1 identity".into());
            publish(app, e);
        }
        return false;
    }
    // Ad redirects must not replace the source page; Cloudflare's challenge frames remain usable.
    matches!(url.scheme(), "about" | "blob" | "data")
        || (url.origin().ascii_serialization() == session.origin
            || (url.scheme() == "https" && url.host_str() == Some("challenges.cloudflare.com")))
}

#[tauri::command]
pub async fn source_browser_open(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    source_url: String,
    imdb_id: String,
    manual: bool,
) -> Result<source_blocker::Status, String> {
    main_only(&window)?;
    if request_id.len() < 8 || request_id.len() > 100 || !valid_id(&imdb_id) {
        return Err("Invalid source request".into());
    }
    let origin = source_origin(&source_url)?;
    // Mark ownership before asynchronous filter loading so a canceled/older request cannot open later.
    *app.state::<SourceState>().0.lock().unwrap() = Some(Session {
        request_id: request_id.clone(),
        origin: origin.clone(),
        imdb_id: imdb_id.clone(),
        pending: None,
        manual,
        releases: vec![],
        page: 1,
        challenge_shown: false,
        rules: None,
    });
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let compile_cache = cache.clone();
    let rules = tauri::async_runtime::spawn_blocking(move || source_blocker::load(&compile_cache))
        .await
        .map_err(|e| e.to_string())??;
    {
        let state = app.state::<SourceState>();
        let mut guard = state.0.lock().unwrap();
        if let Some(session) = guard.as_mut().filter(|s| s.request_id == request_id) {
            session.rules = Some(rules.clone());
        }
    }
    let refresh_cache = cache.clone();
    tauri::async_runtime::spawn(async move {
        let _ = source_blocker::refresh(&refresh_cache).await;
    });
    let status = rules.status.clone();
    let handle = app.clone();
    let id = request_id.clone();
    app.run_on_main_thread(move || {
        let still_current = handle
            .state::<SourceState>()
            .0
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|s| s.request_id == id);
        if !still_current {
            return;
        }
        if let Some(old) = handle.get_webview_window(LABEL) {
            let _ = old.destroy();
        }
        let nav_app = handle.clone();
        let nav_id = id.clone();
        let popup_app = handle.clone();
        let popup_id = id.clone();
        let config = serde_json::json!({"requestId":id,"imdbId":imdb_id});
        let script = include_str!("adapter.js").replace("__SOURCE_CONFIG__", &config.to_string());
        let result = WebviewWindowBuilder::new(
            &handle,
            LABEL,
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .title("Source browser · Ad blocking on")
        .visible(false)
        .focused(false)
        .inner_size(1180.0, 800.0)
        .min_inner_size(800.0, 550.0)
        .initialization_script(script)
        .on_navigation(move |url| handle_navigation(&nav_app, &nav_id, url))
        .on_new_window(move |url, _| {
            if url.scheme() == "magnet" {
                handle_navigation(&popup_app, &popup_id, &url);
            }
            NewWindowResponse::Deny
        })
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .on_download(|_, _| false);
        #[cfg(target_os = "macos")]
        let result = result.data_store_identifier(*b"TruongFlixBrows1");
        #[cfg(target_os = "windows")]
        let result = result.data_directory(cache.join("source-browser"));
        let open = || -> Result<(), String> {
            let browser = result.build().map_err(|e| e.to_string())?;
            let close_app = handle.clone();
            let close_id = id.clone();
            browser.on_window_event(move |e| {
                if matches!(e, tauri::WindowEvent::Destroyed) {
                    let close_state = close_app.state::<SourceState>();
                    let mut guard = close_state.0.lock().unwrap();
                    if guard.as_ref().is_some_and(|s| s.request_id == close_id) {
                        *guard = None;
                        publish(&close_app, event(&close_id, "closed"));
                    }
                }
            });
            let mut url = tauri::Url::parse(&format!("{origin}/browse/")).unwrap();
            url.query_pairs_mut()
                .append_pair("imdb_id", &imdb_id)
                .append_pair("sort", "seed")
                .append_pair("order", "desc");
            install(&browser, rules, url, id.clone())?;
            Ok(())
        };
        if let Err(err) = open() {
            let mut e = event(&id, "error");
            e.message = Some(err);
            publish(&handle, e);
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(status)
}

#[tauri::command]
pub fn source_browser_control(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    action: String,
    release_id: Option<String>,
    page: Option<u32>,
) -> Result<(), String> {
    main_only(&window)?;
    let mut script = None;
    let mut destination = None;
    {
        let state = app.state::<SourceState>();
        let mut guard = state.0.lock().unwrap();
        let Some(session) = guard.as_mut().filter(|s| s.request_id == request_id) else {
            return Ok(());
        };
        match action.as_str() {
            "close" => *guard = None,
            "capture" => {
                let id = release_id
                    .filter(|id| session.releases.iter().any(|r| r.id == *id))
                    .ok_or("This release is no longer on the source page")?;
                session.pending = Some(id.clone());
                let quoted = serde_json::to_string(&id).unwrap();
                script = Some(format!("document.querySelector('.search-magnet-btn[data-id=' + CSS.escape({quoted}) + ']')?.click()"));
            }
            "page" => {
                let p = page
                    .filter(|p| (1..=3).contains(p))
                    .ok_or("Page is out of range")?;
                session.releases.clear();
                session.pending = None;
                session.page = p;
                let mut url = tauri::Url::parse(&format!("{}/browse/", session.origin)).unwrap();
                url.query_pairs_mut()
                    .append_pair("imdb_id", &session.imdb_id)
                    .append_pair("sort", "seed")
                    .append_pair("order", "desc")
                    .append_pair("page", &p.to_string());
                destination = Some(url);
            }
            "show" | "hide" | "reload" => (),
            _ => return Err("Unknown source browser action".into()),
        }
    }
    // Never hold the session mutex while calling back into the platform webview.
    let Some(browser) = app.get_webview_window(LABEL) else {
        return if action == "close" {
            Ok(())
        } else {
            Err("The source browser is closed".into())
        };
    };
    if let Some(script) = script {
        return browser.eval(script).map_err(|e| e.to_string());
    }
    if let Some(url) = destination {
        return browser.navigate(url).map_err(|e| e.to_string());
    }
    match action.as_str() {
        "close" => {
            let visible = browser.is_visible().unwrap_or(false);
            browser.destroy().map_err(|e| e.to_string())?;
            if visible {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_focus();
                }
            }
        }
        "hide" => {
            browser.hide().map_err(|e| e.to_string())?;
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_focus();
            }
        }
        "show" => {
            browser.show().map_err(|e| e.to_string())?;
            browser.set_focus().map_err(|e| e.to_string())?;
        }
        "reload" => browser.reload().map_err(|e| e.to_string())?,
        _ => (),
    }
    Ok(())
}

fn finish_open(browser: &WebviewWindow, url: tauri::Url, id: &str) {
    let app = browser.app_handle();
    let reveal = {
        let state = app.state::<SourceState>();
        let guard = state.0.lock().unwrap();
        let Some(session) = guard.as_ref().filter(|s| s.request_id == id) else {
            return;
        };
        session.manual
    };
    if browser.navigate(url).is_err() {
        return;
    }
    if reveal {
        let _ = browser.show();
        let _ = browser.set_focus();
    }
    publish(app, event(id, "ready"));
}

fn install(
    browser: &WebviewWindow,
    rules: Arc<Rules>,
    url: tauri::Url,
    id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::install(browser, rules, url, id)
    }
    #[cfg(target_os = "windows")]
    {
        windows::install(browser, rules, url, id)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (browser, rules, url, id);
        Err("Protected source browsing is supported on macOS and Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_source_and_identity() {
        assert_eq!(
            source_origin("https://ext.to/browse/").unwrap(),
            "https://ext.to"
        );
        for bad in [
            "http://ext.to",
            "file:///etc/passwd",
            "https://user:pass@ext.to",
            "https://127.0.0.1",
            "https://localhost",
        ] {
            assert!(source_origin(bad).is_err());
        }
        assert!(valid_id("tt12590266"));
        assert!(!valid_id("tt123<script>"));
        assert!(!supported_magnet(&"magnet:?dn=Something".parse().unwrap()));
        assert!(supported_magnet(
            &"magnet:?xt=urn:btih:0000000000000000000000000000000000000000"
                .parse()
                .unwrap()
        ));
    }
}
