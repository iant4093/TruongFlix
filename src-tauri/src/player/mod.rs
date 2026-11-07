//! Built-in player: libmpv rendered inside the TruongFlix window, controlled by the React UI.
//!
//! Threading (see mpv/render.h): the main thread is the render thread and only calls
//! `mpv_render_*`; every other libmpv call happens on async-runtime or event-loop threads.

pub(crate) mod mpv;
pub(crate) mod multiview;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod win32;

use serde::Serialize;
use std::ffi::{c_int, CStr};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, WebviewWindow};

#[derive(Clone, Serialize)]
pub struct EngineStatus {
    available: bool,
    reason: Option<String>,
    mpv_version: Option<String>,
    ffmpeg_version: Option<String>,
    library: Option<String>,
}

struct Session {
    handle: usize,
    closing: bool,
    pending_subtitle: Option<String>,
    load_id: String,
    expected_path: String,
    live: bool,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Serializes open/close so rapid double "Play" clicks can never create two mpv cores.
static LIFECYCLE: Mutex<()> = Mutex::new(());

fn debug_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("TRUONGFLIX_PLAYER_DEBUG").is_some() || std::env::var_os("TRUONGFLIX_PLAYER_PROBE").is_some())
}

#[derive(Clone, Default, Serialize)]
struct PlayerState {
    load_id: String,
    time: f64,
    duration: f64,
    paused: bool,
    eof: bool,
    buffering: bool,
    seeking: bool,
    idle: bool,
    volume: f64,
    muted: bool,
    speed: f64,
    sub_delay: f64,
    audio_delay: f64,
    /// Transfer function of the current video (e.g. "pq"/"hlg" for HDR).
    gamma: Option<String>,
    loaded: bool,
    seekable_ranges: Vec<SeekRange>,
    cache_updated_at: f64,
}

#[derive(Clone, Default, serde::Deserialize, Serialize)]
struct SeekRange { start: f64, end: f64 }

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
    load_id: String,
}

const PROPS: &[(u64, &str, c_int)] = &[
    (1, "time-pos", mpv::FORMAT_DOUBLE),
    (2, "duration", mpv::FORMAT_DOUBLE),
    (3, "pause", mpv::FORMAT_FLAG),
    (4, "eof-reached", mpv::FORMAT_FLAG),
    (5, "track-list", mpv::FORMAT_STRING),
    (6, "volume", mpv::FORMAT_DOUBLE),
    (7, "mute", mpv::FORMAT_FLAG),
    (8, "paused-for-cache", mpv::FORMAT_FLAG),
    (9, "speed", mpv::FORMAT_DOUBLE),
    (10, "sub-delay", mpv::FORMAT_DOUBLE),
    (11, "audio-delay", mpv::FORMAT_DOUBLE),
    (12, "seeking", mpv::FORMAT_FLAG),
    (13, "video-params/gamma", mpv::FORMAT_STRING),
    (14, "core-idle", mpv::FORMAT_FLAG),
    (15, "chapter-list", mpv::FORMAT_STRING),
    (16, "demuxer-cache-state", mpv::FORMAT_STRING),
];

/// mpv's built-in Lua scripts (OSC, console, stats, …). We draw our own UI, and LuaJIT's JIT code
/// is killed by the hardened runtime, so none of them may ever run.
const NO_SCRIPTS: &[(&str, &str)] = &[
    ("load-scripts", "no"),
    ("osc", "no"),
    ("ytdl", "no"),
    ("load-auto-profiles", "no"),
    ("load-commands", "no"),
    ("load-console", "no"),
    ("load-osd-console", "no"),
    ("load-context-menu", "no"),
    ("load-positioning", "no"),
    ("load-select", "no"),
    ("load-stats-overlay", "no"),
];

fn unavailable_reason() -> Option<String> {
    if cfg!(any(target_os = "macos", windows)) {
        None
    } else {
        Some("The built-in player is available on macOS and Windows.".into())
    }
}

/// Keeps the Windows video window glued behind the main window (call from window events).
pub fn on_main_window_event(_event: &tauri::WindowEvent) {
    #[cfg(windows)]
    if matches!(
        _event,
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(_)
    ) {
        win32::sync();
    }
}

fn current_handle() -> Result<*mut mpv::Handle, String> {
    match SESSION.lock().unwrap().as_ref() {
        Some(s) if !s.closing => Ok(s.handle as *mut mpv::Handle),
        _ => Err("No active playback".into()),
    }
}

/// Runs `f` on the main (render) thread and waits for it.
fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "Main thread did not respond".to_string())
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

fn probe() -> EngineStatus {
    let fail = |reason: String| EngineStatus { available: false, reason: Some(reason), mpv_version: None, ffmpeg_version: None, library: None };
    if let Some(reason) = unavailable_reason() {
        return fail(reason);
    }
    let api = match mpv::api() {
        Ok(a) => a,
        Err(e) => return fail(e),
    };
    unsafe {
        let h = (api.create)();
        if h.is_null() {
            return fail("libmpv could not be initialized".into());
        }
        for (k, v) in [("vo", "null"), ("ao", "null"), ("idle", "yes"), ("config", "no"), ("terminal", "no")].iter().chain(NO_SCRIPTS) {
            let _ = api.set_option(h, k, v);
        }
        let ok = (api.initialize)(h) >= 0;
        let status = EngineStatus {
            available: ok,
            reason: (!ok).then(|| "libmpv failed to start".into()),
            mpv_version: api.get_property(h, "mpv-version"),
            ffmpeg_version: api.get_property(h, "ffmpeg-version"),
            library: Some(api.path.display().to_string()),
        };
        (api.terminate_destroy)(h);
        status
    }
}

#[tauri::command]
pub async fn player_status() -> EngineStatus {
    static STATUS: OnceLock<EngineStatus> = OnceLock::new();
    if let Some(s) = STATUS.get() {
        return s.clone();
    }
    let status = tauri::async_runtime::spawn_blocking(probe).await.unwrap_or_else(|e| EngineStatus {
        available: false,
        reason: Some(e.to_string()),
        mpv_version: None,
        ffmpeg_version: None,
        library: None,
    });
    STATUS.get_or_init(|| status).clone()
}

// ---------------------------------------------------------------------------
// Open / control / close
// ---------------------------------------------------------------------------

/// Creates and initializes an mpv core. `video_window` is the HWND mpv renders into on Windows
/// (`--wid`); on macOS video goes through the render API instead.
fn create_core(api: &mpv::Api, audio_lang: &str, sub_lang: &str, video_window: Option<isize>) -> Result<*mut mpv::Handle, String> {
    let h = unsafe { (api.create)() };
    if h.is_null() {
        return Err("libmpv could not be initialized".into());
    }
    // mpv expects the HWND as an unsigned 32-bit value (all Windows handles fit in 32 bits).
    let wid = video_window.map(|w| (w as usize as u32).to_string()).unwrap_or_default();
    let platform: &[(&str, &str)] = if cfg!(windows) {
        &[
            ("vo", "gpu-next"),
            ("wid", &wid),
            // HDR passthrough when Windows HDR is on; tone-mapped otherwise.
            ("target-colorspace-hint", "yes"),
            ("sub-font", "Segoe UI Semibold"),
        ]
    } else {
        &[("vo", "libmpv"), ("sub-font", "Helvetica Neue")]
    };
    let options: &[(&str, &str)] = &[
        ("hwdec", "auto-safe"),
        ("keep-open", "yes"),
        ("idle", "yes"),
        ("config", "no"),
        ("terminal", "no"),
        ("msg-level", "all=error"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("osd-level", "0"),
        ("sub-auto", "fuzzy"),
        ("audio-file-auto", "no"),
        ("alang", audio_lang),
        ("slang", sub_lang),
        ("sub-font-size", "46"),
        ("sub-outline-size", "2.5"),
        ("sub-shadow-offset", "1"),
        ("sub-margin-y", "54"),
    ];
    for (k, v) in platform.iter().chain(options).chain(NO_SCRIPTS) {
        if !v.is_empty() {
            if let Err(e) = api.set_option(h, k, v) {
                eprintln!("[player] {e}");
            }
        }
    }
    if let Err(e) = api.check(unsafe { (api.initialize)(h) }, "mpv initialize") {
        unsafe { (api.terminate_destroy)(h) };
        return Err(e);
    }
    for (id, name, format) in PROPS {
        api.observe(h, *id, name, *format);
    }
    Ok(h)
}

fn read_double(p: &mpv::EventProperty) -> Option<f64> {
    (p.format == mpv::FORMAT_DOUBLE && !p.data.is_null()).then(|| unsafe { *(p.data as *const f64) })
}

fn source_matches(actual: &str, expected: &str) -> bool {
    if actual == expected { return true; }
    if expected.starts_with("http://") || expected.starts_with("https://") { return false; }
    let normalize = |path: &str| path.strip_prefix("\\\\?\\").unwrap_or(path).replace('\\', "/");
    let (actual, expected) = (normalize(actual), normalize(expected));
    if cfg!(windows) { actual.eq_ignore_ascii_case(&expected) } else { actual == expected }
}
fn read_flag(p: &mpv::EventProperty) -> Option<bool> {
    (p.format == mpv::FORMAT_FLAG && !p.data.is_null()).then(|| unsafe { *(p.data as *const c_int) != 0 })
}
fn read_string(p: &mpv::EventProperty) -> Option<String> {
    if p.format != mpv::FORMAT_STRING || p.data.is_null() {
        return None;
    }
    let s = unsafe { *(p.data as *const *const std::ffi::c_char) };
    (!s.is_null()).then(|| unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned())
}

/// Event loop for one mpv core. Emits throttled `player-state`, `player-tracks`, `player-error`
/// and finally `player-closed` once the core has shut down.
fn event_loop(app: AppHandle, handle_addr: usize) {
    let Ok(api) = mpv::api() else { return };
    let h = handle_addr as *mut mpv::Handle;
    let mut state = PlayerState { volume: 100.0, speed: 1.0, ..Default::default() };
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut dirty = false;
    let debug = debug_enabled();
    #[cfg(target_os = "macos")]
    let mut last_debug = Instant::now();

    loop {
        let ev = unsafe { &*(api.wait_event)(h, 0.25) };
        #[cfg(target_os = "macos")]
        if debug && last_debug.elapsed() >= Duration::from_secs(2) {
            last_debug = Instant::now();
            eprintln!(
                "[player] t={:.1}/{:.1} paused={} loaded={} · {}",
                state.time,
                state.duration,
                state.paused,
                state.loaded,
                macos::probe::summary()
            );
        }
        match ev.event_id {
            mpv::EVENT_SHUTDOWN => break,
            mpv::EVENT_START_FILE => {
                state.loaded = false;
                state.eof = false;
                state.time = 0.0;
                state.duration = 0.0;
                state.seekable_ranges.clear();
                state.cache_updated_at = 0.0;
                if let Some(id) = SESSION.lock().unwrap().as_ref().filter(|s| s.handle == handle_addr).map(|s| s.load_id.clone()) { state.load_id = id; }
                dirty = true;
            }
            mpv::EVENT_FILE_LOADED => {
                if debug {
                    eprintln!("[player] file loaded");
                }
                state.loaded = true;
                state.eof = false;
                let pending = SESSION.lock().unwrap().as_mut().and_then(|s| s.pending_subtitle.take());
                if let Some(sub) = pending {
                    if let Err(e) = api.command(h, &["sub-add", &sub, "select"]) {
                        eprintln!("[player] {e}");
                    }
                }
                dirty = true;
            }
            mpv::EVENT_END_FILE if !ev.data.is_null() => {
                let end = unsafe { &*(ev.data as *const mpv::EventEndFile) };
                if end.reason == mpv::END_FILE_REASON_ERROR {
                    let _ = app.emit("player-error", ErrorPayload { message: api.err(end.error), load_id: state.load_id.clone() });
                }
            }
            mpv::EVENT_PROPERTY_CHANGE if !ev.data.is_null() => {
                let p = unsafe { &*(ev.data as *const mpv::EventProperty) };
                let urgent = ev.reply_userdata != 1;
                match ev.reply_userdata {
                    1 => state.time = read_double(p).unwrap_or(0.0),
                    2 => state.duration = read_double(p).unwrap_or(0.0),
                    3 => state.paused = read_flag(p).unwrap_or(false),
                    4 => state.eof = read_flag(p).unwrap_or(false),
                    5 => {
                        if let Some(json) = read_string(p) {
                            let _ = app.emit("player-tracks", json);
                        }
                    }
                    6 => state.volume = read_double(p).unwrap_or(100.0),
                    7 => state.muted = read_flag(p).unwrap_or(false),
                    8 => state.buffering = read_flag(p).unwrap_or(false),
                    9 => state.speed = read_double(p).unwrap_or(1.0),
                    10 => state.sub_delay = read_double(p).unwrap_or(0.0),
                    11 => state.audio_delay = read_double(p).unwrap_or(0.0),
                    12 => state.seeking = read_flag(p).unwrap_or(false),
                    13 => state.gamma = read_string(p),
                    14 => state.idle = read_flag(p).unwrap_or(false),
                    15 => {
                        let _ = app.emit("player-chapters", read_string(p).unwrap_or_else(|| "[]".into()));
                    }
                    16 => {
                        let old_end = state.seekable_ranges.last().map(|r| r.end);
                        state.seekable_ranges = read_string(p).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                            .and_then(|v| serde_json::from_value(v.get("seekable-ranges")?.clone()).ok()).unwrap_or_default();
                        if state.seekable_ranges.last().map(|r| r.end) != old_end {
                            state.cache_updated_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as f64;
                        }
                    }
                    _ => {}
                }
                dirty = true;
                if urgent {
                    last_emit = Instant::now() - Duration::from_secs(1);
                }
            }
            _ => {}
        }
        // Position updates arrive every frame; send at most ~5/s, other changes immediately.
        if dirty && last_emit.elapsed() >= Duration::from_millis(200) {
            let expected = SESSION.lock().unwrap().as_ref().filter(|s| s.handle == handle_addr).map(|s| (s.load_id.clone(), s.expected_path.clone()));
            if let Some((id, path)) = expected {
                state.load_id = id;
                let mut payload = state.clone();
                if !api.get_property(h, "path").is_some_and(|actual| source_matches(&actual, &path)) { payload.loaded = false; payload.eof = false; payload.seekable_ranges.clear(); }
                let _ = app.emit("player-state", payload);
            }
            last_emit = Instant::now();
            dirty = false;
        }
    }

    multiview::primary_exited(&app, handle_addr);
    // macOS: the render context must be gone before the core is destroyed.
    #[cfg(target_os = "macos")]
    let _ = on_main(&app, move || macos::detach_for(handle_addr));
    unsafe { (api.terminate_destroy)(h) };
    // Windows: only destroy the video window once mpv no longer renders into it.
    #[cfg(windows)]
    {
        let still_current = SESSION.lock().unwrap().as_ref().is_some_and(|s| s.handle == handle_addr);
        if still_current {
            let _ = on_main(&app, win32::destroy);
        }
    }
    {
        let mut s = SESSION.lock().unwrap();
        if s.as_ref().is_some_and(|s| s.handle == handle_addr) {
            *s = None;
        }
    }
    let _ = app.emit("player-closed", state);
}

/// Starts playback inside the window. Reuses the running core when one exists (next episode),
/// so the video surface never flickers between files.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn player_open(
    app: AppHandle,
    window: WebviewWindow,
    file_path: String,
    start_time: f64,
    subtitle_path: Option<String>,
    audio_lang: Option<String>,
    sub_lang: Option<String>,
    options: Option<Vec<(String, String)>>,
    live_source: Option<crate::live::Transport>,
    load_id: Option<String>,
) -> Result<(), String> {
    if let Some(reason) = unavailable_reason() {
        return Err(reason);
    }
    let api = mpv::api()?;
    let is_local_stream = file_path.starts_with("http://127.0.0.1:");
    if let Some(ref source) = live_source {
        source.validate()?;
        if source.url != file_path { return Err("Stream source does not match".into()); }
    }
    if live_source.is_none() && !is_local_stream && !std::path::Path::new(&file_path).is_file() {
        return Err(format!("File not found: {file_path}"));
    }
    let subtitle = subtitle_path.filter(|p| std::path::Path::new(p).is_file());
    let _lifecycle = LIFECYCLE.lock().unwrap();

    let existing = SESSION.lock().unwrap().as_ref().filter(|s| !s.closing).map(|s| s.handle);
    multiview::stop(&app, existing);
    let h = match existing {
        Some(addr) => {
            let h = addr as *mut mpv::Handle;
            if let Some(s) = SESSION.lock().unwrap().as_mut() {
                s.pending_subtitle = subtitle.clone();
                s.load_id = load_id.clone().unwrap_or_default();
                s.expected_path = file_path.clone();
                s.live = live_source.is_some();
            }
            h
        }
        None => {
            // Windows: the video window must exist before the core is created (`--wid`).
            #[cfg(windows)]
            let video_window = {
                let main = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
                Some(on_main(&app, move || win32::attach(main)).and_then(|r| r)?)
            };
            #[cfg(not(windows))]
            let video_window = None;

            let h = match create_core(api, audio_lang.as_deref().unwrap_or(""), sub_lang.as_deref().unwrap_or(""), video_window) {
                Ok(h) => h,
                Err(e) => {
                    #[cfg(windows)]
                    let _ = on_main(&app, || {
                        win32::release();
                        win32::destroy();
                    });
                    return Err(e);
                }
            };
            let addr = h as usize;
            *SESSION.lock().unwrap() = Some(Session { handle: addr, closing: false, pending_subtitle: subtitle.clone(), load_id: load_id.unwrap_or_default(), expected_path: file_path.clone(), live: live_source.is_some() });

            #[cfg(target_os = "macos")]
            {
                let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
                let attached = on_main(&app, move || macos::attach(ns_window as *mut _, addr as *mut _)).and_then(|r| r);
                if let Err(e) = attached {
                    *SESSION.lock().unwrap() = None;
                    unsafe { (api.terminate_destroy)(h) };
                    return Err(e);
                }
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            let _ = &window;

            let app2 = app.clone();
            std::thread::Builder::new()
                .name("mpv-events".into())
                .spawn(move || event_loop(app2, addr))
                .map_err(|e| e.to_string())?;
            h
        }
    };

    // Per-play settings (subtitle style, audio filters, preferred tracks) applied before loading.
    // The core is reused: a live provider's headers/cache/offset must never leak into the next file.
    for (name, value) in [("http-header-fields", ""), ("referrer", ""), ("user-agent", "mpv"), ("speed", "1"),
        ("start", "none"), ("cache", "auto"), ("cache-on-disk", "no"), ("demuxer-max-bytes", "150MiB"), ("demuxer-max-back-bytes", "50MiB")] {
        let _ = api.set_property(h, name, value);
    }
    if let Some(ref source) = live_source {
        if !source.referrer.is_empty() { api.set_property(h, "referrer", &source.referrer)?; }
        if !source.user_agent.is_empty() { api.set_property(h, "user-agent", &source.user_agent)?; }
        for (k, v) in [("cache", "yes"), ("demuxer-max-bytes", "128MiB"), ("demuxer-max-back-bytes", "64MiB")] { api.set_property(h, k, v)?; }
    }
    for (name, value) in options.unwrap_or_default() {
        if !property_allowed(&name, &value) {
            eprintln!("[player] ignored option {name}");
            continue;
        }
        if let Err(e) = api.set_property(h, &name, &value) {
            eprintln!("[player] {e}");
        }
    }
    if live_source.is_none() { api.set_property(h, "start", &format!("{:.3}", start_time.max(0.0)))?; }
    api.set_property(h, "pause", "no")?;
    api.command(h, &["loadfile", &file_path, "replace"])
}

/// Smoke test (run via `cargo run --example player_smoke -- <video>`): plays a file into a real
/// window through the same render path as the app and reports whether video frames were drawn.
#[cfg(target_os = "macos")]
#[doc(hidden)]
pub fn smoke_test(video: &str, seconds: f64) -> Result<String, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let api = mpv::api()?;
    let h = create_core(api, "", "", None)?;
    let addr = h as usize;
    macos::attach(macos::test_window(), h)?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let video = video.to_owned();
    // Client-API work stays off the main (render) thread.
    let worker = std::thread::spawn(move || -> Result<String, String> {
        let api = mpv::api()?;
        let h = addr as *mut mpv::Handle;
        api.command(h, &["loadfile", &video, "replace"])?;
        let mut max_time = 0.0f64;
        let mut error = None;
        while !stop2.load(Ordering::Acquire) {
            let ev = unsafe { &*(api.wait_event)(h, 0.1) };
            if ev.event_id == mpv::EVENT_PROPERTY_CHANGE && ev.reply_userdata == 1 && !ev.data.is_null() {
                if let Some(t) = read_double(unsafe { &*(ev.data as *const mpv::EventProperty) }) {
                    max_time = max_time.max(t);
                }
            }
            if ev.event_id == mpv::EVENT_END_FILE && !ev.data.is_null() {
                let end = unsafe { &*(ev.data as *const mpv::EventEndFile) };
                if end.reason == mpv::END_FILE_REASON_ERROR {
                    error = Some(api.err(end.error));
                }
            }
        }
        let info = ["video-codec", "hwdec-current", "width", "height", "current-vo", "video-params/gamma", "container-fps", "frame-drop-count", "vo-delayed-frame-count"]
            .iter()
            .map(|p| format!("{p}={}", api.get_property(h, p).unwrap_or_else(|| "-".into())))
            .collect::<Vec<_>>()
            .join(" ");
        match error {
            Some(e) => Err(format!("playback error: {e}")),
            None => Ok(format!("played to t={max_time:.2}s · {info}")),
        }
    });

    let window_state = macos::pump(seconds);
    stop.store(true, Ordering::Release);
    let report = worker.join().map_err(|_| "worker panicked".to_string())?;
    macos::detach_for(addr);
    std::thread::spawn(move || unsafe { (mpv::api().unwrap().terminate_destroy)(addr as *mut mpv::Handle) })
        .join()
        .ok();

    let load = |a: &std::sync::atomic::AtomicU64| a.load(std::sync::atomic::Ordering::Relaxed);
    let frames = load(&macos::probe::FRAMES);
    let colors = macos::probe::COLORS.lock().unwrap().as_ref().map_or(0, |c| c.len());
    Ok(format!(
        "{} · {window_state} · mpv updates={} · draws={} · frames rendered={frames} · distinct images={colors}",
        report?,
        load(&macos::probe::UPDATES),
        load(&macos::probe::DRAWS)
    ))
}

#[derive(serde::Deserialize, Clone, Copy)]
pub struct MiniRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default, rename = "viewportWidth")]
    viewport_width: Option<f64>,
    #[serde(default, rename = "viewportHeight")]
    viewport_height: Option<f64>,
}

impl MiniRect {
    fn coords(self) -> (f64, f64, f64, f64) {
        (self.x, self.y, self.w, self.h)
    }

    fn viewport(self) -> Option<(f64, f64)> {
        self.viewport_width.zip(self.viewport_height)
            .filter(|(w, h)| w.is_finite() && h.is_finite() && *w > 0.0 && *h > 0.0)
    }
}

/// Full-window video (`rect` = null) or a mini-player at `rect` (CSS pixels, top-left origin).
#[tauri::command]
pub async fn player_layout(app: AppHandle, rect: Option<MiniRect>) -> Result<(), String> {
    current_handle()?;
    #[cfg(target_os = "macos")]
    let viewport = rect.as_ref().and_then(|r| r.viewport_width.zip(r.viewport_height));
    let mini = rect.map(|r| (r.x, r.y, r.w, r.h));
    #[cfg(target_os = "macos")]
    on_main(&app, move || macos::set_layout(mini, viewport))?;
    #[cfg(windows)]
    on_main(&app, move || win32::set_layout(mini))?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (&app, mini);
    Ok(())
}

fn number_in(value: &str, min: f64, max: f64) -> bool {
    value.len() <= 32 && value.trim().parse::<f64>().is_ok_and(|n| n.is_finite() && n >= min && n <= max)
}

fn yes_no(value: &str) -> bool {
    matches!(value, "yes" | "no")
}

/// The audio filter chains the app builds (night mode, dialogue boost); nothing else may be set.
const AUDIO_FILTERS: &[&str] = &[
    "@dialogue:lavfi=[pan=stereo|FL=FC+0.30*FL+0.30*SL+0.30*BL|FR=FC+0.30*FR+0.30*SR+0.30*BR]",
    "@dialogue:lavfi=[highpass=f=90,equalizer=f=2500:t=q:w=1.1:g=5,equalizer=f=200:t=q:w=1:g=-2]",
    "@night:lavfi=[dynaudnorm=f=200:g=15:p=0.9:m=8]",
];

fn audio_filters_allowed(mut value: &str) -> bool {
    while !value.is_empty() {
        let Some(rest) = AUDIO_FILTERS.iter().find_map(|f| value.strip_prefix(f)) else { return false };
        value = rest.strip_prefix(',').unwrap_or(rest);
    }
    true
}

/// mpv properties the UI may change, with plain values only. Anything that can load scripts or
/// configs, write files or run programs (`script-opts`, `input-conf`, `stream-record`, …) is refused.
fn property_allowed(name: &str, value: &str) -> bool {
    match name {
        "pause" | "mute" | "audio-exclusive" => yes_no(value),
        "volume" => number_in(value, 0.0, 200.0),
        "speed" => number_in(value, 0.05, 10.0),
        "sub-delay" | "audio-delay" => number_in(value, -600.0, 600.0),
        "aid" | "sid" => matches!(value, "no" | "auto") || (value.len() <= 4 && value.parse::<u32>().is_ok_and(|n| n > 0)),
        "audio-device" => !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control),
        "audio-spdif" => value.split(',').all(|c| c.is_empty() || (c.len() <= 16 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'))),
        "af" => audio_filters_allowed(value),
        _ => crate::stream::sub_style_allowed(name, value),
    }
}

fn command_allowed(args: &[&str]) -> bool {
    let seek_mode = |m: &str| matches!(m, "relative" | "absolute" | "absolute+exact" | "relative+exact" | "exact" | "keyframes");
    match args {
        ["cycle", "pause" | "mute"] => true,
        ["seek", t] => number_in(t, -1e7, 1e7),
        ["seek", t, mode] => number_in(t, -1e7, 1e7) && seek_mode(mode),
        ["add", "volume" | "speed" | "sub-delay" | "audio-delay", n] => number_in(n, -1000.0, 1000.0),
        ["sub-reload"] => true,
        ["sub-reload", id] => id.len() <= 4 && id.parse::<u32>().is_ok(),
        _ => false,
    }
}

/// Runs an mpv command, e.g. `["seek", "10", "relative"]` or `["cycle", "pause"]`.
#[tauri::command]
pub async fn player_command(args: Vec<String>) -> Result<(), String> {
    if !command_allowed(&args.iter().map(String::as_str).collect::<Vec<_>>()) {
        return Err("This player command isn't allowed".into());
    }
    let api = mpv::api()?;
    let _lifecycle = LIFECYCLE.lock().unwrap();
    let h = current_handle()?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    api.command(h, &refs)?;
    if refs.as_slice() == ["cycle", "pause"] {
        if let Some(pause) = api.get_property(h, "pause") {
            multiview::mirror(api, "pause", &pause);
        }
    }
    Ok(())
}

/// Sets an mpv property, e.g. `volume` = `"80"` or `sid` = `"2"`.
#[tauri::command]
pub async fn player_set(name: String, value: String) -> Result<(), String> {
    if !property_allowed(&name, &value) {
        return Err(format!("The player setting “{name}” can't be changed"));
    }
    let api = mpv::api()?;
    let _lifecycle = LIFECYCLE.lock().unwrap();
    let h = current_handle()?;
    api.set_property(h, &name, &value)?;
    multiview::mirror(api, &name, &value);
    Ok(())
}

/// Stops playback and tears the core down (the event loop emits `player-closed` when done).
#[tauri::command]
pub async fn player_close(app: AppHandle) -> Result<(), String> {
    let api = mpv::api()?;
    let _lifecycle = LIFECYCLE.lock().unwrap();
    let addr = {
        let mut s = SESSION.lock().unwrap();
        match s.as_mut() {
            Some(sess) if !sess.closing => {
                sess.closing = true;
                sess.handle
            }
            _ => return Ok(()),
        }
    };
    multiview::stop(&app, None);
    #[cfg(target_os = "macos")]
    on_main(&app, move || macos::detach_for(addr))?;
    // Windows: give the UI back immediately; the window itself is destroyed after mpv quits.
    #[cfg(windows)]
    on_main(&app, win32::release)?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = &app;
    api.command(addr as *mut mpv::Handle, &["quit"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ui_commands_and_properties_reach_mpv() {
        for ok in [
            &["cycle", "pause"][..],
            &["cycle", "mute"],
            &["seek", "-10", "relative"],
            &["seek", "1234.5678901234567", "absolute+exact"],
            &["add", "volume", "-5"],
            &["sub-reload"],
        ] {
            assert!(command_allowed(ok), "{ok:?}");
        }
        for bad in [
            &["run", "calc.exe"][..],
            &["subprocess", "x"],
            &["load-script", "C:/x.lua"],
            &["write-watch-later-config"],
            &["screenshot-to-file", "C:/x.png"],
            &["loadfile", "C:/x.mkv"],
            &["set", "script-opts", "x"],
            &["seek", "10", "relative; quit"],
            &["cycle", "pause", "extra"],
        ] {
            assert!(!command_allowed(bad), "{bad:?}");
        }

        for (k, v) in [
            ("pause", "yes"),
            ("volume", "80"),
            ("aid", "2"),
            ("sid", "no"),
            ("sub-delay", "-1.5"),
            ("speed", "1.25"),
            ("audio-device", "wasapi/{0.0.0.00000000}.{abc}"),
            ("audio-spdif", "ac3,eac3,dts,dts-hd,truehd"),
            ("audio-spdif", ""),
            ("af", ""),
            ("af", "@night:lavfi=[dynaudnorm=f=200:g=15:p=0.9:m=8]"),
            ("af", "@dialogue:lavfi=[highpass=f=90,equalizer=f=2500:t=q:w=1.1:g=5,equalizer=f=200:t=q:w=1:g=-2],@night:lavfi=[dynaudnorm=f=200:g=15:p=0.9:m=8]"),
            ("sub-color", "#FFE600"),
            ("sub-font-size", "46"),
        ] {
            assert!(property_allowed(k, v), "{k}={v}");
        }
        for (k, v) in [
            ("script-opts", "a=b"),
            ("scripts", "C:/x.lua"),
            ("input-conf", "C:/x.conf"),
            ("config-dir", "C:/"),
            ("stream-record", "C:/x.ts"),
            ("dump-cache", "x"),
            ("watch-later-directory", "C:/"),
            ("af", "lavfi=[amovie=C\\:/secret.wav]"),
            ("volume", "loud"),
            ("aid", "1;quit"),
            ("audio-device", "a\nb"),
        ] {
            assert!(!property_allowed(k, v), "{k}={v}");
        }
    }
}
