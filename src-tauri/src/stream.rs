//! Local media server for casting (Chromecast / DLNA) and the browser app on the home network.
//!
//! - `/stream/<token>/file`: the original file, with byte ranges (seeking).
//! - `/stream/<token>/<job>/index.m3u8` + segments: on-the-fly HLS (H.264/AAC, tone-mapped from
//!   HDR when needed), encoded by a headless mpv core. Seeking past what's encoded starts a new job.
//! - `/stream/<token>/<job>/live.ts`: a single MPEG-TS stream for TVs that reject the original.
//! - `/` and `/assets/…`: the browser app; `/api/…`: forwarded to the desktop app's frontend,
//!   which answers with the same library/progress code it uses itself.
//!
//! Stream URLs carry random 128-bit tokens; the browser app needs the access code shown in Settings.

use crate::media::Core;
use crate::player::mpv;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const IDLE_STREAM: Duration = Duration::from_secs(15 * 60);
const API_TIMEOUT: Duration = Duration::from_secs(20);

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
}

struct Job {
    id: String,
    dir: PathBuf,
    start: f64,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
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

fn shared() -> Result<&'static Shared, String> {
    SHARED.get().ok_or_else(|| "The media server isn't initialised".into())
}

pub fn init(app: &AppHandle) {
    let _ = SHARED.set(Shared { app: app.clone(), inner: Mutex::new(Inner::default()) });
    // Housekeeping: stop conversions nobody has asked for in a while.
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            if let Ok(s) = shared() {
                let mut inner = s.inner.lock().unwrap();
                inner.streams.retain(|_, st| {
                    let keep = st.touched.elapsed() < IDLE_STREAM;
                    if !keep {
                        if let Some(job) = &st.job {
                            job.stop();
                            let _ = std::fs::remove_dir_all(&job.dir);
                        }
                    }
                    keep
                });
            }
        }
    });
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS random generator");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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
        let code = serde_json::from_slice::<serde_json::Value>(&req.body).ok().and_then(|v| v["code"].as_str().map(str::to_owned)).unwrap_or_default();
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
        "body": serde_json::from_slice::<serde_json::Value>(&req.body).unwrap_or(serde_json::Value::Null),
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
    let found = shared().ok().and_then(|s| {
        let mut inner = s.inner.lock().unwrap();
        inner.streams.get_mut(&token).map(|st| {
            st.touched = Instant::now();
            let job = st.job.as_ref().map(|j| (j.id.clone(), j.dir.clone(), j.done.clone(), j.error.clone()));
            (st.path.clone(), job)
        })
    });
    let Some((path, job)) = found else { return respond(conn, 404, "text/plain", "", b"Unknown stream", false).await };
    let head_only = req.method == "HEAD";

    if second == "file" {
        return serve_file_range(conn, &path, req.headers.get("range").map(String::as_str), head_only).await;
    }
    let Some((_, dir, done, error)) = job.filter(|j| j.0 == second) else {
        return respond(conn, 404, "text/plain", "", b"This conversion has ended", false).await;
    };
    let file = dir.join(&third);
    if third == "index.m3u8" {
        // Wait for the first segments rather than handing out an empty playlist.
        let started = Instant::now();
        loop {
            if let Ok(text) = tokio::fs::read_to_string(&file).await {
                if text.contains(".m4s") || done.load(Ordering::Acquire) {
                    // A still-growing (EVENT) playlist looks live to players; start at the beginning.
                    let text = if text.contains("#EXT-X-START") { text } else { text.replacen("#EXTM3U\n", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n", 1) };
                    return respond(conn, 200, "application/vnd.apple.mpegurl", "Cache-Control: no-cache\r\n", text.as_bytes(), head_only).await;
                }
            }
            let failed = error.lock().unwrap().clone();
            if let Some(e) = failed {
                return respond(conn, 503, "text/plain", "", e.as_bytes(), false).await;
            }
            if started.elapsed() > Duration::from_secs(40) {
                return respond(conn, 503, "text/plain", "", b"Conversion is taking too long", false).await;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    if third == "live.ts" {
        return serve_growing(conn, &file, &done, head_only).await;
    }
    if third.ends_with(".m4s") || third == "init.mp4" {
        // Segments are written to a temp name and renamed once complete.
        let started = Instant::now();
        while !file.exists() {
            if done.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(30) {
                return respond(conn, 404, "text/plain", "", b"No such segment", false).await;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let bytes = tokio::fs::read(&file).await?;
        return respond(conn, 200, "video/mp4", "Cache-Control: public, max-age=3600\r\n", &bytes, head_only).await;
    }
    respond(conn, 404, "text/plain", "", b"Not found", false).await
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
// Conversion jobs (headless mpv in encoding mode)
// ---------------------------------------------------------------------------

fn encoder_options() -> (&'static str, &'static str) {
    if cfg!(target_os = "macos") {
        ("h264_videotoolbox", "b=6M,maxrate=10M,g=48")
    } else {
        ("libx264", "preset=veryfast,crf=21,g=48,keyint_min=48,sc_threshold=0,profile=high,level=4.1")
    }
}

fn start_job(path: &Path, opts: &StreamOptions, start: f64, root: &Path) -> Result<Job, String> {
    let id = random_token()[..12].to_string();
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (cancel, done, error) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(None)));
    let job = Job { id, dir: dir.clone(), start, cancel: cancel.clone(), done: done.clone(), error: error.clone() };
    let (path, opts) = (path.to_path_buf(), opts.clone());
    std::thread::spawn(move || {
        let hls = opts.format == "hls";
        let out = dir.join(if hls { "index.m3u8" } else { "live.ts" }).to_string_lossy().into_owned();
        let (ovc, ovcopts) = encoder_options();
        let start_s = format!("{:.3}", start.max(0.0));
        let (w, h) = (opts.width.max(2) & !1, opts.height.max(2) & !1);
        let vf = if opts.tone_map && opts.width > 0 {
            format!("gpu=w={w}:h={h}")
        } else if opts.width > 0 {
            format!("scale={w}:{h}")
        } else {
            String::new()
        };
        let aid = opts.aid.map(|a| a.to_string()).unwrap_or_else(|| "auto".into());
        let mut options: Vec<(&str, &str)> = vec![
            ("o", &out),
            ("ovc", ovc),
            ("ovcopts", ovcopts),
            ("oac", "aac"),
            ("oacopts", "b=192k"),
            ("audio-channels", "stereo"),
            ("audio-samplerate", "48000"),
            ("start", &start_s),
            ("sid", "no"),
            ("aid", &aid),
            ("hwdec", "auto-copy-safe"),
            ("keep-open", "no"),
        ];
        if hls {
            options.push(("of", "hls"));
            options.push(("ofopts", "hls_time=4,hls_list_size=0,hls_playlist_type=event,hls_segment_type=fmp4,hls_flags=independent_segments+temp_file"));
        } else {
            options.push(("of", "mpegts"));
        }
        if !vf.is_empty() {
            options.push(("vf", &vf));
        }
        if opts.tone_map {
            options.extend([("target-prim", "bt.709"), ("target-trc", "bt.1886"), ("tone-mapping", "bt.2390")]);
        }
        let core = match Core::new(&options) {
            Ok(c) => c,
            Err(e) => {
                *error.lock().unwrap() = Some(e);
                done.store(true, Ordering::Release);
                return;
            }
        };
        let file = path.to_string_lossy().into_owned();
        if let Err(e) = core.api.command(core.h, &["loadfile", &file, "replace"]) {
            *error.lock().unwrap() = Some(e);
        } else {
            loop {
                if cancel.load(Ordering::Acquire) {
                    let _ = core.api.command(core.h, &["stop"]);
                    break;
                }
                let ev = unsafe { &*(core.api.wait_event)(core.h, 0.25) };
                if ev.event_id == mpv::EVENT_END_FILE {
                    if !ev.data.is_null() && unsafe { &*(ev.data as *const mpv::EventEndFile) }.reason == mpv::END_FILE_REASON_ERROR {
                        *error.lock().unwrap() = Some("The video couldn’t be converted".into());
                    }
                    break;
                }
                if ev.event_id == mpv::EVENT_SHUTDOWN {
                    break;
                }
            }
        }
        drop(core); // finalises the output
        done.store(true, Ordering::Release);
        if cancel.load(Ordering::Acquire) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    });
    Ok(job)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Makes a file streamable; returns its token.
#[tauri::command]
pub async fn stream_register(path: String, options: StreamOptions) -> Result<String, String> {
    ensure_server(0).await?;
    let s = shared()?;
    if !Path::new(&path).is_file() {
        return Err(format!("File not found: {path}"));
    }
    let token = random_token();
    s.inner.lock().unwrap().streams.insert(token.clone(), Stream { path: PathBuf::from(path), opts: options, job: None, touched: Instant::now() });
    Ok(token)
}

#[derive(Serialize)]
pub struct StreamUrl {
    /// Absolute URL a device on the network can open.
    url: String,
    /// Same, relative to the server (for the browser app).
    path: String,
    /// Where the stream starts (conversions start at the requested time).
    offset: f64,
}

/// URL for a registered stream starting at `start` seconds. `host` is the device that will play
/// it (its address picks the right network interface for the URL).
#[tauri::command]
pub async fn stream_url(app: AppHandle, token: String, start: f64, host: Option<String>) -> Result<StreamUrl, String> {
    let port = ensure_server(0).await?;
    let s = shared()?;
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("streams").join(&token);
    let (rel, offset, wait_for) = {
        let mut inner = s.inner.lock().unwrap();
        let st = inner.streams.get_mut(&token).ok_or("Unknown stream")?;
        st.touched = Instant::now();
        if st.opts.format == "direct" {
            (format!("/stream/{token}/file"), 0.0, None)
        } else {
            let reuse = st.job.as_ref().is_some_and(|j| (j.start - start).abs() < 0.5 && j.error.lock().unwrap().is_none() && !j.cancel.load(Ordering::Acquire));
            if !reuse {
                if let Some(old) = st.job.take() {
                    old.stop();
                }
                st.job = Some(start_job(&st.path, &st.opts, start, &root)?);
            }
            let job = st.job.as_ref().unwrap();
            let name = if st.opts.format == "hls" { "index.m3u8" } else { "live.ts" };
            (format!("/stream/{token}/{}/{name}", job.id), start, (st.opts.format == "hls").then(|| (job.dir.join("index.m3u8"), job.done.clone(), job.error.clone())))
        }
    };
    // HLS: hand out the URL once the first segments exist, so players don't give up.
    if let Some((playlist, done, error)) = wait_for {
        let started = Instant::now();
        loop {
            if tokio::fs::read_to_string(&playlist).await.map(|t| t.contains(".m4s")).unwrap_or(false) || done.load(Ordering::Acquire) {
                break;
            }
            let failed = error.lock().unwrap().clone();
            if let Some(e) = failed {
                return Err(e);
            }
            if started.elapsed() > Duration::from_secs(40) {
                return Err("The conversion didn’t start in time".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    let ip = host.as_deref().and_then(local_ip_for).map(|i| i.to_string()).or_else(|| lan_addresses().into_iter().next()).unwrap_or_else(|| "127.0.0.1".into());
    Ok(StreamUrl { url: format!("http://{ip}:{port}{rel}"), path: rel, offset })
}

/// Stops a stream's conversion and forgets it.
#[tauri::command]
pub fn stream_release(token: String) {
    if let Ok(s) = shared() {
        if let Some(st) = s.inner.lock().unwrap().streams.remove(&token) {
            if let Some(job) = st.job {
                job.stop();
            }
        }
    }
}

#[derive(Serialize)]
pub struct ServerInfo {
    port: u16,
    addresses: Vec<String>,
    web_enabled: bool,
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
    Ok(ServerInfo { port: bound, addresses: lan_addresses(), web_enabled: enabled })
}

#[tauri::command]
pub fn server_info() -> ServerInfo {
    let (port, web) = shared().map(|s| {
        let i = s.inner.lock().unwrap();
        (i.port, i.web_enabled)
    }).unwrap_or((0, false));
    ServerInfo { port, addresses: lan_addresses(), web_enabled: web }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `TRUONGFLIX_STREAM_TEST=video.mkv cargo test --release -- --ignored real_stream --nocapture`
    #[test]
    #[ignore]
    fn real_stream_jobs_and_ranges() {
        let video = PathBuf::from(std::env::var("TRUONGFLIX_STREAM_TEST").expect("set TRUONGFLIX_STREAM_TEST"));
        let root = std::env::temp_dir().join("truongflix-stream-test");
        let _ = std::fs::remove_dir_all(&root);
        for (format, tone_map) in [("hls", false), ("ts", false), ("hls", true)] {
            let opts = StreamOptions { format: format.into(), width: 1280, height: 720, tone_map, aid: None };
            let t = Instant::now();
            let job = start_job(&video, &opts, 20.0, &root).unwrap();
            while !job.done.load(Ordering::Acquire) && t.elapsed() < Duration::from_secs(120) {
                std::thread::sleep(Duration::from_millis(100));
            }
            assert!(job.error.lock().unwrap().is_none(), "{format}: {:?}", job.error.lock().unwrap());
            let files: Vec<String> = std::fs::read_dir(&job.dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            println!("{format} tone_map={tone_map}: {} files in {:?}", files.len(), t.elapsed());
            if format == "hls" {
                let playlist = std::fs::read_to_string(job.dir.join("index.m3u8")).unwrap();
                assert!(playlist.contains("#EXT-X-ENDLIST") && files.contains(&"init.mp4".to_string()), "{playlist}");
                assert!(!files.iter().any(|f| f.ends_with(".tmp")), "temp files left: {files:?}");
            } else {
                assert!(std::fs::metadata(job.dir.join("live.ts")).unwrap().len() > 10_000);
            }
        }
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
    }

    #[test]
    fn decodes_query_strings() {
        assert_eq!(percent_decode("a%20b+c%2Fd"), "a b c/d");
        assert_eq!(percent_decode("%E2%9C%93"), "✓");
        assert!(local_ip_for("127.0.0.1").is_some());
        assert_eq!(random_token().len(), 32);
    }
}
