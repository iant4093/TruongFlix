//! Built only for the CI smoke-test example; excluded from normal application builds.
use super::*;
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    time::Duration,
};
use tauri::Listener;

const REQUEST: &str = "native-source-smoke";
const MAGNET: &str = "magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=Fixture";
const MAIN_FIXTURE: &str = "<!doctype html><meta charset='utf-8'><body style='background:#141414;color:white;font:24px system-ui;padding:60px'>Running native source browser checks…<script>let frame=0;function tick(){document.title='frame:'+ ++frame;requestAnimationFrame(tick)}requestAnimationFrame(tick);</script></body>";
const DETAIL_FIXTURE: &str = "<!doctype html><meta charset='utf-8'><title>Manual release</title><body style='background:#092238;color:white'><h1>Manual release page</h1><a id='manual-link' href='magnet:?xt=urn:btih:0000000000000000000000000000000000000000&amp;dn=Fixture'>Select test magnet</a></body>";
const FIXTURE: &str = r##"<!doctype html><html><head><meta charset="utf-8"><title>Security verification</title><style>body{background:#092238;color:white;font:18px system-ui;margin:0;padding:20px}.verifying .qa-ad,.verifying table,#manual-link{display:none}#fixture-verify{padding:60px 20px;text-align:center}button{background:#e50914;border:0;color:white;padding:14px 22px;font-size:18px;border-radius:6px}</style></head><body class="verifying"><div id="fixture-verify"><h1>Verification panel</h1><p>Local fixture — not a CAPTCHA</p><button id="verify-test-page">Continue test</button></div>
<div class="qa-ad">This test advertisement must be hidden</div>
<script src="/source-test-ad.js"></script><script src="/essential.js"></script>
<table><thead><tr><th>TORRENT NAME</th><th>SIZE</th><th>FILES</th><th>AGE</th><th>SEEDS</th><th>LEECHS</th></tr></thead><tbody><tr><td><a id="release" href="#">Waiting</a><a class="search-magnet-btn" data-id="123" href="javascript:void(0)">Download</a></td><td><span class="add-block">Size</span>1 MB</td><td>1</td><td>Today</td><td><span class="add-block">Seeds</span>25</td><td>0</td></tr></tbody></table>
<a id="manual-link" href="magnet:?xt=urn:btih:0000000000000000000000000000000000000000&amp;dn=Fixture">Manual magnet</a>
<script>
document.getElementById('verify-test-page').onclick=()=>{document.title='Fixture (1 Results)';document.body.classList.remove('verifying');document.getElementById('fixture-verify').remove();};
const timer=setInterval(()=>{if(!document.body.classList.contains('verifying') && getComputedStyle(document.querySelector('.qa-ad')).display==='none' && window.essentialLoaded){document.querySelector('#release').textContent='Fixture Film 2024 1080p';clearInterval(timer);}},50);
document.querySelector('.search-magnet-btn').onclick=()=>setTimeout(()=>{const link=document.createElement('a');link.href='magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=Fixture';link.hidden=true;document.body.appendChild(link);link.click();link.remove();},100);
window.open('https://popup.invalid/', '_blank');
</script></body></html>"##;

fn report(app: &tauri::AppHandle, path: &PathBuf, passed: bool, message: &str) {
    let result = serde_json::json!({"passed":passed,"message":message});
    let _ = fs::write(path, result.to_string());
    let ui_app = app.clone();
    let message = message.to_owned();
    tauri::async_runtime::spawn(async move {
        if let Some(browser) = ui_app.get_webview_window(LABEL) {
            let _ = pane::hide(&browser, true).await;
        }
        let handle = ui_app.clone();
        let _ = ui_app.run_on_main_thread(move || {
    let ui_app = handle;
    if let Some(browser) = ui_app.get_webview_window(LABEL) { let _ = browser.destroy(); }
    if let Some(main) = ui_app.get_webview_window("main") {
        let _ = main.set_title(if passed { "Source browser checks passed" } else { "Source browser checks failed" });
        let page = format!("data:text/html,<body style='background:rgb(20,20,20);color:white;font:24px system-ui;padding:60px'>{message}</body>");
        if let Ok(url) = page.parse() { let _ = main.navigate(url); }
        let _ = main.show(); let _ = main.set_focus();
    }
    if std::env::var_os("CI").is_some() { ui_app.exit(if passed { 0 } else { 1 }); }
    });
    });
}

async fn wait_for_path(browser: &WebviewWindow, loaded: &Mutex<String>, path: &str) -> Result<(), String> {
    for _ in 0..40 {
        if loaded.lock().unwrap().as_str() == path && browser.url().is_ok_and(|url| url.path() == path) { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("Manual source navigation did not reach {path}; loaded={}; current={:?}", *loaded.lock().unwrap(), browser.url()))
}

async fn check_manual_browser(app: tauri::AppHandle, main: WebviewWindow, loaded: Arc<Mutex<String>>) -> Result<(), String> {
    // Quick results cleared the challenge flag. Manual placement must work without a challenge.
    let origin = {
        let state = app.state::<SourceState>(); let mut guard = state.0.lock().unwrap();
        let session = guard.as_mut().ok_or("Source session closed")?;
        if session.challenge_shown { return Err("Challenge did not clear".into()); }
        session.manual = true; session.origin.clone()
    };
    pane::source_browser_place(app.clone(), main.clone(), REQUEST.into(), Some(pane::PaneRect {
        x: 0.0, y: 64.0, width: 800.0, height: 478.0, viewport_width: 800.0, viewport_height: 550.0,
    })).await?;
    let browser = app.get_webview_window(LABEL).ok_or("Source view closed")?;
    if browser.is_visible().unwrap_or(true) || app.get_webview_window("main").is_none() {
        return Err("Manual browsing exposed a separate window".into());
    }
    if source_browser_control(app.clone(), main.clone(), REQUEST.into(), "show".into(), None, None).is_ok() {
        return Err("The source host can be shown separately".into());
    }
    browser.navigate(format!("{origin}/detail").parse().unwrap()).map_err(|e| e.to_string())?;
    wait_for_path(&browser, &loaded, "/detail").await?;
    source_browser_control(app.clone(), main.clone(), REQUEST.into(), "back".into(), None, None)?;
    wait_for_path(&browser, &loaded, "/browse/").await?;
    source_browser_control(app.clone(), main.clone(), REQUEST.into(), "forward".into(), None, None)?;
    wait_for_path(&browser, &loaded, "/detail").await?;
    loaded.lock().unwrap().clear();
    source_browser_control(app.clone(), main.clone(), REQUEST.into(), "reload".into(), None, None)?;
    wait_for_path(&browser, &loaded, "/detail").await?;
    browser.eval("(()=>{const select=()=>document.getElementById('manual-link')?.click();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',select,{once:true});else select()})()").map_err(|e| e.to_string())
}

pub fn run() {
    let output = std::env::var_os("TRUONGFLIX_SOURCE_SMOKE_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("truongflix-source-smoke-result.json"));
    let _ = fs::remove_file(&output);
    let _ = fs::remove_file(output.with_extension("panel-ready"));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let server_requests = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            let requests = server_requests.clone();
            // WebView2 may open idle speculative connections before requesting page assets.
            // Each connection must be independent so an idle socket cannot starve actual requests.
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                let mut buffer = [0; 4096];
                let Ok(n) = stream.read(&mut buffer) else {
                    return;
                };
                if n == 0 {
                    return;
                }
                let request = String::from_utf8_lossy(&buffer[..n]);
                let Some(path) = request.split_whitespace().nth(1) else {
                    return;
                };
                requests.lock().unwrap().push(path.to_owned());
                let (body, kind) = if path == "/main" {
                    (MAIN_FIXTURE, "text/html")
                } else if path == "/detail" {
                    (DETAIL_FIXTURE, "text/html")
                } else if path == "/essential.js" {
                    ("window.essentialLoaded=true;", "text/javascript")
                } else if path == "/source-test-ad.js" {
                    ("window.unwantedAdLoaded=true;", "text/javascript")
                } else {
                    (FIXTURE, "text/html")
                };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
            });
        }
    });
    // Reproduce a browser preconnection: the page must load while this socket sends nothing.
    let preconnection = TcpStream::connect(origin.trim_start_matches("http://")).unwrap();
    let mut check = TcpStream::connect(origin.trim_start_matches("http://")).unwrap();
    check
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    check
        .write_all(
            b"GET /preconnect-check HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
    let mut header = [0; 13];
    check
        .read_exact(&mut header)
        .expect("Idle preconnection blocked the fixture server");
    assert_eq!(&header, b"HTTP/1.1 200 ");
    drop(check);
    let rules = Arc::new(Rules::compile("/source-test-ad.js$script\n##.qa-ad", 0, true).unwrap());
    let phase = Arc::new(AtomicU8::new(0));
    let done = Arc::new(AtomicBool::new(false));
    // Independent of the UI/runtime: initialization deadlocks must still produce a CI report.
    let timeout_done = done.clone();
    let timeout_phase = phase.clone();
    let timeout_output = output.clone();
    let timeout_requests = requests.clone();
    let stage = Arc::new(Mutex::new(String::from("creating application context")));
    let timeout_stage = stage.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(35));
        if !timeout_done.swap(true, Ordering::SeqCst) {
            let result = serde_json::json!({"passed":false,"message":format!("Native source browser smoke timed out at phase {}", timeout_phase.load(Ordering::SeqCst)),"stage":*timeout_stage.lock().unwrap(),"requests":*timeout_requests.lock().unwrap()});
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
        *stage.lock().unwrap() = "creating main window".into();
        let frames = Arc::new(AtomicU64::new(0));
        let frame_events = frames.clone();
        let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("{origin}/main").parse().unwrap()))
            .on_document_title_changed(move |_, title| { if let Some(frame) = title.strip_prefix("frame:").and_then(|n| n.parse().ok()) { frame_events.store(frame, Ordering::SeqCst); } })
            .title("Source browser integration checks").inner_size(800.0, 550.0).build()?;
        #[cfg(target_os = "macos")]
        crate::window::configure_main(&main)?;
        *app.state::<SourceState>().0.lock().unwrap() = Some(Session { request_id: REQUEST.into(), origin: origin.clone(), imdb_id: "tt1234567".into(), pending: None, manual: false,
            releases: vec![], page: 1, challenge_shown: false, rules: Some(rules.clone()) });
        let event_app = app.handle().clone(); let event_main = main.clone();
        let event_stage = stage.clone();
        let event_done = done.clone(); let event_output = output.clone(); let event_requests = requests.clone();
        let loaded = Arc::new(Mutex::new(String::new())); let loaded_events = loaded.clone();
        app.listen_any("source-browser", move |event| {
            let Ok(event) = serde_json::from_str::<SourceEvent>(event.payload()) else { return; };
            if event.request_id != REQUEST || event_done.load(Ordering::SeqCst) { return; }
            *event_stage.lock().unwrap() = format!("{}: {}", event.kind, event.releases.as_ref().and_then(|r| r.first()).map(|r| r.title.as_str()).unwrap_or(""));
            let current = phase.load(Ordering::SeqCst);
            if current == 0 && event.kind == "challenge" {
                let app = event_app.clone(); let main = event_main.clone(); let output = event_output.clone(); let done = event_done.clone();
                tauri::async_runtime::spawn(async move {
                    let rect = pane::PaneRect { x:40.0, y:110.0, width:700.0, height:350.0, viewport_width:800.0, viewport_height:550.0 };
                    if let Err(error) = pane::source_browser_place(app.clone(), main, REQUEST.into(), Some(rect)).await {
                        done.store(true, Ordering::SeqCst); report(&app, &output, false, &error); return;
                    }
                    let Some(browser) = app.get_webview_window(LABEL) else { return; };
                    if browser.is_visible().unwrap_or(true) || app.get_webview_window("main").is_none() {
                        done.store(true, Ordering::SeqCst); report(&app, &output, false, "Quick search exposed a browser window or changed the library window"); return;
                    }
                    if let Some(main) = app.get_webview_window("main") {
                        if let (Ok(position), Ok(scale)) = (main.inner_position(), main.scale_factor()) {
                            let panel = serde_json::json!({"left":f64::from(position.x)+40.0*scale,"top":f64::from(position.y)+110.0*scale,"width":700.0*scale,"height":350.0*scale});
                            let _ = fs::write(output.with_extension("panel-ready"), panel.to_string());
                        }
                    }
                    if std::env::var_os("CI").is_some() {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        let _ = browser.eval("document.getElementById('verify-test-page').click()");
                    } else { let _ = app.get_webview_window("main").map(|w| w.set_title("Click Continue test in the verification panel")); }
                });
            } else if current == 0 && event.kind == "results" && event.releases.as_ref().is_some_and(|r| r.len() == 1 && r[0].title == "Fixture Film 2024 1080p" && r[0].seeders == Some(25) && r[0].size == "1 MB") {
                if phase.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_err() { return; }
                let app = event_app.clone(); let main = event_main.clone();
                tauri::async_runtime::spawn(async move { let _ = source_browser_control(app, main, REQUEST.into(), "capture".into(), Some("123".into()), None); });
            } else if current == 1 && event.kind == "magnet" && event.release_id.as_deref() == Some("123") && event.magnet.as_deref() == Some(MAGNET) {
                phase.store(2, Ordering::SeqCst);
                let app = event_app.clone(); let main = event_main.clone(); let output = event_output.clone(); let done = event_done.clone(); let loaded = loaded.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = check_manual_browser(app.clone(), main, loaded).await {
                        done.store(true, Ordering::SeqCst); report(&app, &output, false, &error);
                    }
                });
            } else if current == 2 && event.kind == "magnet" && event.release_id.is_none() && event.magnet.as_deref() == Some(MAGNET) {
                phase.store(3, Ordering::SeqCst); event_done.store(true, Ordering::SeqCst);
                let paths = event_requests.lock().unwrap();
                let ok = paths.iter().any(|p| p == "/essential.js") && !paths.iter().any(|p| p == "/source-test-ad.js") && event_app.webview_windows().len() == 2;
                drop(paths);
                let app = event_app.clone(); let main = event_main.clone(); let output = event_output.clone(); let frames = frames.clone();
                tauri::async_runtime::spawn(async move {
                    let closed = source_browser_control(app.clone(), main, REQUEST.into(), "close".into(), None, None).is_ok();
                    for _ in 0..30 {
                        if app.get_webview_window(LABEL).is_none() { break; }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    let before = frames.load(Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let animating = frames.load(Ordering::SeqCst) > before;
                    let ok = ok && closed && app.get_webview_window(LABEL).is_none() && animating;
                    report(&app, &output, ok, &format!("Native checks: inline verification, embedded manual browsing with back/forward navigation, hidden source host, request/cosmetic filtering, results, magnet capture and popup blocking={ok}; source closed={closed}; library animation frames={before}->{}", frames.load(Ordering::SeqCst)));
                });
            }
        });
        let nav_app = app.handle().clone(); let popup_app = app.handle().clone();
        let script = include_str!("adapter.js").replace("__SOURCE_CONFIG__", &serde_json::json!({"requestId":REQUEST,"imdbId":"tt1234567"}).to_string());
        *stage.lock().unwrap() = "creating source window".into();
        let browser = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External("about:blank".parse().unwrap()))
            .title("Source fixture").visible(false).focused(false).initialization_script(script)
            .on_page_load(move |_, payload| { if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) { *loaded_events.lock().unwrap() = payload.url().path().to_owned(); } })
            .on_navigation(move |url| handle_navigation(&nav_app, REQUEST, url))
            .on_new_window(move |url, _| { if url.scheme() == "magnet" { handle_navigation(&popup_app, REQUEST, &url); } NewWindowResponse::Deny })
            .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny).on_download(|_,_|false).build()?;
        let url = format!("{origin}/browse/?imdb_id=tt1234567").parse().unwrap();
        *stage.lock().unwrap() = "installing source protection".into();
        install(&browser, rules, url, REQUEST.into())?;
        Ok(())
    }).run(context).expect("source browser smoke failed");
    drop(preconnection);
}
