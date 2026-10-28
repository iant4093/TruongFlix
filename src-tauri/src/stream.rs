//! Local media server for casting (Chromecast / DLNA) and the browser app on the home network.
//!
//! - `/stream/<token>/file`: the original file, with byte ranges (seeking).
//! - `/stream/<token>/index.m3u8` + `/stream/<token>/seg<N>.ts`: full-length VOD HLS (H.264/AAC in
//!   MPEG-TS, tone-mapped from HDR and with burned-in subtitles when requested), encoded on demand
//!   by a headless mpv core. Seeking jumps to the target segment and reuses already-encoded ones.
//! - `/stream/<token>/<job>/live.ts`: a single MPEG-TS stream for TVs that reject the original.
//! - `/` and `/assets/…`: the browser app; `/api/…`: forwarded to the desktop app's frontend,
//!   which answers with the same library/progress code it uses itself.
//!
//! Stream URLs carry random 128-bit tokens; the browser app needs the access code shown in Settings.

use crate::media::Core;
use crate::player::mpv;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const IDLE_STREAM: Duration = Duration::from_secs(15 * 60);
const API_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TTL: Duration = Duration::from_secs(120);
const LOOKAHEAD_SEGS: u32 = 6;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct StreamOptions {
    /// "direct" | "hls" | "ts"
    pub format: String,
    /// Output size for conversions (even numbers; 0 = keep).
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// Source is HDR (PQ/HLG): tone-map to SDR while converting.
    #[serde(default)]
    pub tone_map: bool,
    /// mpv audio track id to use (None = default).
    #[serde(default)]
    pub aid: Option<i64>,
    /// mpv subtitle track id to burn into the video (None = off).
    #[serde(default)]
    pub sid: Option<i64>,
    /// mpv subtitle appearance options `[name, value]` applied when `sid` is set.
    #[serde(default)]
    pub sub_style: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamAudioTrack {
    pub id: i64,
    pub lang: Option<String>,
    pub title: Option<String>,
    pub codec: Option<String>,
    pub channels: Option<i64>,
    pub default: bool,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamSubTrack {
    pub id: i64,
    pub lang: Option<String>,
    pub title: Option<String>,
    pub codec: Option<String>,
    pub forced: bool,
    pub default: bool,
    pub selected: bool,
    pub external: bool,
    pub external_filename: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamChapter {
    pub title: String,
    pub time: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamProbe {
    pub duration: f64,
    pub fps: f64,
    pub audio: Vec<StreamAudioTrack>,
    pub subs: Vec<StreamSubTrack>,
    pub chapters: Vec<StreamChapter>,
}

#[derive(Debug, Clone)]
struct HlsPlan {
    gop: u32,
    seg_len: f64,
    seg_count: u32,
    last_len: f64,
}

impl HlsPlan {
    fn from_probe(duration: f64, fps: f64) -> Self {
        let fps = if (1.0..240.0).contains(&fps) { fps } else { 24.0 };
        let gop = ((4.0 * fps).round() as u32).clamp(24, 480);
        let seg_len = gop as f64 / fps;
        let dur = duration.max(seg_len);
        let raw = (dur / seg_len).ceil() as u32;
        // Fold a sub-0.35s remainder into the preceding segment so we never advertise a near-empty tail.
        let (seg_count, last_len) = if raw > 1 {
            let rem = dur - (raw - 1) as f64 * seg_len;
            if rem < 0.35 {
                (raw - 1, seg_len + rem.max(0.0))
            } else {
                (raw, rem)
            }
        } else {
            (1, dur)
        };
        HlsPlan { gop, seg_len, seg_count, last_len }
    }

    fn playlist(&self) -> String {
        use std::fmt::Write;
        let target = self.seg_len.max(self.last_len).ceil() as u32;
        let mut out = String::with_capacity(160 + self.seg_count as usize * 32);
        let _ = writeln!(
            out,
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:{}\n#EXT-X-MEDIA-SEQUENCE:0",
            target.max(1)
        );
        for i in 0..self.seg_count {
            let len = if i + 1 == self.seg_count { self.last_len } else { self.seg_len };
            let _ = writeln!(out, "#EXTINF:{len:.6},\nseg{i}.ts");
        }
        out.push_str("#EXT-X-ENDLIST\n");
        out
    }
}

struct Job {
    id: String,
    dir: PathBuf,
    start: f64,
    start_seg: u32,
    frontier: Arc<AtomicU32>,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    eof: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

impl Job {
    fn stop(&self) {
        self.cancel.store(true, Ordering::Release);
    }
}

struct Stream {
    path: PathBuf,
    opts: StreamOptions,
    dir: PathBuf,
    hls: Option<HlsPlan>,
    job: Option<Job>,
    touched: Instant,
}

#[derive(Default)]
struct Inner {
    /// Port of the newest listener (older ones keep serving, e.g. a cast in progress).
    port: u16,
    streams: HashMap<String, Stream>,
    web_enabled: bool,
    access_code: String,
    web_tokens: HashSet<String>,
    pending: HashMap<u64, tokio::sync::oneshot::Sender<(u16, String)>>,
    next_request: u64,
}

struct Shared {
    app: AppHandle,
    inner: Mutex<Inner>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();
static ENCODER: Mutex<Option<&'static str>> = Mutex::new(None);
static GPU_FILTER_BROKEN: AtomicBool = AtomicBool::new(false);
static PROBE_CACHE: OnceLock<Mutex<HashMap<PathBuf, (Instant, StreamProbe)>>> = OnceLock::new();

fn shared() -> Result<&'static Shared, String> {
    SHARED.get().ok_or_else(|| "The media server isn't initialised".into())
}

fn cleanup_stream_dir(job: Option<Job>, dir: PathBuf) {
    std::thread::spawn(move || {
        if let Some(j) = job {
            j.stop();
            let t = Instant::now();
            while !j.done.load(Ordering::Acquire) && t.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    });
}

pub fn init(app: &AppHandle) {
    let _ = SHARED.set(Shared { app: app.clone(), inner: Mutex::new(Inner::default()) });
    // Housekeeping: stop conversions nobody has asked for in a while.
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            if let Ok(s) = shared() {
                let mut expired = Vec::new();
                {
                    let mut inner = s.inner.lock().unwrap();
                    let dead: Vec<String> = inner
                        .streams
                        .iter()
                        .filter(|(_, st)| st.touched.elapsed() >= IDLE_STREAM)
                        .map(|(k, _)| k.clone())
                        .collect();
                    for k in dead {
                        if let Some(st) = inner.streams.remove(&k) {
                            expired.push((st.job, st.dir));
                        }
                    }
                }
                for (job, dir) in expired {
                    cleanup_stream_dir(job, dir);
                }
            }
        }
    });
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS random generator");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn stream_cache_dir(token: &str) -> PathBuf {
    let base = shared()
        .ok()
        .and_then(|s| s.app.path().app_cache_dir().ok())
        .unwrap_or_else(std::env::temp_dir);
    base.join("streams").join(token)
}

/// Local address this machine uses to reach `host` (the IP a TV should connect back to).
pub fn local_ip_for(host: &str) -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    let target = if host.contains(':') { host.to_string() } else { format!("{host}:9") };
    socket.connect(target).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

/// Private IPv4 addresses of this machine (for the "open this address" hint).
fn lan_addresses() -> Vec<String> {
    let mut out = Vec::new();
    if let Some(ip) = local_ip_for("192.168.0.1").or_else(|| local_ip_for("10.0.0.1")) {
        if !ip.is_loopback() {
            out.push(ip.to_string());
        }
    }
    out
}

/// Starts the server if it isn't running (`port` 0 = any free port). Returns the port.
async fn ensure_server(port: u16) -> Result<u16, String> {
    let s = shared()?;
    {
        let inner = s.inner.lock().unwrap();
        if inner.port != 0 && (port == 0 || inner.port == port) {
            return Ok(inner.port);
        }
    }
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) if port != 0 => return Err(format!("Port {port} is in use ({e}). Choose another port.")),
        Err(e) => return Err(e.to_string()),
    };
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    s.inner.lock().unwrap().port = bound;
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((conn, _)) = listener.accept().await else { continue };
            tauri::async_runtime::spawn(async move {
                let _ = handle(conn).await;
            });
        }
    });
    Ok(bound)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    raw_query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn read_request(conn: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        let n = tokio::time::timeout(Duration::from_secs(15), conn.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 32 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_uppercase();
    let target = first.next()?.to_string();
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        .collect();
    let (path, qs) = target.split_once('?').unwrap_or((&target, ""));
    let query = qs
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect();
    let mut body = buf[header_end + 4..].to_vec();
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0).min(4 * 1024 * 1024);
    while body.len() < len {
        let n = tokio::time::timeout(Duration::from_secs(15), conn.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Request { method, path: percent_decode(path), query, raw_query: qs.to_string(), headers, body })
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range, Content-Type, X-TF-Token\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range\r\n";

async fn respond(conn: &mut TcpStream, status: u16, content_type: &str, extra: &str, body: &[u8], head_only: bool) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        416 => "Range Not Satisfiable",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{CORS}{extra}Connection: close\r\n\r\n",
        body.len()
    );
    conn.write_all(header.as_bytes()).await?;
    if !head_only {
        conn.write_all(body).await?;
    }
    conn.flush().await
}

async fn respond_json(conn: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    respond(conn, status, "application/json; charset=utf-8", "Cache-Control: no-store\r\n", body.as_bytes(), false).await
}

async fn handle(mut conn: TcpStream) -> std::io::Result<()> {
    let Some(req) = read_request(&mut conn).await else { return Ok(()) };
    if req.method == "OPTIONS" {
        return respond(&mut conn, 204, "text/plain", "Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\n", b"", false).await;
    }
    if let Some(rest) = req.path.strip_prefix("/stream/") {
        return serve_stream(&mut conn, &req, rest).await;
    }
    let (web_enabled, authed) = {
        let s = match shared() {
            Ok(s) => s,
            Err(_) => return respond(&mut conn, 503, "text/plain", "", b"Starting", false).await,
        };
        let inner = s.inner.lock().unwrap();
        let token = req.headers.get("x-tf-token").cloned().unwrap_or_default();
        (inner.web_enabled, inner.web_tokens.contains(&token))
    };
    if !web_enabled {
        return respond(&mut conn, 403, "text/html; charset=utf-8", "", OFF_PAGE.as_bytes(), false).await;
    }
    if req.path == "/api/login" && req.method == "POST" {
        let code = serde_json::from_slice::<Value>(&req.body).ok().and_then(|v| v["code"].as_str().map(str::to_owned)).unwrap_or_default();
        let s = shared().map_err(std::io::Error::other)?;
        let token = {
            let mut inner = s.inner.lock().unwrap();
            if code.trim().is_empty() || code.trim() != inner.access_code {
                None
            } else {
                let t = random_token();
                inner.web_tokens.insert(t.clone());
                Some(t)
            }
        };
        return match token {
            Some(t) => respond_json(&mut conn, 200, &serde_json::json!({ "token": t }).to_string()).await,
            None => {
                tokio::time::sleep(Duration::from_millis(800)).await; // slow down guessing
                respond_json(&mut conn, 401, r#"{"error":"Wrong code"}"#).await
            }
        };
    }
    if req.path.starts_with("/api/") {
        if !authed {
            return respond_json(&mut conn, 401, r#"{"error":"Sign in with the access code"}"#).await;
        }
        let (status, body) = forward_api(&req).await;
        return respond_json(&mut conn, status, &body).await;
    }
    serve_app_asset(&mut conn, &req).await
}

const OFF_PAGE: &str = "<!doctype html><meta name=viewport content='width=device-width'><body style='background:#141414;color:#eee;font-family:system-ui;display:grid;place-items:center;height:90vh;text-align:center'><div><h1 style='color:#e50914'>TruongFlix</h1><p>Browser access is turned off.<br>Turn it on in TruongFlix › Settings › Devices.</p></div>";

/// Hands an `/api/…` request to the desktop app's frontend and waits for its answer.
async fn forward_api(req: &Request) -> (u16, String) {
    let Ok(s) = shared() else { return (503, r#"{"error":"Starting"}"#.into()) };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let id = {
        let mut inner = s.inner.lock().unwrap();
        inner.next_request += 1;
        let id = inner.next_request;
        inner.pending.insert(id, tx);
        id
    };
    let payload = serde_json::json!({
        "id": id,
        "method": req.method,
        "path": req.path.trim_start_matches("/api"),
        "query": req.query,
        "body": serde_json::from_slice::<Value>(&req.body).unwrap_or(Value::Null),
    });
    if s.app.emit("remote-api", payload).is_err() {
        s.inner.lock().unwrap().pending.remove(&id);
        return (503, r#"{"error":"TruongFlix isn't ready"}"#.into());
    }
    match tokio::time::timeout(API_TIMEOUT, rx).await {
        Ok(Ok(reply)) => reply,
        _ => {
            s.inner.lock().unwrap().pending.remove(&id);
            (504, r#"{"error":"TruongFlix didn't answer"}"#.into())
        }
    }
}

/// The frontend's answer to a forwarded request.
#[tauri::command]
pub fn remote_api_reply(id: u64, status: u16, body: String) {
    if let Ok(s) = shared() {
        if let Some(tx) = s.inner.lock().unwrap().pending.remove(&id) {
            let _ = tx.send((status, body));
        }
    }
}

async fn serve_app_asset(conn: &mut TcpStream, req: &Request) -> std::io::Result<()> {
    let head_only = req.method == "HEAD";
    // Development: the frontend (and Vite's module graph) is served by the dev server.
    #[cfg(debug_assertions)]
    {
        let path = if req.path == "/" { "/remote.html" } else { req.path.as_str() };
        let query = if req.raw_query.is_empty() { String::new() } else { format!("?{}", req.raw_query) };
        if let Ok(res) = reqwest::get(format!("http://localhost:1420{path}{query}")).await {
            if res.status().is_success() {
                let mime = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
                let bytes = res.bytes().await.unwrap_or_default();
                return respond(conn, 200, &mime, "Cache-Control: no-cache\r\n", &bytes, head_only).await;
            }
        }
    }
    let s = shared().map_err(std::io::Error::other)?;
    let path = if req.path == "/" || !req.path.contains('.') { "remote.html".to_string() } else { req.path.trim_start_matches('/').to_string() };
    if let Some(asset) = s.app.asset_resolver().get(path.clone()) {
        let cache = if path.starts_with("assets/") { "Cache-Control: public, max-age=31536000, immutable\r\n" } else { "Cache-Control: no-cache\r\n" };
        return respond(conn, 200, &asset.mime_type, cache, &asset.bytes, head_only).await;
    }
    respond(conn, 404, "text/plain", "", b"Not found", false).await
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

fn mime_for(path: &Path) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("mp4" | "m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("avi") => "video/x-msvideo",
        Some("mov") => "video/quicktime",
        Some("ts" | "m2ts") => "video/mp2t",
        Some("wmv") => "video/x-ms-wmv",
        _ => "application/octet-stream",
    }
}

const DLNA_HEADERS: &str =
    "transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n";

async fn serve_stream(conn: &mut TcpStream, req: &Request, rest: &str) -> std::io::Result<()> {
    let mut parts = rest.splitn(3, '/');
    let token = parts.next().unwrap_or_default().to_string();
    let second = parts.next().unwrap_or_default().to_string();
    let third = parts.next().unwrap_or_default().to_string();
    let head_only = req.method == "HEAD";

    let info = shared().ok().and_then(|s| {
        let mut inner = s.inner.lock().unwrap();
        let st = inner.streams.get_mut(&token)?;
        st.touched = Instant::now();
        let live_job = st.job.as_ref().map(|j| (j.id.clone(), j.dir.clone(), j.done.clone()));
        Some((st.path.clone(), st.hls.clone(), live_job))
    });
    let Some((path, hls, live_job)) = info else {
        return respond(conn, 404, "text/plain", "", b"Unknown stream", false).await;
    };

    if second == "file" {
        return serve_file_range(conn, &path, req.headers.get("range").map(String::as_str), head_only).await;
    }
    if second == "index.m3u8" {
        let Some(plan) = hls else {
            return respond(conn, 404, "text/plain", "", b"Not an HLS stream", false).await;
        };
        let body = plan.playlist();
        return respond(conn, 200, "application/vnd.apple.mpegurl", "Cache-Control: no-cache\r\n", body.as_bytes(), head_only).await;
    }
    if let Some(idx) = second.strip_prefix("seg").and_then(|s| s.strip_suffix(".ts")).and_then(|s| s.parse::<u32>().ok()) {
        return serve_segment(conn, &token, idx, head_only).await;
    }
    if third == "live.ts" {
        let Some((_, dir, done)) = live_job.filter(|j| j.0 == second) else {
            return respond(conn, 404, "text/plain", "", b"This conversion has ended", false).await;
        };
        return serve_growing(conn, &dir.join("live.ts"), &done, head_only).await;
    }
    respond(conn, 404, "text/plain", "", b"Not found", false).await
}

/// Serves one HLS segment, waiting for the active encoder or restarting it at `idx` on a seek.
async fn serve_segment(conn: &mut TcpStream, token: &str, idx: u32, head_only: bool) -> std::io::Result<()> {
    let s = shared().map_err(std::io::Error::other)?;
    let resolved: Result<(PathBuf, u32), &'static [u8]> = {
        let mut inner = s.inner.lock().unwrap();
        match inner.streams.get_mut(token) {
            None => Err(b"Unknown stream"),
            Some(st) => {
                st.touched = Instant::now();
                match &st.hls {
                    None => Err(b"Not an HLS stream"),
                    Some(plan) if idx >= plan.seg_count => Err(b"No such segment"),
                    Some(plan) => Ok((st.dir.join(format!("seg{idx}.ts")), plan.seg_count)),
                }
            }
        }
    };
    let (seg_file, seg_count) = match resolved {
        Ok(v) => v,
        Err(msg) => return respond(conn, 404, "text/plain", "", msg, false).await,
    };

    if seg_file.exists() {
        let bytes = tokio::fs::read(&seg_file).await?;
        return respond(conn, 200, "video/mp2t", "Cache-Control: public, max-age=3600\r\n", &bytes, head_only).await;
    }

    let started = Instant::now();
    let mut our_job: Option<String> = None;
    loop {
        if seg_file.exists() {
            let bytes = tokio::fs::read(&seg_file).await?;
            return respond(conn, 200, "video/mp2t", "Cache-Control: public, max-age=3600\r\n", &bytes, head_only).await;
        }

        enum Step {
            Wait,
            Ready,
            EmptyEof,
            Failed(String),
            Gone,
        }

        let step = {
            let mut inner = s.inner.lock().unwrap();
            if let Some(st) = inner.streams.get_mut(token) {
                st.touched = Instant::now();
                if seg_file.exists() {
                    Step::Ready
                } else {
                    let plan = st.hls.clone().unwrap();
                    let active_covers = st.job.as_ref().is_some_and(|j| {
                        !j.cancel.load(Ordering::Acquire)
                            && !j.done.load(Ordering::Acquire)
                            && j.error.lock().unwrap().is_none()
                            && idx >= j.start_seg
                            && idx <= j.frontier.load(Ordering::Acquire).saturating_add(LOOKAHEAD_SEGS)
                    });
                    if active_covers {
                        if our_job.is_none() {
                            our_job = st.job.as_ref().map(|j| j.id.clone());
                        }
                        Step::Wait
                    } else if let Some(ref wanted_id) = our_job {
                        // We already bound to or spawned a job for this segment; inspect what happened to it.
                        match st.job.as_ref().filter(|j| &j.id == wanted_id) {
                            Some(j) => {
                                let err = j.error.lock().unwrap().clone();
                                if let Some(e) = err {
                                    Step::Failed(e)
                                } else if j.done.load(Ordering::Acquire) && j.eof.load(Ordering::Acquire) && idx + 1 >= seg_count {
                                    Step::EmptyEof
                                } else if j.done.load(Ordering::Acquire) || j.cancel.load(Ordering::Acquire) {
                                    if j.start_seg != idx && !j.cancel.load(Ordering::Acquire) {
                                        let prev = st.job.take().map(|old| {
                                            old.stop();
                                            old.done
                                        });
                                        match spawn_hls_job(&st.path, &st.opts, &plan, idx, &st.dir, prev) {
                                            Ok(nj) => {
                                                our_job = Some(nj.id.clone());
                                                st.job = Some(nj);
                                                Step::Wait
                                            }
                                            Err(e) => Step::Failed(e),
                                        }
                                    } else {
                                        Step::Gone
                                    }
                                } else {
                                    Step::Wait
                                }
                            }
                            None => Step::Gone, // superseded by a newer seek
                        }
                    } else {
                        let at_eof = st.job.as_ref().is_some_and(|j| {
                            j.done.load(Ordering::Acquire)
                                && j.eof.load(Ordering::Acquire)
                                && j.error.lock().unwrap().is_none()
                                && idx >= j.start_seg
                                && idx + 1 >= seg_count
                        });
                        if at_eof {
                            Step::EmptyEof
                        } else {
                            let prev = st.job.take().map(|old| {
                                old.stop();
                                old.done
                            });
                            match spawn_hls_job(&st.path, &st.opts, &plan, idx, &st.dir, prev) {
                                Ok(nj) => {
                                    our_job = Some(nj.id.clone());
                                    st.job = Some(nj);
                                    Step::Wait
                                }
                                Err(e) => Step::Failed(e),
                            }
                        }
                    }
                }
            } else {
                Step::Gone
            }
        };

        match step {
            Step::Ready => continue,
            Step::EmptyEof => return respond(conn, 200, "video/mp2t", "Cache-Control: no-store\r\n", b"", head_only).await,
            Step::Failed(e) => return respond(conn, 503, "text/plain", "", e.as_bytes(), false).await,
            Step::Gone => return respond(conn, 404, "text/plain", "", b"Segment superseded", false).await,
            Step::Wait => {
                if started.elapsed() > Duration::from_secs(45) {
                    return respond(conn, 503, "text/plain", "", b"Conversion is taking too long", false).await;
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        }
    }
}

/// Original file with single-range support (seeking in browsers, TVs and Chromecast).
async fn serve_file_range(conn: &mut TcpStream, path: &Path, range: Option<&str>, head_only: bool) -> std::io::Result<()> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return respond(conn, 404, "text/plain", "", b"File not found", false).await,
    };
    let size = file.metadata().await?.len();
    let mime = mime_for(path);
    let (start, end) = match range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split(',').next()).and_then(|r| r.split_once('-')) {
        Some((a, b)) => {
            let (a, b) = (a.trim(), b.trim());
            let (s, e) = if a.is_empty() {
                let n: u64 = b.parse().unwrap_or(0);
                (size.saturating_sub(n), size.saturating_sub(1))
            } else {
                (a.parse().unwrap_or(0), b.parse().unwrap_or(size.saturating_sub(1)).min(size.saturating_sub(1)))
            };
            if s >= size || s > e {
                let extra = format!("Content-Range: bytes */{size}\r\n");
                return respond(conn, 416, "text/plain", &extra, b"", false).await;
            }
            (s, e)
        }
        None => (0, size.saturating_sub(1)),
    };
    let partial = range.is_some();
    let len = if size == 0 { 0 } else { end - start + 1 };
    let status = if partial { "206 Partial Content" } else { "200 OK" };
    let content_range = if partial { format!("Content-Range: bytes {start}-{end}/{size}\r\n") } else { String::new() };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\n{content_range}{CORS}{DLNA_HEADERS}Connection: close\r\n\r\n"
    );
    conn.write_all(header.as_bytes()).await?;
    if head_only || len == 0 {
        return conn.flush().await;
    }
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut remaining = len;
    let mut buf = vec![0u8; 256 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        conn.write_all(&buf[..n]).await?;
        remaining -= n as u64;
    }
    conn.flush().await
}

/// A file that is still being written (MPEG-TS conversion): chunked until the encoder finishes.
async fn serve_growing(conn: &mut TcpStream, path: &Path, done: &AtomicBool, head_only: bool) -> std::io::Result<()> {
    let header = format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nTransfer-Encoding: chunked\r\n{CORS}{DLNA_HEADERS}Connection: close\r\n\r\n");
    conn.write_all(header.as_bytes()).await?;
    if head_only {
        return conn.flush().await;
    }
    let started = Instant::now();
    let mut file = loop {
        match tokio::fs::File::open(path).await {
            Ok(f) => break f,
            Err(_) if started.elapsed() < Duration::from_secs(30) => tokio::time::sleep(Duration::from_millis(200)).await,
            Err(e) => return Err(e),
        }
    };
    let mut buf = vec![0u8; 188 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n > 0 {
            conn.write_all(format!("{n:X}\r\n").as_bytes()).await?;
            conn.write_all(&buf[..n]).await?;
            conn.write_all(b"\r\n").await?;
            continue;
        }
        if done.load(Ordering::Acquire) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    conn.write_all(b"0\r\n\r\n").await?;
    conn.flush().await
}

// ---------------------------------------------------------------------------
// Probing & encoder discovery
// ---------------------------------------------------------------------------

fn candidate_encoders() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &["h264_videotoolbox", "libx264"]
    } else if cfg!(windows) {
        // shinchiro's Windows libmpv ships GPU & Media Foundation H.264 encoders (no libx264).
        &["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"]
    } else {
        &["libx264", "h264_vaapi", "h264_nvenc"]
    }
}

fn ovcopts_for(encoder: &str, gop: u32) -> String {
    if encoder == "libx264" {
        format!("preset=veryfast,crf=21,g={gop},keyint_min={gop},sc_threshold=0,profile=high")
    } else {
        format!("b=6M,maxrate=10M,g={gop}")
    }
}

fn test_encoder(name: &str) -> bool {
    let tmp = std::env::temp_dir().join(format!("tf-enc-{}-{}.ts", name, random_token()));
    let out = tmp.to_string_lossy().into_owned();
    let opts = [
        ("o", out.as_str()),
        ("of", "mpegts"),
        ("ovc", name),
        ("ovcopts", "b=2M,g=24"),
        ("vf", "format=yuv420p"),
        ("aid", "no"),
        ("sid", "no"),
        ("keep-open", "no"),
    ];
    let ok = (|| -> Option<bool> {
        let core = Core::new(&opts).ok()?;
        core.api
            .command(core.h, &["loadfile", "av://lavfi:testsrc2=size=320x180:rate=24:duration=1", "replace"])
            .ok()?;
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut vo_ok = false;
        let mut clean_end = false;
        while Instant::now() < deadline {
            let ev = unsafe { &*(core.api.wait_event)(core.h, 0.2) };
            if ev.event_id == mpv::EVENT_PLAYBACK_RESTART {
                vo_ok = core.get("vo-configured").as_deref() == Some("yes");
                if !vo_ok {
                    break;
                }
            } else if ev.event_id == mpv::EVENT_END_FILE {
                let err = !ev.data.is_null() && unsafe { &*(ev.data as *const mpv::EventEndFile) }.reason == mpv::END_FILE_REASON_ERROR;
                clean_end = !err;
                break;
            } else if ev.event_id == mpv::EVENT_SHUTDOWN {
                break;
            }
        }
        drop(core);
        Some(vo_ok && clean_end)
    })()
    .unwrap_or(false);
    let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&tmp);
    ok && size > 1000
}

fn pick_encoder() -> Result<&'static str, String> {
    if let Some(enc) = *ENCODER.lock().unwrap() {
        return Ok(enc);
    }
    for &cand in candidate_encoders() {
        if test_encoder(cand) {
            let mut guard = ENCODER.lock().unwrap();
            *guard = Some(cand);
            return Ok(cand);
        }
    }
    Err("No working H.264 video encoder was found on this computer".into())
}

fn probe_str(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_owned)
}

fn probe_file(path: &Path) -> Result<StreamProbe, String> {
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, hit)) = cache.lock().unwrap().get(path) {
        if at.elapsed() < PROBE_TTL {
            return Ok(hit.clone());
        }
    }
    let core = Core::new(&[("vo", "null"), ("ao", "null"), ("pause", "yes"), ("sub-auto", "fuzzy")])?;
    let file = path.to_string_lossy().into_owned();
    core.api.command(core.h, &["loadfile", &file, "replace"])?;
    if core.wait_for(&[mpv::EVENT_FILE_LOADED], Duration::from_secs(15)).is_none() {
        return Err("Couldn't open this media file".into());
    }
    let tracks: Vec<Value> = core.get("track-list").and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    let chapters_raw: Vec<Value> = core.get("chapter-list").and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    let video = tracks.iter().find(|t| probe_str(t, "type").as_deref() == Some("video") && !t["albumart"].as_bool().unwrap_or(false));
    let duration = core.get("duration").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0).max(0.0);
    let fps = core
        .get("container-fps")
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| video.and_then(|v| v["demux-fps"].as_f64()))
        .filter(|f| *f > 1.0 && *f < 240.0)
        .unwrap_or(24.0);

    let mut audio = Vec::new();
    let mut subs = Vec::new();
    for t in &tracks {
        let Some(id) = t["id"].as_i64() else { continue };
        match probe_str(t, "type").as_deref() {
            Some("audio") => audio.push(StreamAudioTrack {
                id,
                lang: probe_str(t, "lang"),
                title: probe_str(t, "title"),
                codec: probe_str(t, "codec"),
                channels: t["demux-channel-count"].as_i64().or_else(|| t["audio-channels"].as_i64()),
                default: t["default"].as_bool().unwrap_or(false),
                selected: t["selected"].as_bool().unwrap_or(false),
            }),
            Some("sub") => subs.push(StreamSubTrack {
                id,
                lang: probe_str(t, "lang"),
                title: probe_str(t, "title"),
                codec: probe_str(t, "codec"),
                forced: t["forced"].as_bool().unwrap_or(false),
                default: t["default"].as_bool().unwrap_or(false),
                selected: t["selected"].as_bool().unwrap_or(false),
                external: t["external"].as_bool().unwrap_or(false),
                external_filename: probe_str(t, "external-filename"),
            }),
            _ => {}
        }
    }
    let chapters = chapters_raw
        .iter()
        .map(|c| StreamChapter { title: probe_str(c, "title").unwrap_or_default(), time: c["time"].as_f64().unwrap_or(0.0) })
        .collect();
    drop(core);

    let probe = StreamProbe { duration, fps, audio, subs, chapters };
    cache.lock().unwrap().insert(path.to_path_buf(), (Instant::now(), probe.clone()));
    Ok(probe)
}

// ---------------------------------------------------------------------------
// Conversion jobs (headless mpv in encoding mode)
// ---------------------------------------------------------------------------

fn last_playlist_seg(playlist: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(playlist).ok()?;
    text.lines().rev().find_map(|l| l.trim().strip_prefix("seg")?.strip_suffix(".ts")?.parse().ok())
}

fn all_playlist_segs(playlist: &Path) -> Vec<u32> {
    let Ok(text) = std::fs::read_to_string(playlist) else { return Vec::new() };
    text.lines()
        .filter_map(|l| l.trim().strip_prefix("seg")?.strip_suffix(".ts")?.parse().ok())
        .collect()
}

fn remove_tmp_files(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().ends_with(".tmp") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

fn spawn_hls_job(
    path: &Path,
    opts: &StreamOptions,
    plan: &HlsPlan,
    start_seg: u32,
    dir: &Path,
    prev_done: Option<Arc<AtomicBool>>,
) -> Result<Job, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let id = random_token()[..12].to_string();
    let start = start_seg as f64 * plan.seg_len;
    let frontier = Arc::new(AtomicU32::new(start_seg));
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let eof = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None));
    let job = Job {
        id,
        dir: dir.to_path_buf(),
        start,
        start_seg,
        frontier: frontier.clone(),
        cancel: cancel.clone(),
        done: done.clone(),
        eof: eof.clone(),
        error: error.clone(),
    };
    let (path, opts, plan, dir) = (path.to_path_buf(), opts.clone(), plan.clone(), dir.to_path_buf());
    std::thread::spawn(move || {
        run_encode(path, opts, Some((plan, start_seg, frontier)), start, dir, prev_done, cancel, done, eof, error);
    });
    Ok(job)
}

fn spawn_ts_job(
    path: &Path,
    opts: &StreamOptions,
    start: f64,
    root: &Path,
    prev_done: Option<Arc<AtomicBool>>,
) -> Result<Job, String> {
    let id = random_token()[..12].to_string();
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let frontier = Arc::new(AtomicU32::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let eof = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None));
    let job = Job {
        id,
        dir: dir.clone(),
        start,
        start_seg: 0,
        frontier,
        cancel: cancel.clone(),
        done: done.clone(),
        eof: eof.clone(),
        error: error.clone(),
    };
    let (path, opts) = (path.to_path_buf(), opts.clone());
    std::thread::spawn(move || {
        run_encode(path, opts, None, start, dir, prev_done, cancel, done, eof, error);
    });
    Ok(job)
}

#[allow(clippy::too_many_arguments)]
fn run_encode(
    path: PathBuf,
    opts: StreamOptions,
    hls: Option<(HlsPlan, u32, Arc<AtomicU32>)>,
    start: f64,
    dir: PathBuf,
    prev_done: Option<Arc<AtomicBool>>,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    eof: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
) {
    if let Some(prev) = prev_done {
        let wait = Instant::now();
        while !prev.load(Ordering::Acquire) && wait.elapsed() < Duration::from_secs(8) {
            if cancel.load(Ordering::Acquire) {
                done.store(true, Ordering::Release);
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    if cancel.load(Ordering::Acquire) {
        done.store(true, Ordering::Release);
        return;
    }

    let enc = match pick_encoder() {
        Ok(e) => e,
        Err(e) => {
            *error.lock().unwrap() = Some(e);
            done.store(true, Ordering::Release);
            return;
        }
    };

    // Headless vf=gpu works via CGL on macOS; on Windows shinchiro's libmpv-2.dll segfaults
    // (0xc0000005) when vf=gpu initializes inside vo=lavc without a swapchain, so use swscale there.
    let want_gpu = cfg!(target_os = "macos") && opts.tone_map && !GPU_FILTER_BROKEN.load(Ordering::Relaxed);
    let attempts: &[bool] = if want_gpu { &[true, false] } else { &[false] };
    let m3u8 = dir.join("seg.m3u8");
    let live_ts = dir.join("live.ts");

    for (attempt_idx, &use_gpu) in attempts.iter().enumerate() {
        let _ = std::fs::remove_file(&m3u8);
        if hls.is_none() {
            let _ = std::fs::remove_file(&live_ts);
        }
        remove_tmp_files(&dir);

        let gop = hls.as_ref().map(|(p, _, _)| p.gop).unwrap_or(48);
        let ovcopts = ovcopts_for(enc, gop);
        let out = if hls.is_some() { &m3u8 } else { &live_ts }.to_string_lossy().into_owned();
        let start_s = if hls.is_some() { format!("{:.6}", start.max(0.0)) } else { format!("{:.3}", start.max(0.0)) };
        let (w, h) = (opts.width.max(2) & !1, opts.height.max(2) & !1);
        let vf = if use_gpu && opts.width > 0 {
            format!("gpu=w={w}:h={h},format=yuv420p")
        } else if use_gpu {
            "gpu,format=yuv420p".into()
        } else if opts.width > 0 {
            format!("scale={w}:{h},format=yuv420p")
        } else {
            "format=yuv420p".into()
        };

        let aid = opts.aid.filter(|a| *a > 0).map(|a| a.to_string()).unwrap_or_else(|| "auto".into());
        let sid = opts.sid.filter(|s| *s > 0).map(|s| s.to_string()).unwrap_or_else(|| "no".into());
        let ofopts = hls.as_ref().map(|(plan, start_seg, _)| {
            format!(
                "hls_time={:.6},start_number={start_seg},hls_segment_type=mpegts,hls_list_size=0,hls_flags=temp_file",
                plan.seg_len
            )
        });

        let mut options: Vec<(&str, &str)> = vec![
            ("o", &out),
            ("ovc", enc),
            ("ovcopts", &ovcopts),
            ("oac", "aac"),
            ("oacopts", "b=192k"),
            ("audio-channels", "stereo"),
            ("audio-samplerate", "48000"),
            ("start", &start_s),
            ("aid", &aid),
            ("sid", &sid),
            ("vf", &vf),
            ("hwdec", "auto-copy-safe"),
            ("keep-open", "no"),
        ];
        if sid != "no" {
            options.push(("sub-auto", "fuzzy"));
            for (k, v) in &opts.sub_style {
                options.push((k.as_str(), v.as_str()));
            }
        }
        if let Some(ref of_str) = ofopts {
            options.push(("orawts", "yes"));
            options.push(("of", "hls"));
            options.push(("ofopts", of_str));
        } else {
            options.push(("of", "mpegts"));
        }
        if use_gpu {
            options.extend([("target-prim", "bt.709"), ("target-trc", "bt.1886"), ("tone-mapping", "bt.2390")]);
        }

        let core = match Core::new(&options) {
            Ok(c) => c,
            Err(e) => {
                if use_gpu && attempt_idx + 1 < attempts.len() {
                    GPU_FILTER_BROKEN.store(true, Ordering::Relaxed);
                    continue;
                }
                *error.lock().unwrap() = Some(e);
                break;
            }
        };

        let file = path.to_string_lossy().into_owned();
        let mut video_ok = false;
        let mut reached_eof = false;
        let mut end_err = false;
        let mut last_scan = Instant::now();

        if let Err(e) = core.api.command(core.h, &["loadfile", &file, "replace"]) {
            *error.lock().unwrap() = Some(e);
            drop(core);
            break;
        }

        loop {
            if cancel.load(Ordering::Acquire) {
                let _ = core.api.command(core.h, &["stop"]);
                break;
            }
            if let Some((_, _, ref frontier)) = hls {
                if last_scan.elapsed() >= Duration::from_millis(200) {
                    last_scan = Instant::now();
                    if let Some(last) = last_playlist_seg(&m3u8) {
                        frontier.store(last, Ordering::Release);
                    }
                }
            }
            let ev = unsafe { &*(core.api.wait_event)(core.h, 0.10) };
            if ev.event_id == mpv::EVENT_PLAYBACK_RESTART {
                if core.get("vo-configured").as_deref() == Some("yes") {
                    video_ok = true;
                } else {
                    // A failed filter (e.g. headless GPU tone-mapping on some Windows setups) silently drops video.
                    end_err = true;
                    let _ = core.api.command(core.h, &["stop"]);
                    break;
                }
            } else if ev.event_id == mpv::EVENT_END_FILE {
                if !ev.data.is_null() && unsafe { &*(ev.data as *const mpv::EventEndFile) }.reason == mpv::END_FILE_REASON_ERROR {
                    end_err = true;
                } else {
                    reached_eof = true;
                }
                break;
            } else if ev.event_id == mpv::EVENT_SHUTDOWN {
                break;
            }
        }

        drop(core); // finalises muxer output and closes file handles

        if cancel.load(Ordering::Acquire) {
            if hls.is_some() {
                // Stopping mid-encode flushes a partial trailing segment; remove only that trailing segment.
                if let Some(partial) = last_playlist_seg(&m3u8) {
                    let _ = std::fs::remove_file(dir.join(format!("seg{partial}.ts")));
                }
                let _ = std::fs::remove_file(&m3u8);
                remove_tmp_files(&dir);
            } else {
                let _ = std::fs::remove_dir_all(&dir);
            }
            break;
        }

        if (end_err || !video_ok) && use_gpu && attempt_idx + 1 < attempts.len() {
            GPU_FILTER_BROKEN.store(true, Ordering::Relaxed);
            for bad in all_playlist_segs(&m3u8) {
                let _ = std::fs::remove_file(dir.join(format!("seg{bad}.ts")));
            }
            let _ = std::fs::remove_file(&m3u8);
            remove_tmp_files(&dir);
            continue;
        }

        if end_err || !video_ok {
            for bad in all_playlist_segs(&m3u8) {
                let _ = std::fs::remove_file(dir.join(format!("seg{bad}.ts")));
            }
            *error.lock().unwrap() = Some("The video couldn’t be converted".into());
        } else {
            if let Some((_, _, ref frontier)) = hls {
                if let Some(last) = last_playlist_seg(&m3u8) {
                    frontier.store(last, Ordering::Release);
                }
            }
            eof.store(reached_eof, Ordering::Release);
        }
        break;
    }

    done.store(true, Ordering::Release);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Reads duration, frame rate, audio/subtitle tracks (incl. sidecar files) and chapters.
#[tauri::command]
pub async fn stream_probe(path: String) -> Result<StreamProbe, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("File not found: {path}"));
    }
    tauri::async_runtime::spawn_blocking(move || probe_file(&p))
        .await
        .map_err(|e| e.to_string())?
}

/// Probes and returns the name of the H.264 encoder used for on-the-fly conversions.
#[tauri::command]
pub async fn stream_encoder() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| pick_encoder().map(str::to_owned))
        .await
        .map_err(|e| e.to_string())?
}

/// Makes a file streamable; returns its token.
#[tauri::command]
pub async fn stream_register(path: String, options: StreamOptions) -> Result<String, String> {
    ensure_server(0).await?;
    let s = shared()?;
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("File not found: {path}"));
    }
    let hls = if options.format == "hls" {
        let probe_path = p.clone();
        let probe = tauri::async_runtime::spawn_blocking(move || probe_file(&probe_path))
            .await
            .map_err(|e| e.to_string())??;
        Some(HlsPlan::from_probe(probe.duration, probe.fps))
    } else {
        None
    };
    let token = random_token();
    let dir = stream_cache_dir(&token);
    s.inner.lock().unwrap().streams.insert(
        token.clone(),
        Stream { path: p, opts: options, dir, hls, job: None, touched: Instant::now() },
    );
    Ok(token)
}

#[derive(Serialize)]
pub struct StreamUrl {
    /// Absolute URL a device on the network can open.
    url: String,
    /// Same, relative to the server (for the browser app).
    path: String,
    /// Where the stream starts (0 for direct & VOD HLS; requested time for live MPEG-TS).
    offset: f64,
}

/// URL for a registered stream starting at `start` seconds. `host` is the device that will play
/// it (its address picks the right network interface for the URL).
#[tauri::command]
pub async fn stream_url(_app: AppHandle, token: String, start: f64, host: Option<String>) -> Result<StreamUrl, String> {
    let port = ensure_server(0).await?;
    let s = shared()?;
    let (rel, offset) = {
        let mut inner = s.inner.lock().unwrap();
        let st = inner.streams.get_mut(&token).ok_or("Unknown stream")?;
        st.touched = Instant::now();
        match st.opts.format.as_str() {
            "direct" => (format!("/stream/{token}/file"), 0.0),
            "hls" => {
                let plan = st.hls.clone().ok_or("Missing HLS plan")?;
                let seg = ((start.max(0.0) / plan.seg_len).floor() as u32).min(plan.seg_count.saturating_sub(1));
                let cached = st.dir.join(format!("seg{seg}.ts")).exists();
                let covered = st.job.as_ref().is_some_and(|j| {
                    !j.cancel.load(Ordering::Acquire)
                        && !j.done.load(Ordering::Acquire)
                        && j.error.lock().unwrap().is_none()
                        && seg >= j.start_seg
                        && seg <= j.frontier.load(Ordering::Acquire).saturating_add(LOOKAHEAD_SEGS)
                });
                if !cached && !covered {
                    let prev = st.job.take().map(|old| {
                        old.stop();
                        old.done
                    });
                    st.job = Some(spawn_hls_job(&st.path, &st.opts, &plan, seg, &st.dir, prev)?);
                }
                (format!("/stream/{token}/index.m3u8"), 0.0)
            }
            _ => {
                let reuse = st.job.as_ref().is_some_and(|j| {
                    (j.start - start).abs() < 0.5 && j.error.lock().unwrap().is_none() && !j.cancel.load(Ordering::Acquire)
                });
                if !reuse {
                    let prev = st.job.take().map(|old| {
                        old.stop();
                        old.done
                    });
                    st.job = Some(spawn_ts_job(&st.path, &st.opts, start, &st.dir, prev)?);
                }
                let job = st.job.as_ref().unwrap();
                (format!("/stream/{token}/{}/live.ts", job.id), start.max(0.0))
            }
        }
    };
    let ip = host
        .as_deref()
        .and_then(local_ip_for)
        .map(|i| i.to_string())
        .or_else(|| lan_addresses().into_iter().next())
        .unwrap_or_else(|| "127.0.0.1".into());
    Ok(StreamUrl { url: format!("http://{ip}:{port}{rel}"), path: rel, offset })
}

/// Stops a stream's conversion and deletes its temporary segments.
#[tauri::command]
pub fn stream_release(token: String) {
    if let Ok(s) = shared() {
        let removed = s.inner.lock().unwrap().streams.remove(&token);
        if let Some(st) = removed {
            cleanup_stream_dir(st.job, st.dir);
        }
    }
}

#[derive(Serialize)]
pub struct ServerInfo {
    port: u16,
    addresses: Vec<String>,
    web_enabled: bool,
    encoder: Option<String>,
}

/// Turns the browser app on/off (with its access code and port).
#[tauri::command]
pub async fn remote_access_set(enabled: bool, code: String, port: u16) -> Result<ServerInfo, String> {
    let s = shared()?;
    let bound = if enabled { ensure_server(port).await? } else { s.inner.lock().unwrap().port };
    let mut inner = s.inner.lock().unwrap();
    if inner.access_code != code || !enabled {
        inner.web_tokens.clear(); // a new code signs everyone out
    }
    inner.web_enabled = enabled;
    inner.access_code = code;
    let encoder = ENCODER.lock().unwrap().map(str::to_owned);
    Ok(ServerInfo { port: bound, addresses: lan_addresses(), web_enabled: enabled, encoder })
}

#[tauri::command]
pub fn server_info() -> ServerInfo {
    let (port, web) = shared()
        .map(|s| {
            let i = s.inner.lock().unwrap();
            (i.port, i.web_enabled)
        })
        .unwrap_or((0, false));
    let encoder = ENCODER.lock().unwrap().map(str::to_owned);
    ServerInfo { port, addresses: lan_addresses(), web_enabled: web, encoder }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `TRUONGFLIX_STREAM_TEST=video.mkv cargo test -- --ignored real_stream --nocapture`
    #[test]
    #[ignore]
    fn real_stream_jobs_and_ranges() {
        let video = PathBuf::from(std::env::var("TRUONGFLIX_STREAM_TEST").expect("set TRUONGFLIX_STREAM_TEST"));
        let root = std::env::temp_dir().join("truongflix-stream-test");
        let _ = std::fs::remove_dir_all(&root);

        let enc = pick_encoder().expect("a working H.264 encoder");
        println!("Selected encoder: {enc}");
        assert!(!test_encoder("definitely_no_such_encoder_123"));

        let probe = probe_file(&video).expect("probe video");
        println!("Probed: duration={:.2}s fps={:.3} audio={} subs={}", probe.duration, probe.fps, probe.audio.len(), probe.subs.len());
        assert!(probe.duration > 1.0);
        let plan = HlsPlan::from_probe(probe.duration, probe.fps);
        let playlist = plan.playlist();
        assert!(playlist.contains("#EXT-X-PLAYLIST-TYPE:VOD") && playlist.contains("#EXT-X-ENDLIST"));

        let start_seg = if plan.seg_count > 3 { 2 } else { 0 };
        for tone_map in [false, true] {
            let dir = root.join(format!("hls-{tone_map}"));
            let sid = probe.subs.first().map(|s| s.id);
            let opts = StreamOptions {
                format: "hls".into(),
                width: 1280,
                height: 720,
                tone_map,
                aid: probe.audio.first().map(|a| a.id),
                sid,
                sub_style: vec![("sub-font-size".into(), "46".into())],
            };
            let t = Instant::now();
            let job = spawn_hls_job(&video, &opts, &plan, start_seg, &dir, None).unwrap();
            let first = dir.join(format!("seg{start_seg}.ts"));
            while !first.exists() && !job.done.load(Ordering::Acquire) && t.elapsed() < Duration::from_secs(60) {
                std::thread::sleep(Duration::from_millis(80));
            }
            assert!(job.error.lock().unwrap().is_none(), "hls tone_map={tone_map}: {:?}", job.error.lock().unwrap());
            assert!(std::fs::metadata(&first).map(|m| m.len() > 4000).unwrap_or(false), "missing {first:?}");
            job.stop();
            while !job.done.load(Ordering::Acquire) && t.elapsed() < Duration::from_secs(15) {
                std::thread::sleep(Duration::from_millis(50));
            }
            let files: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            assert!(!files.iter().any(|f| f.ends_with(".tmp")), "temp files left: {files:?}");
            println!("hls tone_map={tone_map} first+cancel in {:?}: {files:?}", t.elapsed());
        }

        // Live TS job (DLNA fallback).
        let ts_opts = StreamOptions { format: "ts".into(), width: 1280, height: 720, tone_map: false, aid: None, sid: None, sub_style: Vec::new() };
        let ts_job = spawn_ts_job(&video, &ts_opts, 0.0, &root, None).unwrap();
        let t = Instant::now();
        while std::fs::metadata(ts_job.dir.join("live.ts")).map(|m| m.len()).unwrap_or(0) < 10_000
            && !ts_job.done.load(Ordering::Acquire)
            && t.elapsed() < Duration::from_secs(60)
        {
            std::thread::sleep(Duration::from_millis(80));
        }
        assert!(ts_job.error.lock().unwrap().is_none(), "ts: {:?}", ts_job.error.lock().unwrap());
        assert!(std::fs::metadata(ts_job.dir.join("live.ts")).unwrap().len() >= 10_000);
        ts_job.stop();

        // Byte ranges over a real socket.
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let v = video.clone();
            tauri::async_runtime::spawn(async move {
                let (mut conn, _) = listener.accept().await.unwrap();
                let req = read_request(&mut conn).await.unwrap();
                serve_file_range(&mut conn, &v, req.headers.get("range").map(String::as_str), false).await.unwrap();
            });
            let mut c = TcpStream::connect(addr).await.unwrap();
            c.write_all(b"GET /x HTTP/1.1\r\nRange: bytes=100-199\r\n\r\n").await.unwrap();
            let mut out = Vec::new();
            c.read_to_end(&mut out).await.unwrap();
            let text = String::from_utf8_lossy(&out);
            assert!(text.starts_with("HTTP/1.1 206"), "{text}");
            let body = &out[out.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4..];
            assert_eq!(body, &std::fs::read(&video).unwrap()[100..200]);
        });
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn vod_playlist_and_query_strings() {
        assert_eq!(percent_decode("a%20b+c%2Fd"), "a b c/d");
        assert_eq!(percent_decode("%E2%9C%93"), "✓");
        assert!(local_ip_for("127.0.0.1").is_some());
        assert_eq!(random_token().len(), 32);

        let plan = HlsPlan::from_probe(1441.5, 24000.0 / 1001.0);
        assert_eq!(plan.gop, 96);
        assert!((plan.seg_len - 4.004).abs() < 1e-6);
        assert_eq!(plan.seg_count, 360);
        let m3u8 = plan.playlist();
        assert!(m3u8.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(m3u8.contains("#EXT-X-ENDLIST"));
        assert!(m3u8.contains("seg0.ts") && m3u8.contains("seg359.ts") && !m3u8.contains("seg360.ts"));
        let sum: f64 = m3u8
            .lines()
            .filter_map(|l| l.strip_prefix("#EXTINF:")?.strip_suffix(',')?.parse::<f64>().ok())
            .sum();
        assert!((sum - 1441.5).abs() < 0.01, "sum={sum}");
    }
}
