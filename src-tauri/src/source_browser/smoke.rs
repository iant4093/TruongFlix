//! Built only for the CI smoke-test example; excluded from normal application builds.
use super::*;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU8, Ordering},
    time::Duration,
};
use tauri::Listener;

const REQUEST: &str = "native-source-smoke";
const MAGNET: &str = "magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=Fixture";
const FIXTURE: &str = r##"<!doctype html><html><head><meta charset="utf-8"><title>Fixture (1 Results)</title></head><body>
<div class="qa-ad">This test advertisement must be hidden</div>
<script src="/source-test-ad.js"></script><script src="/essential.js"></script>
<table><thead><tr><th>TORRENT NAME</th><th>SIZE</th><th>FILES</th><th>AGE</th><th>SEEDS</th><th>LEECHS</th></tr></thead><tbody><tr><td><a id="release" href="#">Waiting</a><a class="search-magnet-btn" data-id="123" href="javascript:void(0)">Download</a></td><td><span class="add-block">Size</span>1 MB</td><td>1</td><td>Today</td><td><span class="add-block">Seeds</span>25</td><td>0</td></tr></tbody></table>
<a id="manual-link" href="magnet:?xt=urn:btih:0000000000000000000000000000000000000000&amp;dn=Fixture">Manual magnet</a>
<script>
const timer=setInterval(()=>{if(getComputedStyle(document.querySelector('.qa-ad')).display==='none' && window.essentialLoaded){document.querySelector('#release').textContent='Fixture Film 2024 1080p';clearInterval(timer);}},50);
document.querySelector('.search-magnet-btn').onclick=()=>setTimeout(()=>{const link=document.createElement('a');link.href='magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=Fixture';link.hidden=true;document.body.appendChild(link);link.click();link.remove();},100);
window.open('https://popup.invalid/', '_blank');
</script></body></html>"##;

fn report(app: &tauri::AppHandle, path: &PathBuf, passed: bool, message: &str) {
    let result = serde_json::json!({"passed":passed,"message":message});
    let _ = fs::write(path, result.to_string());
    let ui_app = app.clone();
    let message = message.to_owned();
    let _ = app.run_on_main_thread(move || {
    if let Some(browser) = ui_app.get_webview_window(LABEL) { let _ = browser.destroy(); }
    if let Some(main) = ui_app.get_webview_window("main") {
        let _ = main.set_title(if passed { "Source browser checks passed" } else { "Source browser checks failed" });
        let page = format!("data:text/html,<body style='background:rgb(20,20,20);color:white;font:24px system-ui;padding:60px'>{message}</body>");
        if let Ok(url) = page.parse() { let _ = main.navigate(url); }
        let _ = main.show(); let _ = main.set_focus();
    }
    if std::env::var_os("CI").is_some() { ui_app.exit(if passed { 0 } else { 1 }); }
    });
}

pub fn run() {
    let output = std::env::var_os("TRUONGFLIX_SOURCE_SMOKE_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("truongflix-source-smoke-result.json"));
    let _ = fs::remove_file(&output);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let server_requests = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).unwrap_or(0);
            let path = String::from_utf8_lossy(&buffer[..n])
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_owned();
            server_requests.lock().unwrap().push(path.clone());
            let (body, kind) = if path == "/essential.js" {
                ("window.essentialLoaded=true;", "text/javascript")
            } else if path == "/source-test-ad.js" {
                ("window.unwantedAdLoaded=true;", "text/javascript")
            } else {
                (FIXTURE, "text/html")
            };
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        }
    });
    let rules = Arc::new(Rules::compile("/source-test-ad.js$script\n##.qa-ad", 0, true).unwrap());
    let phase = Arc::new(AtomicU8::new(0));
    let done = Arc::new(AtomicBool::new(false));
    // Independent of the UI/runtime: initialization deadlocks must still produce a CI report.
    let timeout_done = done.clone();
    let timeout_phase = phase.clone();
    let timeout_output = output.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(35));
        if !timeout_done.swap(true, Ordering::SeqCst) {
            let result = serde_json::json!({"passed":false,"message":format!("Native source browser smoke timed out at phase {}", timeout_phase.load(Ordering::SeqCst))});
            let _ = fs::write(timeout_output, result.to_string());
            if std::env::var_os("CI").is_some() {
                std::process::exit(1);
            }
        }
    });
    let mut context = crate::app_context();
    context.config_mut().identifier = "com.iantruong.truongflix.sourcesmoke".into();
    context.config_mut().product_name = Some("Source Browser Smoke".into());
    context.config_mut().app.windows.clear();
    tauri::Builder::default().manage(SourceState::default()).setup(move |app| {
        let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse().unwrap()))
            .title("Source browser integration checks").inner_size(800.0, 550.0).build()?;
        let _ = main.eval("document.body.textContent='Running native source browser checks…';document.body.style='background:#141414;color:white;font:24px system-ui;padding:60px';");
        *app.state::<SourceState>().0.lock().unwrap() = Some(Session { request_id: REQUEST.into(), origin: origin.clone(), imdb_id: "tt1234567".into(), pending: None, manual: false,
            releases: vec![], page: 1, challenge_shown: false, rules: Some(rules.clone()) });
        let event_app = app.handle().clone(); let event_main = main.clone();
        let event_done = done.clone(); let event_output = output.clone(); let event_requests = requests.clone();
        app.listen_any("source-browser", move |event| {
            let Ok(event) = serde_json::from_str::<SourceEvent>(event.payload()) else { return; };
            if event.request_id != REQUEST || event_done.load(Ordering::SeqCst) { return; }
            let current = phase.load(Ordering::SeqCst);
            if current == 0 && event.kind == "results" && event.releases.as_ref().is_some_and(|r| r.len() == 1 && r[0].title == "Fixture Film 2024 1080p" && r[0].seeders == Some(25) && r[0].size == "1 MB") {
                if phase.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_err() { return; }
                let app = event_app.clone(); let main = event_main.clone();
                tauri::async_runtime::spawn(async move { let _ = source_browser_control(app, main, REQUEST.into(), "capture".into(), Some("123".into()), None); });
            } else if current == 1 && event.kind == "magnet" && event.release_id.as_deref() == Some("123") && event.magnet.as_deref() == Some(MAGNET) {
                phase.store(2, Ordering::SeqCst);
                if let Some(session) = event_app.state::<SourceState>().0.lock().unwrap().as_mut() { session.manual = true; }
                if let Some(browser) = event_app.get_webview_window(LABEL) { let _ = browser.eval("document.getElementById('manual-link').click()"); }
            } else if current == 2 && event.kind == "magnet" && event.release_id.is_none() && event.magnet.as_deref() == Some(MAGNET) {
                phase.store(3, Ordering::SeqCst); event_done.store(true, Ordering::SeqCst);
                let paths = event_requests.lock().unwrap();
                let ok = paths.iter().any(|p| p == "/essential.js") && !paths.iter().any(|p| p == "/source-test-ad.js") && event_app.webview_windows().len() == 2;
                drop(paths);
                report(&event_app, &event_output, ok, if ok { "Native source browser checks passed: request filtering, cosmetic filtering, rendered results, automatic and manual magnet capture, and popup blocking." } else { "Native request filtering or popup blocking failed" });
            }
        });
        let nav_app = app.handle().clone(); let popup_app = app.handle().clone();
        let script = include_str!("adapter.js").replace("__SOURCE_CONFIG__", &serde_json::json!({"requestId":REQUEST,"imdbId":"tt1234567"}).to_string());
        let browser = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External("about:blank".parse().unwrap()))
            .title("Source fixture").visible(false).focused(false).initialization_script(script)
            .on_navigation(move |url| handle_navigation(&nav_app, REQUEST, url))
            .on_new_window(move |url, _| { if url.scheme() == "magnet" { handle_navigation(&popup_app, REQUEST, &url); } NewWindowResponse::Deny })
            .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny).on_download(|_,_|false).build()?;
        let url = format!("{origin}/browse/?imdb_id=tt1234567").parse().unwrap();
        install(&browser, rules, url, REQUEST.into())?;
        Ok(())
    }).run(context).expect("source browser smoke failed");
}
