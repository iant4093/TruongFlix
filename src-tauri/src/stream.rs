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
//! Only home-network and Tailscale addresses may connect (see `remote_guard`).

use crate::media::Core;
use crate::player::mpv;
use crate::remote_guard::{self, LoginCheck, LoginGuard};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const IDLE_STREAM: Duration = Duration::from_secs(15 * 60);
/// A growing stream that hasn't grown for this long is ended (its conversion stalled or died).
const STALLED_STREAM: Duration = Duration::from_secs(120);
/// A TV paused on the converted (no seeking) stream stops reading until play is pressed: it must
/// get its pause back, so only a client gone this long counts as gone (a closed connection fails
/// at once anyway). 60 seconds ended every paused cast on these TVs.
const PAUSED_CLIENT: Duration = Duration::from_secs(20 * 60);

/// Marks a conversion finished when its thread ends, however it ends (a panic too): waiters on a
/// conversion that never set `done` used to wait forever.
struct DoneOnDrop(Arc<AtomicBool>);
impl Drop for DoneOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
const API_TIMEOUT: Duration = Duration::from_secs(20);
/// Whole request (headers and body) must arrive within this time.
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 96;
/// Browser sign-ins end after this long unused, and after `SESSION_MAX` regardless.
const SESSION_IDLE: Duration = Duration::from_secs(14 * 24 * 3600);
const SESSION_MAX: Duration = Duration::from_secs(60 * 24 * 3600);
const MAX_SESSIONS: usize = 32;
const PROBE_TTL: Duration = Duration::from_secs(120);
const PROBE_CACHE_MAX: usize = 256;
/// A request this many segments past the encoder still waits for it (about 20 s) instead of restarting it.
const LOOKAHEAD_SEGS: u32 = 10;
/// Longest a music conversion (audio only, much faster than real time) may take.
const AUDIO_ENCODE_WAIT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct StreamOptions {
    /// "direct" | "hls" | "ts" | "mp4" (a single progressive MP4 for saving offline) | "aac" (audio-only, for music)
    /// | "alac" (lossless audio-only, for Safari: it seeks inside FLAC files only roughly)
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
    /// Target video bitrate in kbit/s for conversions (0 = the encoder's default quality).
    #[serde(default)]
    pub bitrate: u32,
    /// Peak video bitrate in kbit/s (0 = 1.5 × `bitrate`).
    #[serde(default)]
    pub maxrate: u32,
    /// Converts only this many seconds (0 = the whole file). Tests only; never sent by the app.
    #[serde(skip)]
    pub length: f64,
}

const FORMATS: [&str; 6] = ["direct", "hls", "ts", "mp4", "aac", "alac"];
const MAX_BITRATE_KBPS: u32 = 80_000;
const MAX_WIDTH: u32 = 7680;
const MAX_HEIGHT: u32 = 4320;

/// Keeps options from callers within what the encoder accepts.
fn sanitize_options(mut o: StreamOptions) -> Result<StreamOptions, String> {
    if !FORMATS.contains(&o.format.as_str()) {
        return Err(format!("Unknown stream format: {}", o.format));
    }
    o.sub_style = sanitize_sub_style(std::mem::take(&mut o.sub_style));
    o.width = o.width.min(MAX_WIDTH);
    o.height = o.height.min(MAX_HEIGHT);
    o.bitrate = o.bitrate.min(MAX_BITRATE_KBPS);
    o.maxrate = o.maxrate.min(MAX_BITRATE_KBPS * 2);
    o.length = 0.0;
    Ok(o)
}

fn is_number(v: &str, max: f64) -> bool {
    v.len() <= 24 && v.parse::<f64>().is_ok_and(|n| n.is_finite() && (0.0..=max).contains(&n))
}

fn is_color(v: &str) -> bool {
    v.strip_prefix('#').is_some_and(|h| matches!(h.len(), 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Subtitle appearance options are passed straight to mpv, so only known keys with plain values
/// get through (no paths, filters or extra options).
pub(crate) fn sub_style_allowed(key: &str, value: &str) -> bool {
    match key {
        "sub-font-size" => is_number(value, 200.0),
        "sub-outline-size" | "sub-border-size" | "sub-shadow-offset" => is_number(value, 50.0),
        "sub-margin-y" | "sub-margin-x" => is_number(value, 500.0),
        "sub-scale" => is_number(value, 10.0),
        "sub-color" | "sub-outline-color" | "sub-border-color" | "sub-back-color" | "sub-shadow-color" => is_color(value),
        "sub-border-style" => matches!(value, "outline-and-shadow" | "opaque-box" | "background-box"),
        "sub-bold" | "sub-italic" => matches!(value, "yes" | "no"),
        "sub-font" => {
            !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        }
        _ => false,
    }
}

fn sanitize_sub_style(style: Vec<(String, String)>) -> Vec<(String, String)> {
    style.into_iter().filter(|(k, v)| sub_style_allowed(k, v)).take(16).collect()
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
        // 2-second segments: playback starts (and resumes after a seek) as soon as 2 s are converted.
        // Safari plays HLS itself and waits for whole segments, so shorter ones start much sooner there.
        let gop = ((2.0 * fps).round() as u32).clamp(12, 240);
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

    /// Finished on its own, without an error (a download MP4 is complete).
    fn finished_ok(&self) -> bool {
        self.done.load(Ordering::Acquire) && self.eof.load(Ordering::Acquire) && !self.cancel.load(Ordering::Acquire) && self.error.lock().unwrap().is_none()
    }
}

/// What a conversion job writes.
#[derive(Clone)]
enum Output {
    /// VOD HLS segments from a start segment; the frontier is the last finished segment.
    Hls(HlsPlan, u32, Arc<AtomicU32>),
    /// One growing MPEG-TS file (`live.ts`).
    Ts,
    /// One progressive MP4 for saving offline; the counter is progress in thousandths.
    Mp4(Arc<AtomicU32>),
}

/// Download MP4 while it is being written, and once it is complete.
const MP4_PART: &str = "download.part.mp4";
const MP4_READY: &str = "download.mp4";

struct Stream {
    path: PathBuf,
    opts: StreamOptions,
    dir: PathBuf,
    hls: Option<HlsPlan>,
    job: Option<Job>,
    touched: Instant,
}

/// A browser signed in with the access code.
struct WebSession {
    /// Public id (shown in Settings, used to sign the device out); the token itself stays secret.
    id: String,
    device: String,
    ip: IpAddr,
    created: SystemTime,
    last_used: SystemTime,
}

impl WebSession {
    fn expired(&self, now: SystemTime) -> bool {
        now.duration_since(self.last_used).unwrap_or_default() > SESSION_IDLE
            || now.duration_since(self.created).unwrap_or_default() > SESSION_MAX
    }
}

#[derive(Default)]
struct Inner {
    port: u16,
    listener: Option<tauri::async_runtime::JoinHandle<()>>,
    streams: HashMap<String, Stream>,
    web_enabled: bool,
    access_code: String,
    /// Signed-in browsers by secret token.
    web_sessions: HashMap<String, WebSession>,
    login: LoginGuard,
    pending: HashMap<u64, tokio::sync::oneshot::Sender<(u16, String)>>,
    next_request: u64,
}

impl Inner {
    /// The session for `token` (refreshing its last use), or None if unknown or expired.
    fn session_for(&mut self, token: &str, ip: IpAddr, ended: &mut Vec<String>) -> Option<(String, String)> {
        if token.is_empty() {
            return None;
        }
        let now = SystemTime::now();
        let session = self.web_sessions.get_mut(token)?;
        if session.expired(now) {
            ended.push(session.id.clone());
            self.web_sessions.remove(token);
            return None;
        }
        session.last_used = now;
        session.ip = ip;
        Some((session.id.clone(), session.device.clone()))
    }

    fn end_sessions(&mut self, keep: impl Fn(&WebSession) -> bool) -> Vec<String> {
        let mut ended = Vec::new();
        self.web_sessions.retain(|_, s| {
            let k = keep(s);
            if !k {
                ended.push(s.id.clone());
            }
            k
        });
        ended
    }
}

/// Tells the desktop app to stop browser playback that belonged to ended sign-ins.
fn announce_ended(app: &AppHandle, ended: Vec<String>) {
    for id in ended {
        let _ = app.emit("remote-session-ended", id);
    }
}

struct Shared {
    app: AppHandle,
    inner: Mutex<Inner>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();
static ENCODER: Mutex<Option<&'static str>> = Mutex::new(None);
/// The chosen encoder accepted `speed_opts` in its test encode.
static ENCODER_FAST: AtomicBool = AtomicBool::new(false);
static GPU_FILTER_BROKEN: AtomicBool = AtomicBool::new(false);
/// Set when libmpv's FFmpeg lacks the zscale/tonemap filters, so HDR falls back to an untone-mapped copy.
static FILTER_TONEMAP_BROKEN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq, Debug)]
enum Convert {
    /// mpv's GPU renderer tone-maps (macOS).
    Gpu,
    /// FFmpeg's zscale + tonemap filters tone-map on the CPU (Windows, or when the GPU path fails).
    Filters,
    /// Copy colours as they are: HDR looks washed out, but it plays.
    Plain,
}

/// The video filter for a conversion. HDR (PQ/HLG) has to be tone-mapped to SDR BT.709, or a
/// browser shows it grey and washed out.
///
/// Speed: the picture is shrunk first, so a 4K HDR file sent at 1080p is tone-mapped at a quarter
/// of the pixels (the 32-bit float steps are the slow part), and plain resizes use bilinear
/// scaling, which is several times quicker than the default and looks the same at streaming sizes.
fn video_filter(mode: Convert, w: u32, h: u32) -> String {
    let size = |sep: &str| if w > 0 { format!("{sep}w={w}:h={h}") } else { String::new() };
    match mode {
        Convert::Gpu => format!("gpu{},format=yuv420p", if w > 0 { format!("=w={w}:h={h}") } else { String::new() }),
        Convert::Filters => format!(
            "lavfi=[zscale={}t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p]",
            if w > 0 { format!("{}:f=bilinear:", size("")) } else { String::new() }
        ),
        Convert::Plain if w > 0 => format!("scale={w}:{h}:flags=bilinear,format=yuv420p"),
        Convert::Plain => "format=yuv420p".into(),
    }
}
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
    // Conversions (including download MP4s) left behind when the app last quit.
    // Only the app's own cache folder, never the shared temp dir.
    // Moved aside first (instant), so new streams never land in a folder being deleted.
    if let Ok(cache) = app.path().app_cache_dir() {
        let old = cache.join(format!("streams-old-{}", &random_token()[..8]));
        if std::fs::rename(cache.join("streams"), &old).is_ok() {
            std::thread::spawn(move || {
                let _ = std::fs::remove_dir_all(old);
            });
        }
    }
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
/// One server start at a time: two first-time starts at once used to bind two ports, and the second
/// closed the first, breaking the links already handed out for it.
static SERVER_START: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn ensure_server(port: u16) -> Result<u16, String> {
    let _starting = SERVER_START.lock().await;
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
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let (conn, peer) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            // Home network and Tailscale only, even if a router forwards the port.
            if !remote_guard::peer_allowed(peer.ip()) {
                continue;
            }
            let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
            tauri::async_runtime::spawn(async move {
                let _ = handle(conn, peer).await;
                drop(slot);
            });
        }
    });
    let old = {
        let mut inner = s.inner.lock().unwrap();
        inner.port = bound;
        inner.listener.replace(task)
    };
    // A changed port closes the old one (connections already open finish normally).
    if let Some(old) = old {
        old.abort();
    }
    crate::tailscale::refresh_dns_name();
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

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decodes `%XX` escapes (and `+` as a space in query strings) on bytes, so malformed input can't
/// split a multi-byte character.
fn percent_decode_with(s: &str, plus_is_space: bool) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(if plus_is_space && bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_decode(s: &str) -> String {
    percent_decode_with(s, true)
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
    Some(Request { method, path: percent_decode_with(path, false), query, raw_query: qs.to_string(), headers, body })
}

/// Media only: TVs and Chromecast receivers fetch streams from another origin.
const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range\r\n";
const SECURITY_HEADERS: &str = "X-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\n";
const APP_CSP: &str = "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://image.tmdb.org https://a.espncdn.com; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; frame-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n";

tokio::task_local! {
    /// Set while answering a `/stream/…` request, whose responses carry CORS headers.
    static MEDIA_RESPONSE: bool;
}

fn cors() -> &'static str {
    if MEDIA_RESPONSE.try_with(|m| *m).unwrap_or(false) { CORS } else { "" }
}

async fn respond(conn: &mut TcpStream, status: u16, content_type: &str, extra: &str, body: &[u8], head_only: bool) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        421 => "Misdirected Request",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{}{SECURITY_HEADERS}{extra}Connection: close\r\n\r\n",
        body.len(),
        cors(),
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

#[derive(Clone, Serialize)]
struct SecurityEvent {
    kind: &'static str,
    device: String,
    ip: String,
}

fn security_event(app: &AppHandle, kind: &'static str, device: &str, ip: IpAddr) {
    let _ = app.emit("remote-security", SecurityEvent { kind, device: device.to_string(), ip: ip.to_string() });
}

fn minutes(d: Duration) -> u64 {
    d.as_secs().div_ceil(60).max(1)
}

async fn login(conn: &mut TcpStream, req: &Request, ip: IpAddr, key: &str) -> std::io::Result<()> {
    let s = shared().map_err(std::io::Error::other)?;
    let code = serde_json::from_slice::<Value>(&req.body).ok().and_then(|v| v["code"].as_str().map(str::to_owned)).unwrap_or_default();
    let device = remote_guard::describe_device(req.headers.get("user-agent").map(String::as_str).unwrap_or_default());
    let now = Instant::now();
    enum Outcome {
        Token(String),
        Wrong(usize, bool),
        Locked(Duration),
        Paused,
    }
    let (outcome, evicted) = {
        let mut inner = s.inner.lock().unwrap();
        match inner.login.check(key, now) {
            LoginCheck::Paused => (Outcome::Paused, Vec::new()),
            LoginCheck::Locked(d) => (Outcome::Locked(d), Vec::new()),
            LoginCheck::Allowed => {
                if !code.trim().is_empty() && remote_guard::constant_time_eq(code.trim(), &inner.access_code) {
                    inner.login.succeeded(key);
                    let mut evicted = Vec::new();
                    if inner.web_sessions.len() >= MAX_SESSIONS {
                        if let Some(oldest) = inner.web_sessions.iter().min_by_key(|(_, w)| w.last_used).map(|(t, _)| t.clone()) {
                            if let Some(w) = inner.web_sessions.remove(&oldest) {
                                evicted.push(w.id);
                            }
                        }
                    }
                    let token = random_token();
                    let now = SystemTime::now();
                    let id = random_token()[..12].to_string();
                    inner.web_sessions.insert(token.clone(), WebSession { id, device: device.clone(), ip, created: now, last_used: now });
                    (Outcome::Token(token), evicted)
                } else {
                    let left = inner.login.failed(key, now);
                    (Outcome::Wrong(left, inner.login.paused()), Vec::new())
                }
            }
        }
    };
    announce_ended(&s.app, evicted);
    match outcome {
        Outcome::Token(token) => {
            security_event(&s.app, "signin", &device, ip);
            respond_json(conn, 200, &serde_json::json!({ "token": token }).to_string()).await
        }
        Outcome::Wrong(left, paused) => {
            tokio::time::sleep(Duration::from_millis(800)).await;
            if paused {
                security_event(&s.app, "paused", &device, ip);
            } else if left == 0 {
                security_event(&s.app, "locked", &device, ip);
            }
            let message = if paused {
                "Sign-in is paused after too many wrong codes. Make a new code in TruongFlix › Settings › Devices.".to_string()
            } else if left == 0 {
                format!("Too many wrong codes. Try again in {} minutes.", minutes(remote_guard::DEVICE_LOCKOUT))
            } else {
                format!("Wrong code. {left} {} left.", if left == 1 { "try" } else { "tries" })
            };
            respond_json(conn, 401, &serde_json::json!({ "error": message }).to_string()).await
        }
        Outcome::Locked(d) => {
            respond_json(conn, 429, &serde_json::json!({ "error": format!("Too many wrong codes. Try again in {} minutes.", minutes(d)) }).to_string()).await
        }
        Outcome::Paused => respond_json(
            conn,
            403,
            r#"{"error":"Sign-in is paused after too many wrong codes. Make a new code in TruongFlix › Settings › Devices."}"#,
        )
        .await,
    }
}

async fn handle(mut conn: TcpStream, peer: SocketAddr) -> std::io::Result<()> {
    let Ok(Some(req)) = tokio::time::timeout(REQUEST_DEADLINE, read_request(&mut conn)).await else { return Ok(()) };
    let host = req.headers.get("host").map(String::as_str);
    if !remote_guard::host_allowed(host) {
        return respond(&mut conn, 421, "text/plain", "", b"Not found", false).await;
    }
    // Tailscale Serve and Funnel both arrive from this computer itself. Funnel is the public
    // internet: refused, so the server stays "home network and Tailscale only" even if Funnel
    // gets turned on (Tailscale marks those requests, and the real client must be on the tailnet).
    if peer.ip().is_loopback() {
        let funnel = req.headers.contains_key("tailscale-funnel-request");
        let outside = remote_guard::forwarded_ip(peer.ip(), req.headers.get("x-forwarded-for").map(String::as_str))
            .is_some_and(|ip| !remote_guard::peer_allowed(ip));
        if funnel || outside {
            return respond(&mut conn, 403, "text/plain", "", b"Not available from the internet", false).await;
        }
    }
    if let Some(rest) = req.path.strip_prefix("/stream/") {
        if req.method == "OPTIONS" {
            return MEDIA_RESPONSE
                .scope(true, respond(&mut conn, 204, "text/plain", "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n", b"", false))
                .await;
        }
        return MEDIA_RESPONSE.scope(true, serve_stream(&mut conn, &req, rest)).await;
    }
    if let Some(name) = req.path.strip_prefix("/music-art/") {
        return serve_music_art(&mut conn, name, req.method == "HEAD").await;
    }
    if !matches!(req.method.as_str(), "GET" | "HEAD" | "POST") {
        return respond(&mut conn, 405, "text/plain", "", b"Not allowed", false).await;
    }
    let s = match shared() {
        Ok(s) => s,
        Err(_) => return respond(&mut conn, 503, "text/plain", "", b"Starting", false).await,
    };
    if !s.inner.lock().unwrap().web_enabled {
        return respond(&mut conn, 403, "text/html; charset=utf-8", "", OFF_PAGE.as_bytes(), false).await;
    }
    if !req.path.starts_with("/api/") {
        return serve_app_asset(&mut conn, &req).await;
    }
    let origin = req.headers.get("origin").map(String::as_str);
    let forwarded = req.headers.get("x-forwarded-host").map(String::as_str);
    let tailnet_name = crate::tailscale::own_dns_name();
    if !remote_guard::origin_allowed(origin, host, forwarded, peer.ip().is_loopback(), tailnet_name.as_deref()) {
        return respond_json(&mut conn, 403, r#"{"error":"Open TruongFlix from its own address"}"#).await;
    }
    let forwarded_for = req.headers.get("x-forwarded-for").map(String::as_str);
    let client_ip = remote_guard::forwarded_ip(peer.ip(), forwarded_for).unwrap_or(peer.ip());
    if req.path == "/api/login" {
        if req.method != "POST" {
            return respond_json(&mut conn, 405, r#"{"error":"Not allowed"}"#).await;
        }
        let key = remote_guard::client_key(peer.ip(), req.headers.get("tailscale-user-login").map(String::as_str), forwarded_for);
        return login(&mut conn, &req, client_ip, &key).await;
    }
    let token = req.headers.get("x-tf-token").cloned().unwrap_or_default();
    let mut ended = Vec::new();
    let session = s.inner.lock().unwrap().session_for(&token, client_ip, &mut ended);
    announce_ended(&s.app, ended);
    let Some((session_id, device)) = session else {
        return respond_json(&mut conn, 401, r#"{"error":"Sign in with the access code"}"#).await;
    };
    let (status, body) = forward_api(&req, &session_id, &device).await;
    respond_json(&mut conn, status, &body).await
}

const OFF_PAGE: &str = "<!doctype html><meta name=viewport content='width=device-width'><body style='background:#141414;color:#eee;font-family:system-ui;display:grid;place-items:center;height:90vh;text-align:center'><div><h1 style='color:#e50914'>TruongFlix</h1><p>Browser access is turned off.<br>Turn it on in TruongFlix › Settings › Devices.</p></div>";

/// Hands an `/api/…` request to the desktop app's frontend and waits for its answer.
async fn forward_api(req: &Request, session: &str, device: &str) -> (u16, String) {
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
        // Which signed-in browser asked, so playback can only be controlled by its owner.
        "session": session,
        "device": device,
        "pc": pc_name(),
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

/// This computer's name, shown in the browser app's "Playing on …" remote.
fn pc_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let clean = |n: String| Some(n.trim().to_string()).filter(|n| !n.is_empty());
        #[cfg(target_os = "macos")]
        if let Some(n) = std::process::Command::new("scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .and_then(|o| clean(String::from_utf8_lossy(&o.stdout).into_owned()))
        {
            return n;
        }
        std::env::var("COMPUTERNAME")
            .ok()
            .and_then(clean)
            .or_else(|| std::env::var("HOSTNAME").ok().and_then(clean))
            .or_else(|| std::fs::read_to_string("/etc/hostname").ok().and_then(clean))
            .unwrap_or_else(|| "your computer".into())
    })
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

/// Files the browser app may load: its page, the bundled `assets/`, and icons at the root.
fn app_asset_path(request_path: &str) -> Option<String> {
    let path = request_path.trim_start_matches('/');
    if path.is_empty() || !path.contains('.') {
        return Some("remote.html".into());
    }
    if path.split('/').any(|part| part.is_empty() || part == "." || part == "..") || path.contains('\\') {
        return None;
    }
    let root_icon = !path.contains('/')
        && [".png", ".svg", ".ico", ".webmanifest"].iter().any(|ext| path.to_ascii_lowercase().ends_with(ext));
    (path == "remote.html" || path.starts_with("assets/") || root_icon).then(|| path.to_string())
}

async fn serve_app_asset(conn: &mut TcpStream, req: &Request) -> std::io::Result<()> {
    if req.method == "POST" {
        return respond(conn, 405, "text/plain", "", b"Not allowed", false).await;
    }
    let head_only = req.method == "HEAD";
    // Development: the frontend (and Vite's module graph) is served by the dev server.
    #[cfg(debug_assertions)]
    {
        if req.path.starts_with("/@fs") || req.path.contains("..") {
            return respond(conn, 404, "text/plain", "", b"Not found", false).await;
        }
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
    let Some(path) = app_asset_path(&req.path) else {
        return respond(conn, 404, "text/plain", "", b"Not found", false).await;
    };
    if let Some(asset) = s.app.asset_resolver().get(path.clone()) {
        let extra = if path.starts_with("assets/") {
            "Cache-Control: public, max-age=31536000, immutable\r\n".to_string()
        } else if path == "remote.html" {
            format!("Cache-Control: no-cache\r\n{APP_CSP}")
        } else {
            "Cache-Control: no-cache\r\n".to_string()
        };
        return respond(conn, 200, &asset.mime_type, &extra, &asset.bytes, head_only).await;
    }
    respond(conn, 404, "text/plain", "", b"Not found", false).await
}

/// Cached album art for the music library. Names are unguessable keyed hashes (see `music`), like
/// stream tokens, so `<img>` tags can load them without the sign-in header.
async fn serve_music_art(conn: &mut TcpStream, name: &str, head_only: bool) -> std::io::Result<()> {
    let Some(dir) = crate::music::served_art_dir().filter(|_| crate::music::valid_art_name(name)) else {
        return respond(conn, 404, "text/plain", "", b"Not found", false).await;
    };
    let mime = match name.rsplit('.').next() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/jpeg",
    };
    match tokio::fs::read(dir.join(name)).await {
        Ok(bytes) => respond(conn, 200, mime, "Cache-Control: private, max-age=31536000, immutable\r\n", &bytes, head_only).await,
        Err(_) => respond(conn, 404, "text/plain", "", b"Not found", false).await,
    }
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
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("ogg" | "oga" | "opus") => "audio/ogg",
        Some("wav") => "audio/wav",
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
        let download = (st.opts.format == "mp4").then(|| (st.dir.join(MP4_READY), st.job.as_ref().is_some_and(Job::finished_ok)));
        Some((st.path.clone(), st.hls.clone(), live_job, download))
    });
    let Some((path, hls, live_job, download)) = info else {
        return respond(conn, 404, "text/plain", "", b"Unknown stream", false).await;
    };

    if second == "file" {
        return serve_file_range(conn, &path, req.headers.get("range").map(String::as_str), head_only).await;
    }
    if second == MP4_READY {
        return match download {
            Some((file, true)) => serve_file_range(conn, &file, req.headers.get("range").map(String::as_str), head_only).await,
            Some(_) => respond(conn, 409, "text/plain", "", b"Still converting", false).await,
            None => respond(conn, 404, "text/plain", "", b"Not a download", false).await,
        };
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
    if third == "audio.m4a" {
        let Some((_, dir, done)) = live_job.filter(|j| j.0 == second) else {
            return respond(conn, 404, "text/plain", "", b"This conversion has ended", false).await;
        };
        // Audio converts far faster than real time; the finished file supports seeking.
        let started = Instant::now();
        while !done.load(Ordering::Acquire) {
            if started.elapsed() > AUDIO_ENCODE_WAIT {
                return respond(conn, 503, "text/plain", "", b"Still converting", false).await;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        return serve_file_range(conn, &dir.join("audio.m4a"), req.headers.get("range").map(String::as_str), head_only).await;
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

    let started = Instant::now();
    let mut our_job: Option<String> = None;
    loop {
        if tokio::fs::try_exists(&seg_file).await.unwrap_or(false) {
            return send_segment(conn, &seg_file, head_only).await;
        }

        enum Step {
            Wait,
            EmptyEof,
            Failed(String),
            Gone,
        }

        let step = {
            let mut inner = s.inner.lock().unwrap();
            if let Some(st) = inner.streams.get_mut(token) {
                st.touched = Instant::now();
                {
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

/// A finished HLS segment, copied to the socket in chunks rather than read into memory.
async fn send_segment(conn: &mut TcpStream, path: &Path, head_only: bool) -> std::io::Result<()> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return respond(conn, 404, "text/plain", "", b"Segment not found", false).await,
    };
    let len = file.metadata().await?.len();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {len}\r\n{}{SECURITY_HEADERS}Cache-Control: public, max-age=3600\r\nConnection: close\r\n\r\n",
        cors(),
    );
    conn.write_all(header.as_bytes()).await?;
    if !head_only {
        let mut limited = (&mut file).take(len);
        tokio::io::copy_buf(&mut tokio::io::BufReader::with_capacity(128 * 1024, &mut limited), conn).await?;
    }
    conn.flush().await
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
    let mut grew = Instant::now();
    let timed_out = || std::io::Error::new(std::io::ErrorKind::TimedOut, "client stopped reading");
    loop {
        let n = file.read(&mut buf).await?;
        if n > 0 {
            grew = Instant::now();
            let mut chunk = format!("{n:X}\r\n").into_bytes();
            chunk.extend_from_slice(&buf[..n]);
            chunk.extend_from_slice(b"\r\n");
            tokio::time::timeout(PAUSED_CLIENT, conn.write_all(&chunk)).await.map_err(|_| timed_out())??;
            continue;
        }
        if done.load(Ordering::Acquire) || grew.elapsed() > STALLED_STREAM {
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

/// Encoder options. With a `bitrate` (kbit/s), x264 keeps its constant quality but is capped at
/// `maxrate`, and hardware encoders aim for `bitrate` with the same peak; without one, the old
/// defaults apply (casting and DLNA).
fn ovcopts_for(encoder: &str, gop: u32, bitrate: u32, maxrate: u32) -> String {
    let peak = if bitrate == 0 { 0 } else if maxrate == 0 { bitrate.saturating_mul(3) / 2 } else { maxrate.max(bitrate) };
    let buf = peak.saturating_mul(2);
    if encoder == "libx264" {
        let base = format!("preset=veryfast,crf=21,g={gop},keyint_min={gop},sc_threshold=0,profile=high");
        if bitrate == 0 { base } else { format!("{base},maxrate={peak}k,bufsize={buf}k") }
    } else if bitrate == 0 {
        format!("b=6M,maxrate=10M,g={gop}")
    } else {
        format!("b={bitrate}k,maxrate={peak}k,bufsize={buf}k,g={gop}")
    }
}

/// Speed settings for hardware encoders (their defaults favour quality over real-time speed).
/// Only used once a test encode shows this computer's driver accepts them.
fn speed_opts(encoder: &str) -> &'static str {
    match encoder {
        "h264_nvenc" => ",preset=p2",
        "h264_qsv" => ",preset=veryfast",
        "h264_amf" => ",quality=speed",
        "h264_videotoolbox" => ",realtime=1",
        _ => "",
    }
}

fn test_encoder(name: &str, extra: &str) -> bool {
    let tmp = std::env::temp_dir().join(format!("tf-enc-{}-{}.ts", name, random_token()));
    let out = tmp.to_string_lossy().into_owned();
    let ovcopts = format!("b=2M,g=24{extra}");
    let opts = [
        ("o", out.as_str()),
        ("of", "mpegts"),
        ("ovc", name),
        ("ovcopts", ovcopts.as_str()),
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
        if test_encoder(cand, "") {
            let fast = !speed_opts(cand).is_empty() && test_encoder(cand, speed_opts(cand));
            ENCODER_FAST.store(fast, Ordering::Relaxed);
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
    let mut cache = cache.lock().unwrap();
    cache.retain(|_, (at, _)| at.elapsed() < PROBE_TTL);
    while cache.len() >= PROBE_CACHE_MAX {
        let Some(oldest) = cache.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) else { break };
        cache.remove(&oldest);
    }
    cache.insert(path.to_path_buf(), (Instant::now(), probe.clone()));
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
        let _done = DoneOnDrop(done.clone());
        run_encode(path, opts, Output::Hls(plan, start_seg, frontier), start, dir, prev_done, cancel, done, eof, error);
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
        let _done = DoneOnDrop(done.clone());
        run_encode(path, opts, Output::Ts, start, dir, prev_done, cancel, done, eof, error);
    });
    Ok(job)
}

/// Converts the whole file into `dir/download.mp4` (H.264/AAC, index at the front), for saving
/// offline. Progress (thousandths) is in the job's `frontier`.
fn spawn_mp4_job(path: &Path, opts: &StreamOptions, dir: &Path, prev_done: Option<Arc<AtomicBool>>) -> Result<Job, String> {
    let id = random_token()[..12].to_string();
    let progress = Arc::new(AtomicU32::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let eof = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None));
    let job = Job {
        id,
        dir: dir.to_path_buf(),
        start: 0.0,
        start_seg: 0,
        frontier: progress.clone(),
        cancel: cancel.clone(),
        done: done.clone(),
        eof: eof.clone(),
        error: error.clone(),
    };
    let (path, opts, dir) = (path.to_path_buf(), opts.clone(), dir.to_path_buf());
    std::thread::spawn(move || {
        let _done = DoneOnDrop(done.clone());
        run_encode(path, opts, Output::Mp4(progress), 0.0, dir, prev_done, cancel, done, eof, error);
    });
    Ok(job)
}

/// Audio-only conversion to MP4: AAC for music a browser can't play (e.g. ALAC outside Safari), or
/// lossless ALAC for Safari, which plays FLAC but seeks inside it only roughly (the song and its
/// lyrics drifted apart after every seek). An MP4 has an exact index, so seeking is exact.
fn spawn_audio_job(path: &Path, root: &Path, lossless: bool) -> Job {
    let id = random_token()[..12].to_string();
    let dir = root.join(&id);
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None));
    let job = Job {
        id,
        dir: dir.clone(),
        start: 0.0,
        start_seg: 0,
        frontier: Arc::new(AtomicU32::new(0)),
        cancel: cancel.clone(),
        done: done.clone(),
        eof: Arc::new(AtomicBool::new(false)),
        error: error.clone(),
    };
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        let _done = DoneOnDrop(done.clone());
        let result = run_audio_encode(&path, &dir.join("audio.m4a"), &cancel, lossless);
        if let Err(e) = result {
            let _ = std::fs::remove_file(dir.join("audio.m4a"));
            *error.lock().unwrap() = Some(e);
        }
        done.store(true, Ordering::Release);
    });
    job
}

fn run_audio_encode(path: &Path, out: &Path, cancel: &AtomicBool, lossless: bool) -> Result<(), String> {
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let out_s = out.to_string_lossy().into_owned();
    let mut opts = vec![("o", out_s.as_str()), ("of", "ipod"), ("ofopts", "movflags=+faststart"), ("vid", "no"), ("sid", "no"), ("keep-open", "no")];
    if lossless {
        // Same samples, same rate and bit depth: only the container and codec change.
        opts.push(("oac", "alac"));
    } else {
        opts.extend([("oac", "aac"), ("oacopts", "b=256k"), ("audio-samplerate", "48000")]);
    }
    let core = Core::new(&opts)?;
    let file = path.to_string_lossy().into_owned();
    core.api.command(core.h, &["loadfile", &file, "replace"])?;
    let deadline = Instant::now() + AUDIO_ENCODE_WAIT;
    let mut ok = false;
    while Instant::now() < deadline {
        if cancel.load(Ordering::Acquire) {
            let _ = core.api.command(core.h, &["stop"]);
            break;
        }
        let ev = unsafe { &*(core.api.wait_event)(core.h, 0.1) };
        if ev.event_id == mpv::EVENT_END_FILE {
            ok = ev.data.is_null() || unsafe { &*(ev.data as *const mpv::EventEndFile) }.reason != mpv::END_FILE_REASON_ERROR;
            break;
        }
        if ev.event_id == mpv::EVENT_SHUTDOWN {
            break;
        }
    }
    drop(core); // finishes the MP4 (moves the index to the front)
    let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    if ok && size > 0 {
        Ok(())
    } else {
        Err("The song couldn’t be converted".into())
    }
}

#[allow(clippy::too_many_arguments)]
fn run_encode(
    path: PathBuf,
    opts: StreamOptions,
    output: Output,
    start: f64,
    dir: PathBuf,
    prev_done: Option<Arc<AtomicBool>>,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    eof: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
) {
    // Created here so callers holding the server lock don't touch the disk.
    if let Err(e) = std::fs::create_dir_all(&dir) {
        *error.lock().unwrap() = Some(e.to_string());
        done.store(true, Ordering::Release);
        return;
    }
    // The conversion this one replaces (after a seek) shares the folder: wait for it to stop. If it
    // hangs, carry on, but leave its temporary files alone (deleting them broke its last segments).
    let mut prev_running = false;
    if let Some(prev) = prev_done {
        let wait = Instant::now();
        while !prev.load(Ordering::Acquire) && wait.elapsed() < Duration::from_secs(30) {
            if cancel.load(Ordering::Acquire) {
                done.store(true, Ordering::Release);
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        prev_running = !prev.load(Ordering::Acquire);
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
    let mut attempts = Vec::new();
    if opts.tone_map {
        if cfg!(target_os = "macos") && !GPU_FILTER_BROKEN.load(Ordering::Relaxed) {
            attempts.push(Convert::Gpu);
        }
        if !FILTER_TONEMAP_BROKEN.load(Ordering::Relaxed) {
            attempts.push(Convert::Filters);
        }
    }
    attempts.push(Convert::Plain);
    // Each conversion keeps its own playlist: one that's being replaced can't remove or confuse
    // the new one's.
    let m3u8 = dir.join(format!("seg-{}.m3u8", &random_token()[..8]));
    let live_ts = dir.join("live.ts");
    let mp4_part = dir.join(MP4_PART);
    let mp4_ready = dir.join(MP4_READY);
    let hls = match &output {
        Output::Hls(plan, start_seg, frontier) => Some((plan.clone(), *start_seg, frontier.clone())),
        _ => None,
    };
    let mp4_progress = match &output {
        Output::Mp4(p) => Some(p.clone()),
        _ => None,
    };

    for (attempt_idx, &mode) in attempts.iter().enumerate() {
        let use_gpu = mode == Convert::Gpu;
        let retry = |broken: &AtomicBool| {
            if attempt_idx + 1 < attempts.len() && mode != Convert::Plain {
                broken.store(true, Ordering::Relaxed);
                true
            } else {
                false
            }
        };
        let broken = if use_gpu { &GPU_FILTER_BROKEN } else { &FILTER_TONEMAP_BROKEN };
        let _ = std::fs::remove_file(&m3u8);
        match output {
            Output::Hls(..) => {}
            Output::Ts => {
                let _ = std::fs::remove_file(&live_ts);
            }
            Output::Mp4(_) => {
                let _ = std::fs::remove_file(&mp4_part);
                let _ = std::fs::remove_file(&mp4_ready);
            }
        }
        if !prev_running {
            remove_tmp_files(&dir);
        }

        let gop = match &output {
            Output::Hls(plan, _, _) => plan.gop,
            Output::Ts => 48,
            Output::Mp4(_) => 96,
        };
        let mut ovcopts = ovcopts_for(enc, gop, opts.bitrate, opts.maxrate);
        if ENCODER_FAST.load(Ordering::Relaxed) {
            ovcopts.push_str(speed_opts(enc));
        }
        let out = match output {
            Output::Hls(..) => &m3u8,
            Output::Ts => &live_ts,
            Output::Mp4(_) => &mp4_part,
        }
        .to_string_lossy()
        .into_owned();
        let length = format!("{:.3}", opts.length);
        let start_s = if hls.is_some() { format!("{:.6}", start.max(0.0)) } else { format!("{:.3}", start.max(0.0)) };
        let (w, h) = (opts.width.max(2) & !1, opts.height.max(2) & !1);
        let vf = video_filter(mode, if opts.width > 0 { w } else { 0 }, h);

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
            // Pixel-format conversions (10-bit to 8-bit and the like) take the quick path.
            ("sws-fast", "yes"),
            ("keep-open", "no"),
        ];
        if sid != "no" {
            options.push(("sub-auto", "fuzzy"));
            for (k, v) in opts.sub_style.iter().filter(|(k, v)| sub_style_allowed(k, v)) {
                options.push((k.as_str(), v.as_str()));
            }
        }
        if let Some(ref of_str) = ofopts {
            options.push(("orawts", "yes"));
            options.push(("of", "hls"));
            options.push(("ofopts", of_str));
        } else if mp4_progress.is_some() {
            // The index goes to the front once the file is complete, so it plays while it loads.
            options.push(("of", "mp4"));
            options.push(("ofopts", "movflags=+faststart"));
        } else {
            options.push(("of", "mpegts"));
        }
        if opts.length > 0.0 {
            options.push(("length", &length));
        }
        if use_gpu {
            options.extend([("target-prim", "bt.709"), ("target-trc", "bt.1886"), ("tone-mapping", "bt.2390")]);
        }

        let core = match Core::new(&options) {
            Ok(c) => c,
            Err(e) => {
                if retry(broken) {
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
            if let Some(ref progress) = mp4_progress {
                if last_scan.elapsed() >= Duration::from_millis(500) {
                    last_scan = Instant::now();
                    let pos = core.get("time-pos").and_then(|v| v.parse::<f64>().ok());
                    let total = if opts.length > 0.0 { Some(opts.length) } else { core.get("duration").and_then(|v| v.parse::<f64>().ok()) };
                    if let (Some(pos), Some(total)) = (pos, total.filter(|t| *t > 0.0)) {
                        progress.store(((pos / total).clamp(0.0, 0.999) * 1000.0) as u32, Ordering::Release);
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
                // Temporary files are left for the next conversion (which may already be writing its own).
            } else if mp4_progress.is_some() {
                let _ = std::fs::remove_file(&mp4_part);
            } else {
                let _ = std::fs::remove_dir_all(&dir);
            }
            break;
        }

        if (end_err || !video_ok) && retry(broken) {
            for bad in all_playlist_segs(&m3u8) {
                let _ = std::fs::remove_file(dir.join(format!("seg{bad}.ts")));
            }
            let _ = std::fs::remove_file(&mp4_part);
            let _ = std::fs::remove_file(&m3u8);
            remove_tmp_files(&dir);
            continue;
        }

        if end_err || !video_ok {
            for bad in all_playlist_segs(&m3u8) {
                let _ = std::fs::remove_file(dir.join(format!("seg{bad}.ts")));
            }
            let _ = std::fs::remove_file(&mp4_part);
            *error.lock().unwrap() = Some("The video couldn’t be converted".into());
        } else if let Some(ref progress) = mp4_progress {
            // Only a file converted to the end is offered for download.
            let renamed = reached_eof && std::fs::rename(&mp4_part, &mp4_ready).is_ok();
            if renamed {
                progress.store(1000, Ordering::Release);
                eof.store(true, Ordering::Release);
            } else {
                let _ = std::fs::remove_file(&mp4_part);
                *error.lock().unwrap() = Some("The video couldn’t be converted".into());
            }
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
    let options = sanitize_options(options)?;
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
    let hls_seg = |plan: &HlsPlan| ((start.max(0.0) / plan.seg_len).floor() as u32).min(plan.seg_count.saturating_sub(1));
    let seg_file = {
        let inner = s.inner.lock().unwrap();
        let st = inner.streams.get(&token).ok_or("Unknown stream")?;
        st.hls.as_ref().map(|plan| st.dir.join(format!("seg{}.ts", hls_seg(plan))))
    };
    let cached = match seg_file {
        Some(f) => tokio::fs::try_exists(f).await.unwrap_or(false),
        None => false,
    };
    let (rel, offset) = {
        let mut inner = s.inner.lock().unwrap();
        let st = inner.streams.get_mut(&token).ok_or("Unknown stream")?;
        st.touched = Instant::now();
        match st.opts.format.as_str() {
            "direct" => (format!("/stream/{token}/file"), 0.0),
            "hls" => {
                let plan = st.hls.clone().ok_or("Missing HLS plan")?;
                let seg = hls_seg(&plan);
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
            "aac" | "alac" => {
                // One conversion per stream: the finished file serves every seek.
                let reuse = st.job.as_ref().is_some_and(|j| j.error.lock().unwrap().is_none() && !j.cancel.load(Ordering::Acquire));
                if !reuse {
                    if let Some(old) = st.job.take() {
                        old.stop();
                    }
                    st.job = Some(spawn_audio_job(&st.path, &st.dir, st.opts.format == "alac"));
                }
                let job = st.job.as_ref().unwrap();
                (format!("/stream/{token}/{}/audio.m4a", job.id), 0.0)
            }
            "mp4" => {
                // One conversion per download; a failed one starts over when asked again.
                let keep = st.job.as_ref().is_some_and(|j| j.error.lock().unwrap().is_none() && !j.cancel.load(Ordering::Acquire));
                if !keep {
                    let prev = st.job.take().map(|old| {
                        old.stop();
                        old.done
                    });
                    st.job = Some(spawn_mp4_job(&st.path, &st.opts, &st.dir, prev)?);
                }
                (format!("/stream/{token}/{MP4_READY}"), 0.0)
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

#[derive(Serialize, Debug, PartialEq)]
pub struct DownloadStatus {
    /// "converting" | "ready" | "failed"
    state: &'static str,
    /// 0–1.
    progress: f64,
    /// Bytes of the finished MP4 (0 until ready).
    size: u64,
    error: Option<String>,
}

fn download_status(job: Option<&Job>, ready_file: &Path) -> DownloadStatus {
    let Some(job) = job else {
        return DownloadStatus { state: "failed", progress: 0.0, size: 0, error: Some("The conversion hasn’t started".into()) };
    };
    if let Some(e) = job.error.lock().unwrap().clone() {
        return DownloadStatus { state: "failed", progress: 0.0, size: 0, error: Some(e) };
    }
    if job.finished_ok() {
        let size = std::fs::metadata(ready_file).map(|m| m.len()).unwrap_or(0);
        return DownloadStatus { state: "ready", progress: 1.0, size, error: None };
    }
    if job.cancel.load(Ordering::Acquire) || job.done.load(Ordering::Acquire) {
        return DownloadStatus { state: "failed", progress: 0.0, size: 0, error: Some("The conversion stopped".into()) };
    }
    let progress = f64::from(job.frontier.load(Ordering::Acquire).min(999)) / 1000.0;
    DownloadStatus { state: "converting", progress, size: 0, error: None }
}

/// How far a download's MP4 conversion has got.
#[tauri::command]
pub fn stream_download_status(token: String) -> Result<DownloadStatus, String> {
    let s = shared()?;
    let mut inner = s.inner.lock().unwrap();
    let st = inner.streams.get_mut(&token).ok_or("Unknown stream")?;
    if st.opts.format != "mp4" {
        return Err("Not a download".into());
    }
    st.touched = Instant::now();
    Ok(download_status(st.job.as_ref(), &st.dir.join(MP4_READY)))
}

/// Keeps a stream from expiring while it's in use but quiet: a paused TV or browser asks for nothing,
/// and was cut off after 15 minutes (resuming then failed). False when the stream is already gone.
#[tauri::command]
pub fn stream_touch(token: String) -> bool {
    let Ok(s) = shared() else { return false };
    let mut inner = s.inner.lock().unwrap();
    match inner.streams.get_mut(&token) {
        Some(st) => {
            st.touched = Instant::now();
            true
        }
        None => false,
    }
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
    /// Sign-in paused after too many wrong codes (until a new code is made).
    login_paused: bool,
}

/// Turns the browser app on/off (with its access code and port).
#[tauri::command]
pub async fn remote_access_set(enabled: bool, code: String, port: u16) -> Result<ServerInfo, String> {
    let s = shared()?;
    let bound = if enabled { ensure_server(port).await? } else { s.inner.lock().unwrap().port };
    let (ended, paused) = {
        let mut inner = s.inner.lock().unwrap();
        let mut ended = Vec::new();
        if inner.access_code != code || !enabled {
            // A new code (or turning access off) signs everyone out and clears wrong-code lockouts.
            ended = inner.end_sessions(|_| false);
            inner.login.reset();
        }
        inner.web_enabled = enabled;
        inner.access_code = code;
        (ended, inner.login.paused())
    };
    announce_ended(&s.app, ended);
    let encoder = ENCODER.lock().unwrap().map(str::to_owned);
    Ok(ServerInfo { port: bound, addresses: lan_addresses(), web_enabled: enabled, encoder, login_paused: paused })
}

#[tauri::command]
pub fn server_info() -> ServerInfo {
    let (port, web, paused) = shared()
        .map(|s| {
            let i = s.inner.lock().unwrap();
            (i.port, i.web_enabled, i.login.paused())
        })
        .unwrap_or((0, false, false));
    let encoder = ENCODER.lock().unwrap().map(str::to_owned);
    ServerInfo { port, addresses: lan_addresses(), web_enabled: web, encoder, login_paused: paused }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    id: String,
    device: String,
    ip: String,
    signed_in_ms: u64,
    last_seen_ms: u64,
}

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Browsers signed in with the access code, most recently used first.
#[tauri::command]
pub fn remote_sessions() -> Vec<RemoteSessionInfo> {
    let Ok(s) = shared() else { return Vec::new() };
    let now = SystemTime::now();
    let (mut list, ended) = {
        let mut inner = s.inner.lock().unwrap();
        let ended = inner.end_sessions(|w| !w.expired(now));
        let list: Vec<_> = inner
            .web_sessions
            .values()
            .map(|w| RemoteSessionInfo {
                id: w.id.clone(),
                device: w.device.clone(),
                ip: w.ip.to_string(),
                signed_in_ms: epoch_ms(w.created),
                last_seen_ms: epoch_ms(w.last_used),
            })
            .collect();
        (list, ended)
    };
    announce_ended(&s.app, ended);
    list.sort_by(|a, b| b.last_seen_ms.cmp(&a.last_seen_ms));
    list
}

/// Signs one browser out (or every browser when `id` is None).
#[tauri::command]
pub fn remote_session_revoke(id: Option<String>) {
    let Ok(s) = shared() else { return };
    let ended = s.inner.lock().unwrap().end_sessions(|w| id.as_ref().is_some_and(|i| &w.id != i));
    announce_ended(&s.app, ended);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `TRUONGFLIX_LIBMPV=…/libmpv-2.dll cargo test --lib -- --ignored real_audio_transcode`
    #[test]
    #[ignore]
    fn real_audio_transcode() {
        use lofty::file::AudioFile;
        let root = std::env::temp_dir().join(format!("truongflix-audio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // An ALAC song (what Chrome and Edge can't play), made by libmpv itself.
        let alac = root.join("song.m4a");
        {
            let out = alac.to_string_lossy().into_owned();
            let core = Core::new(&[("o", out.as_str()), ("of", "ipod"), ("oac", "alac"), ("vid", "no"), ("keep-open", "no")]).unwrap();
            core.api.command(core.h, &["loadfile", "av://lavfi:sine=frequency=440:duration=4", "replace"]).unwrap();
            assert!(core.wait_for(&[mpv::EVENT_END_FILE], Duration::from_secs(20)).is_some());
        }
        let mut f = std::fs::File::open(&alac).unwrap();
        let src = lofty::mp4::Mp4File::read_from(&mut f, lofty::config::ParseOptions::new()).unwrap();
        assert_eq!(src.properties().codec(), Some(lofty::mp4::Mp4Codec::ALAC));

        let out = root.join("job/audio.m4a");
        run_audio_encode(&alac, &out, &AtomicBool::new(false), false).expect("converted");
        let mut f = std::fs::File::open(&out).unwrap();
        let aac = lofty::mp4::Mp4File::read_from(&mut f, lofty::config::ParseOptions::new()).unwrap();
        assert_eq!(aac.properties().codec(), Some(lofty::mp4::Mp4Codec::AAC));
        let secs = aac.properties().duration().as_secs_f64();
        assert!((secs - 4.0).abs() < 0.3, "duration {secs}");

        // Lossless for Safari: ALAC in an indexed MP4, same length.
        let out = root.join("lossless/audio.m4a");
        run_audio_encode(&alac, &out, &AtomicBool::new(false), true).expect("converted losslessly");
        let mut f = std::fs::File::open(&out).unwrap();
        let lossless = lofty::mp4::Mp4File::read_from(&mut f, lofty::config::ParseOptions::new()).unwrap();
        assert_eq!(lossless.properties().codec(), Some(lofty::mp4::Mp4Codec::ALAC));
        let secs = lossless.properties().duration().as_secs_f64();
        assert!((secs - 4.0).abs() < 0.3, "duration {secs}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// `TRUONGFLIX_STREAM_TEST=video.mkv cargo test -- --ignored real_stream --nocapture`
    #[test]
    #[ignore]
    fn real_stream_jobs_and_ranges() {
        let video = PathBuf::from(std::env::var("TRUONGFLIX_STREAM_TEST").expect("set TRUONGFLIX_STREAM_TEST"));
        let root = std::env::temp_dir().join("truongflix-stream-test");
        let _ = std::fs::remove_dir_all(&root);

        let enc = pick_encoder().expect("a working H.264 encoder");
        println!("Selected encoder: {enc}");
        assert!(!test_encoder("definitely_no_such_encoder_123", ""));

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
                ..Default::default()
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
        let ts_opts = StreamOptions { format: "ts".into(), width: 1280, height: 720, tone_map: false, aid: None, sid: None, sub_style: Vec::new(), ..Default::default() };
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

    /// `TRUONGFLIX_HDR_TEST=<HDR10 video>`: tone-mapping must convert without falling back, and
    /// writes one frame per mode next to the system temp dir for a visual check.
    #[test]
    #[ignore]
    fn real_hdr_tone_map() {
        let video = PathBuf::from(std::env::var("TRUONGFLIX_HDR_TEST").expect("set TRUONGFLIX_HDR_TEST"));
        let out = std::env::temp_dir().join("truongflix-hdr-test");
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        let file = video.to_string_lossy().into_owned();
        for mode in [Convert::Filters, Convert::Plain] {
            let png = out.join(format!("{mode:?}.png")).to_string_lossy().into_owned();
            let vf = video_filter(mode, 960, 540);
            let core = Core::new(&[("o", &png), ("ovc", "png"), ("of", "image2"), ("frames", "1"), ("start", "600"), ("vf", &vf), ("aid", "no"), ("sid", "no")]).unwrap();
            core.api.command(core.h, &["loadfile", &file, "replace"]).unwrap();
            assert!(core.wait_for(&[mpv::EVENT_END_FILE], Duration::from_secs(60)).is_some(), "{mode:?} did not finish");
            drop(core);
            let size = std::fs::metadata(&png).map(|m| m.len()).unwrap_or(0);
            println!("{mode:?}: {png} ({size} bytes)");
            assert!(size > 10_000, "{mode:?} wrote no frame");
        }

        let plan = HlsPlan::from_probe(probe_file(&video).unwrap().duration, 24.0);
        let opts = StreamOptions { format: "hls".into(), width: 1280, height: 720, tone_map: true, aid: None, sid: None, sub_style: Vec::new(), ..Default::default() };
        let dir = out.join("hls");
        let job = spawn_hls_job(&video, &opts, &plan, 100, &dir, None).unwrap();
        let first = dir.join("seg100.ts");
        let t = Instant::now();
        while !first.exists() && !job.done.load(Ordering::Acquire) && t.elapsed() < Duration::from_secs(90) {
            std::thread::sleep(Duration::from_millis(100));
        }
        job.stop();
        assert!(job.error.lock().unwrap().is_none(), "{:?}", job.error.lock().unwrap());
        assert!(first.exists(), "no tone-mapped segment");
        assert!(!FILTER_TONEMAP_BROKEN.load(Ordering::Relaxed), "the zscale/tonemap filters were not available");
    }

    /// `TRUONGFLIX_STREAM_TEST=video.mkv cargo test -- --ignored real_download_mp4 --nocapture`:
    /// converts the first 20 seconds to a download MP4 and checks its index is at the front.
    #[test]
    #[ignore]
    fn real_download_mp4() {
        let video = PathBuf::from(std::env::var("TRUONGFLIX_STREAM_TEST").expect("set TRUONGFLIX_STREAM_TEST"));
        let opts = StreamOptions { format: "mp4".into(), width: 1280, height: 720, bitrate: 3000, maxrate: 4500, length: 20.0, ..Default::default() };
        check_download_mp4(&video, &opts, "sdr");
        // `TRUONGFLIX_HDR_TEST=<HDR video>` also: a tone-mapped 4K download.
        if let Ok(hdr) = std::env::var("TRUONGFLIX_HDR_TEST") {
            let opts = StreamOptions { format: "mp4".into(), width: 3840, height: 2160, tone_map: true, bitrate: 35000, maxrate: 52500, length: 6.0, ..Default::default() };
            check_download_mp4(Path::new(&hdr), &opts, "hdr");
        }
    }

    fn check_download_mp4(video: &Path, opts: &StreamOptions, name: &str) {
        let dir = std::env::temp_dir().join(format!("truongflix-download-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        let video = video.to_path_buf();
        let t = Instant::now();
        let job = spawn_mp4_job(&video, opts, &dir, None).unwrap();
        let mut last = 0;
        while !job.done.load(Ordering::Acquire) && t.elapsed() < Duration::from_secs(180) {
            let p = job.frontier.load(Ordering::Acquire);
            assert!(p >= last, "progress went backwards");
            last = p;
            std::thread::sleep(Duration::from_millis(100));
        }
        let status = download_status(Some(&job), &dir.join(MP4_READY));
        assert_eq!(status.state, "ready", "{status:?}");
        assert!(!dir.join(MP4_PART).exists());
        let data = std::fs::read(dir.join(MP4_READY)).unwrap();
        assert_eq!(status.size, data.len() as u64);
        // Top-level boxes: ftyp first, moov before mdat (faststart).
        let mut boxes = Vec::new();
        let mut at = 0usize;
        while at + 8 <= data.len() {
            let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
            boxes.push(String::from_utf8_lossy(&data[at + 4..at + 8]).into_owned());
            if size < 8 {
                break;
            }
            at += size;
        }
        if opts.tone_map {
            assert!(!FILTER_TONEMAP_BROKEN.load(Ordering::Relaxed), "fell back to a copy without tone-mapping");
        }
        let kbps = data.len() as f64 * 8.0 / 1000.0 / opts.length;
        println!("{name}: {} bytes ({kbps:.0} kbit/s) in {:?}: {boxes:?}", data.len(), t.elapsed());
        assert_eq!(boxes.first().map(String::as_str), Some("ftyp"));
        let moov = boxes.iter().position(|b| b == "moov").expect("moov box");
        let mdat = boxes.iter().position(|b| b == "mdat").expect("mdat box");
        assert!(moov < mdat, "index is not at the front: {boxes:?}");
        // At most the peak video rate plus audio, with headroom for the container.
        assert!(data.len() > 50_000 && kbps < (opts.maxrate + 192) as f64 * 1.3, "unexpected size {}", data.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn filters_shrink_before_tone_mapping() {
        assert_eq!(video_filter(Convert::Plain, 1280, 720), "scale=1280:720:flags=bilinear,format=yuv420p");
        assert_eq!(video_filter(Convert::Plain, 0, 0), "format=yuv420p");
        let hdr = video_filter(Convert::Filters, 1920, 1080);
        assert!(hdr.starts_with("lavfi=[zscale=w=1920:h=1080:f=bilinear:t=linear:npl=100,format=gbrpf32le"), "{hdr}");
        assert!(hdr.ends_with("zscale=t=bt709:m=bt709:r=tv,format=yuv420p]"), "{hdr}");
        assert!(video_filter(Convert::Filters, 0, 0).starts_with("lavfi=[zscale=t=linear:npl=100,"));
        assert_eq!(speed_opts("h264_nvenc"), ",preset=p2");
        assert_eq!(speed_opts("libx264"), "");
    }

    #[test]
    fn bitrate_caps_every_encoder() {
        // No bitrate: the defaults casting has always used.
        assert_eq!(ovcopts_for("libx264", 96, 0, 0), "preset=veryfast,crf=21,g=96,keyint_min=96,sc_threshold=0,profile=high");
        assert_eq!(ovcopts_for("h264_nvenc", 96, 0, 0), "b=6M,maxrate=10M,g=96");
        // x264 keeps constant quality, capped at the peak.
        assert_eq!(
            ovcopts_for("libx264", 96, 4000, 6000),
            "preset=veryfast,crf=21,g=96,keyint_min=96,sc_threshold=0,profile=high,maxrate=6000k,bufsize=12000k"
        );
        for hw in ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "h264_videotoolbox", "h264_vaapi"] {
            assert_eq!(ovcopts_for(hw, 48, 35000, 52500), "b=35000k,maxrate=52500k,bufsize=105000k,g=48");
        }
        // A missing or too-low peak becomes 1.5 × the target.
        assert_eq!(ovcopts_for("h264_mf", 48, 800, 0), "b=800k,maxrate=1200k,bufsize=2400k,g=48");
        assert_eq!(ovcopts_for("h264_mf", 48, 2000, 10), "b=2000k,maxrate=2000k,bufsize=4000k,g=48");
    }

    #[test]
    fn stream_options_are_checked() {
        // Callers from before bitrates existed still deserialize.
        let old: StreamOptions = serde_json::from_str(r#"{"format":"hls","width":1920,"height":1080,"tone_map":false,"aid":null,"sid":null,"sub_style":[]}"#).unwrap();
        assert_eq!((old.bitrate, old.maxrate), (0, 0));
        let new: StreamOptions = serde_json::from_str(r#"{"format":"mp4","width":3840,"height":2160,"bitrate":35000,"maxrate":52500,"length":5}"#).unwrap();
        assert_eq!((new.bitrate, new.maxrate, new.length), (35000, 52500, 0.0));
        assert!(sanitize_options(StreamOptions { format: "exe".into(), ..Default::default() }).is_err());
        let wild = sanitize_options(StreamOptions { format: "mp4".into(), width: 99_999, height: 99_999, bitrate: u32::MAX, maxrate: u32::MAX, length: 3.0, ..Default::default() }).unwrap();
        assert_eq!((wild.width, wild.height, wild.bitrate, wild.maxrate, wild.length), (MAX_WIDTH, MAX_HEIGHT, MAX_BITRATE_KBPS, MAX_BITRATE_KBPS * 2, 0.0));
    }

    #[test]
    fn download_status_reports_each_stage() {
        let job = || Job {
            id: "j".into(),
            dir: PathBuf::new(),
            start: 0.0,
            start_seg: 0,
            frontier: Arc::new(AtomicU32::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
            done: Arc::new(AtomicBool::new(false)),
            eof: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
        };
        let none = Path::new("no-such-file.mp4");
        assert_eq!(download_status(None, none).state, "failed");
        let j = job();
        j.frontier.store(1000, Ordering::Release);
        assert_eq!(download_status(Some(&j), none), DownloadStatus { state: "converting", progress: 0.999, size: 0, error: None });
        j.done.store(true, Ordering::Release);
        assert_eq!(download_status(Some(&j), none).state, "failed", "ended without reaching the end");
        j.eof.store(true, Ordering::Release);
        assert_eq!(download_status(Some(&j), none).state, "ready");
        *j.error.lock().unwrap() = Some("boom".into());
        assert_eq!(download_status(Some(&j), none).error.as_deref(), Some("boom"));
        let c = job();
        c.stop();
        assert_eq!(download_status(Some(&c), none).state, "failed");
    }

    #[test]
    fn malformed_escapes_never_panic() {
        // Used to slice through a multi-byte character and abort the app.
        assert_eq!(percent_decode_with("/%€", false), "/%€");
        assert_eq!(percent_decode_with("/%E2%82", false), "/\u{FFFD}");
        assert_eq!(percent_decode("%4"), "%4");
        assert_eq!(percent_decode("%41"), "A");
        assert_eq!(percent_decode_with("/a+b", false), "/a+b");
        assert_eq!(percent_decode("%zz%"), "%zz%");
    }

    #[test]
    fn subtitle_styles_are_allowlisted() {
        let style = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let ok = style(&[
            ("sub-font-size", "46"),
            ("sub-color", "#FFE600"),
            ("sub-font", "Segoe UI Semibold"),
            ("sub-border-style", "opaque-box"),
            ("sub-outline-size", "1.2"),
            ("sub-back-color", "#80000000"),
            ("sub-shadow-offset", "0"),
        ]);
        assert_eq!(sanitize_sub_style(ok.clone()), ok);
        let bad = style(&[
            ("o", "C:/Windows/evil.ts"),
            ("vf", "lavfi=[movie=x]"),
            ("sub-font-size", "46,o=x"),
            ("sub-color", "red\nx"),
            ("sub-font", "../../etc"),
            ("sub-file", "x.srt"),
            ("script-opts", "a=b"),
            ("sub-font-size", "NaN"),
        ]);
        assert!(sanitize_sub_style(bad).is_empty());
    }

    #[test]
    fn only_the_browser_app_is_served() {
        assert_eq!(app_asset_path("/").as_deref(), Some("remote.html"));
        assert_eq!(app_asset_path("/library").as_deref(), Some("remote.html"));
        assert_eq!(app_asset_path("/assets/remote-abc.js").as_deref(), Some("assets/remote-abc.js"));
        assert_eq!(app_asset_path("/favicon.png").as_deref(), Some("favicon.png"));
        assert_eq!(app_asset_path("/index.html"), None);
        assert_eq!(app_asset_path("/assets/../index.html"), None);
        assert_eq!(app_asset_path("/assets//x.js"), None);
        assert_eq!(app_asset_path("/src/main.tsx"), None);
    }

    #[test]
    fn vod_playlist_and_query_strings() {
        assert_eq!(percent_decode("a%20b+c%2Fd"), "a b c/d");
        assert_eq!(percent_decode("%E2%9C%93"), "✓");
        assert!(local_ip_for("127.0.0.1").is_some());
        assert_eq!(random_token().len(), 32);

        let plan = HlsPlan::from_probe(1441.5, 24000.0 / 1001.0);
        assert_eq!(plan.gop, 48);
        assert!((plan.seg_len - 2.002).abs() < 1e-6);
        assert_eq!(plan.seg_count, 720);
        let m3u8 = plan.playlist();
        assert!(m3u8.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(m3u8.contains("#EXT-X-ENDLIST"));
        assert!(m3u8.contains("seg0.ts") && m3u8.contains("seg719.ts") && !m3u8.contains("seg720.ts"));
        let sum: f64 = m3u8
            .lines()
            .filter_map(|l| l.strip_prefix("#EXTINF:")?.strip_suffix(',')?.parse::<f64>().ok())
            .sum();
        assert!((sum - 1441.5).abs() < 0.01, "sum={sum}");
    }
}
