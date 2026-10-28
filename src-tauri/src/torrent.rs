//! Built-in BitTorrent engine powered by `librqbit` (`stream` & `download` modes, sequential HTTP
//! byte-range streaming for `libmpv` / VLC / Cast, live rate limits, magnet & `.torrent` inspection,
//! and OS handler registration for `magnet:` + `.torrent`).

use librqbit::api::TorrentIdOrHash;
use librqbit::dht::{DhtPersistenceConfig, Id20};
use librqbit::limits::LimitsConfig;
use librqbit::{
    torrent_from_bytes, AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig,
    ListenerMode, ListenerOptions, Magnet, ManagedTorrent, Session, SessionOptions,
    SessionPersistenceConfig, TorrentStatsState,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const SAMPLE_KEYWORDS: &[&str] = &["sample", "trailer", "featurette"];
const SAMPLE_MAX_BYTES: u64 = 60 * 1024 * 1024;

fn default_true() -> bool {
    true
}

fn default_peer_limit() -> usize {
    128
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TorrentEngineConfig {
    /// Listening TCP/uTP port (`0` = OS-assigned port).
    #[serde(default)]
    pub listen_port: u16,
    #[serde(default = "default_true")]
    pub enable_upnp: bool,
    #[serde(default = "default_true")]
    pub enable_dht: bool,
    #[serde(default = "default_true")]
    pub enable_lsd: bool,
    #[serde(default)]
    pub disable_trackers: bool,
    /// Download rate cap in KiB/s (`0` = unlimited).
    #[serde(default)]
    pub max_download_kbps: u32,
    /// Upload rate cap in KiB/s (`0` = unlimited).
    #[serde(default)]
    pub max_upload_kbps: u32,
    /// Max peers per torrent (`0` = default 128).
    #[serde(default = "default_peer_limit")]
    pub peer_limit: usize,
    /// Optional custom folder for temporary sequential streams.
    #[serde(default)]
    pub stream_cache_dir: Option<String>,
}

impl Default for TorrentEngineConfig {
    fn default() -> Self {
        Self {
            listen_port: 0,
            enable_upnp: true,
            enable_dht: true,
            enable_lsd: true,
            disable_trackers: false,
            max_download_kbps: 0,
            max_upload_kbps: 0,
            peer_limit: 128,
            stream_cache_dir: None,
        }
    }
}

impl TorrentEngineConfig {
    fn requires_session_restart(&self, other: &Self) -> bool {
        self.listen_port != other.listen_port
            || self.enable_upnp != other.enable_upnp
            || self.enable_dht != other.enable_dht
            || self.enable_lsd != other.enable_lsd
            || self.disable_trackers != other.disable_trackers
            || self.peer_limit != other.peer_limit
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectedFile {
    pub index: usize,
    pub name: String,
    pub relative_path: String,
    pub size: u64,
    pub is_video: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectTorrentRes {
    pub info_hash: String,
    pub name: String,
    pub total_bytes: u64,
    pub is_magnet: bool,
    pub metadata_ready: bool,
    pub files: Vec<InspectedFile>,
    pub trackers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AddTorrentReq {
    pub source: String,
    pub is_stream: bool,
    pub output_folder: Option<String>,
    pub sub_folder: Option<String>,
    pub only_files: Option<Vec<usize>>,
    #[serde(default)]
    pub paused: bool,
    pub initial_peers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentFileStatus {
    pub index: usize,
    pub name: String,
    pub relative_path: String,
    pub full_path: String,
    pub size: u64,
    pub downloaded_bytes: u64,
    pub included: bool,
    pub is_video: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentStatus {
    pub info_hash: String,
    pub name: String,
    /// `"resolving" | "initializing" | "downloading" | "seeding" | "paused" | "completed" | "error"`
    pub state: String,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub uploaded_bytes: u64,
    pub progress_pct: f64,
    pub download_speed_bps: u64,
    pub upload_speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub peers_live: u32,
    pub peers_connecting: u32,
    pub peers_seen: u32,
    pub finished: bool,
    pub paused: bool,
    pub error: Option<String>,
    pub output_folder: String,
    pub listen_port: Option<u16>,
    pub files: Vec<TorrentFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsHandlerStatus {
    pub magnet_registered: bool,
    pub torrent_file_registered: bool,
    pub platform: String,
}

struct PendingMagnet {
    info_hash: String,
    name: String,
    output_folder: String,
    paused: bool,
    error: Option<String>,
    abort_handle: tokio::task::AbortHandle,
}

pub struct TorrentManager {
    app_data_dir: PathBuf,
    config: tokio::sync::RwLock<TorrentEngineConfig>,
    session: tokio::sync::Mutex<Option<Arc<Session>>>,
    cached_torrent_bytes: Mutex<HashMap<String, Vec<u8>>>,
    pending_magnets: Mutex<HashMap<String, PendingMagnet>>,
    stream_server: tokio::sync::OnceCell<(u16, String)>,
}

static MANAGER: OnceLock<Arc<TorrentManager>> = OnceLock::new();
static PENDING_OPEN_LINKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn global_manager(app: &AppHandle) -> Result<Arc<TorrentManager>, String> {
    if let Some(m) = MANAGER.get() {
        return Ok(m.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let mgr = TorrentManager::new(app_data);
    let _ = MANAGER.set(mgr.clone());
    Ok(MANAGER.get().cloned().unwrap_or(mgr))
}

fn kbps_to_bps(kbps: u32) -> Option<NonZeroU32> {
    if kbps == 0 {
        None
    } else {
        NonZeroU32::new(kbps.saturating_mul(1024))
    }
}

fn is_video_candidate(rel_path: &Path, size: u64) -> bool {
    let Some(fname) = rel_path.file_name().map(|n| n.to_string_lossy()) else {
        return false;
    };
    if fname.starts_with("._") {
        return false;
    }
    if !crate::scanner::has_video_extension(rel_path) {
        return false;
    }
    let lower = fname.to_ascii_lowercase();
    !(size < SAMPLE_MAX_BYTES && SAMPLE_KEYWORDS.iter().any(|k| lower.contains(k)))
}

pub fn sanitize_folder_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches('.').trim();
    if trimmed.is_empty() {
        "Torrent".to_string()
    } else {
        trimmed.to_string()
    }
}

fn decode_percent(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for b in clean {
        if b == b'=' {
            break;
        }
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return Err("Invalid base64 character in torrent data".into()),
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

fn normalize_file_url_or_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.to_ascii_lowercase().starts_with("magnet:") {
        return Some(trimmed.to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        let decoded = decode_percent(rest);
        #[cfg(windows)]
        let path_str = decoded
            .strip_prefix('/')
            .filter(|s| s.as_bytes().get(1) == Some(&b':'))
            .unwrap_or(&decoded)
            .replace('/', "\\");
        #[cfg(not(windows))]
        let path_str = decoded;
        if path_str.to_ascii_lowercase().ends_with(".torrent") {
            return Some(path_str);
        }
        return None;
    }
    if trimmed.to_ascii_lowercase().ends_with(".torrent") && Path::new(trimmed).exists() {
        return Some(trimmed.to_string());
    }
    None
}

fn push_open_link(app: &AppHandle, link: String) {
    {
        let mut q = PENDING_OPEN_LINKS.lock().unwrap();
        if !q.contains(&link) {
            q.push(link.clone());
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("torrent-open-link", link);
}

/// Captures `magnet:` URIs and `.torrent` file paths passed at cold start.
pub fn capture_startup_args(app: &AppHandle, args: &[String]) {
    for arg in args.iter().skip(1) {
        if let Some(norm) = normalize_file_url_or_path(arg) {
            push_open_link(app, norm);
        }
    }
}

/// Handles macOS/iOS `RunEvent::Opened` URLs (e.g. double-clicking a `.torrent` file in Finder).
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn handle_opened_urls<'a, I: IntoIterator<Item = &'a str>>(app: &AppHandle, urls: I) {
    for raw in urls {
        if let Some(norm) = normalize_file_url_or_path(raw) {
            push_open_link(app, norm);
        }
    }
}

/// Handles secondary-instance `argv` forwarded by `tauri-plugin-single-instance`.
pub fn handle_cli_args(app: &AppHandle, argv: &[String]) {
    let mut matched = false;
    for arg in argv.iter().skip(1) {
        if let Some(norm) = normalize_file_url_or_path(arg) {
            push_open_link(app, norm);
            matched = true;
        }
    }
    if !matched {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn parse_torrent_bytes_meta(bytes: &[u8]) -> Result<InspectTorrentRes, String> {
    let parsed = torrent_from_bytes(bytes).map_err(|e| format!("Invalid .torrent file: {e:#}"))?;
    let info_hash = parsed.info_hash.as_string();
    let trackers = parsed
        .iter_announce()
        .filter_map(|t| std::str::from_utf8(t.as_ref()).ok().map(|s| s.to_owned()))
        .collect::<Vec<_>>();
    let validated = parsed
        .info
        .data
        .validate()
        .map_err(|e| format!("Invalid torrent info dictionary: {e:#}"))?;
    let name = validated
        .name()
        .map(|n| n.into_owned())
        .unwrap_or_else(|| format!("Torrent {}", &info_hash[..8]));

    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for (idx, fd) in validated.iter_file_details().enumerate() {
        let rel = fd.filename.to_pathbuf();
        let fname = rel
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("file_{idx}"));
        let rel_str = rel.to_string_lossy().into_owned();
        let len = fd.len;
        total_bytes = total_bytes.saturating_add(len);
        let is_video = is_video_candidate(&rel, len);
        files.push(InspectedFile {
            index: idx,
            name: fname,
            relative_path: rel_str,
            size: len,
            is_video,
        });
    }
    // If all video files were tiny (e.g., short clips under 60 MB named with sample/trailer),
    // fall back to extension check so valid short clips still register as video.
    if !files.iter().any(|f| f.is_video) {
        for f in &mut files {
            if crate::scanner::has_video_extension(Path::new(&f.relative_path)) {
                f.is_video = true;
            }
        }
    }

    Ok(InspectTorrentRes {
        info_hash,
        name,
        total_bytes,
        is_magnet: false,
        metadata_ready: true,
        files,
        trackers,
    })
}

fn random_hex_128() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}

fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;
    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        Some((start, total - 1))
    } else {
        let start: u64 = start_s.parse().ok()?;
        if start >= total {
            return None;
        }
        let end = if end_s.is_empty() {
            total - 1
        } else {
            end_s.parse::<u64>().ok()?.min(total - 1)
        };
        if start > end {
            None
        } else {
            Some((start, end))
        }
    }
}

impl TorrentManager {
    pub fn new(app_data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            app_data_dir,
            config: tokio::sync::RwLock::new(TorrentEngineConfig::default()),
            session: tokio::sync::Mutex::new(None),
            cached_torrent_bytes: Mutex::new(HashMap::new()),
            pending_magnets: Mutex::new(HashMap::new()),
            stream_server: tokio::sync::OnceCell::new(),
        })
    }

    pub async fn stream_cache_root(&self) -> PathBuf {
        let cfg = self.config.read().await;
        if let Some(custom) = cfg.stream_cache_dir.as_ref().filter(|s| !s.trim().is_empty()) {
            PathBuf::from(custom)
        } else {
            self.app_data_dir.join("stream-cache")
        }
    }

    pub async fn ensure_session(&self) -> Result<Arc<Session>, String> {
        let mut guard = self.session.lock().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }

        let cfg = self.config.read().await.clone();
        let default_dir = self.app_data_dir.join("downloads");
        let session_dir = self.app_data_dir.join("torrent-session");
        let dht_file = self.app_data_dir.join("torrent-dht").join("dht.json");
        let _ = std::fs::create_dir_all(&default_dir);
        let _ = std::fs::create_dir_all(&session_dir);
        if let Some(parent) = dht_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let dht = if cfg.enable_dht {
            Some(DhtSessionConfig {
                bootstrap_addrs: None,
                port: None,
                persistence: Some(DhtPersistenceConfig {
                    dump_interval: None,
                    config_filename: Some(dht_file),
                }),
            })
        } else {
            None
        };

        let listen = Some(ListenerOptions {
            mode: ListenerMode::TcpAndUtp,
            listen_addr: SocketAddr::from(([0, 0, 0, 0], cfg.listen_port)),
            enable_upnp_port_forwarding: cfg.enable_upnp,
            ipv4_only: false,
            ..Default::default()
        });

        let ratelimits = LimitsConfig {
            download_bps: kbps_to_bps(cfg.max_download_kbps),
            upload_bps: kbps_to_bps(cfg.max_upload_kbps),
        };

        let opts = SessionOptions {
            dht,
            disable_trackers: cfg.disable_trackers,
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(session_dir),
            }),
            listen,
            ratelimits,
            peer_limit: Some(if cfg.peer_limit == 0 { 128 } else { cfg.peer_limit }),
            disable_local_service_discovery: !cfg.enable_lsd,
            ..Default::default()
        };

        let session = match Session::new_with_opts(default_dir.clone(), opts).await {
            Ok(s) => s,
            Err(first_err) if cfg.listen_port != 0 => {
                // Fall back to OS-assigned port if the user-configured port is already in use.
                let fallback_opts = SessionOptions {
                    dht: if cfg.enable_dht {
                        Some(DhtSessionConfig {
                            bootstrap_addrs: None,
                            port: None,
                            persistence: Some(DhtPersistenceConfig {
                                dump_interval: None,
                                config_filename: Some(
                                    self.app_data_dir.join("torrent-dht").join("dht.json"),
                                ),
                            }),
                        })
                    } else {
                        None
                    },
                    disable_trackers: cfg.disable_trackers,
                    fastresume: true,
                    persistence: Some(SessionPersistenceConfig::Json {
                        folder: Some(self.app_data_dir.join("torrent-session")),
                    }),
                    listen: Some(ListenerOptions {
                        mode: ListenerMode::TcpAndUtp,
                        listen_addr: SocketAddr::from(([0, 0, 0, 0], 0)),
                        enable_upnp_port_forwarding: cfg.enable_upnp,
                        ipv4_only: false,
                        ..Default::default()
                    }),
                    ratelimits,
                    peer_limit: Some(if cfg.peer_limit == 0 { 128 } else { cfg.peer_limit }),
                    disable_local_service_discovery: !cfg.enable_lsd,
                    ..Default::default()
                };
                Session::new_with_opts(default_dir, fallback_opts)
                    .await
                    .map_err(|_| format!("Failed to start BitTorrent session: {first_err:#}"))?
            }
            Err(e) => return Err(format!("Failed to start BitTorrent session: {e:#}")),
        };

        *guard = Some(session.clone());
        Ok(session)
    }

    pub async fn configure(&self, new_cfg: TorrentEngineConfig) -> Result<Option<u16>, String> {
        let prev = {
            let mut w = self.config.write().await;
            let old = w.clone();
            *w = new_cfg.clone();
            old
        };

        let mut guard = self.session.lock().await;
        if let Some(sess) = guard.as_ref() {
            sess.ratelimits
                .set_download_bps(kbps_to_bps(new_cfg.max_download_kbps));
            sess.ratelimits
                .set_upload_bps(kbps_to_bps(new_cfg.max_upload_kbps));

            let has_pending = !self.pending_magnets.lock().unwrap().is_empty();
            if prev.requires_session_restart(&new_cfg) && !has_pending {
                let old_sess = guard.take();
                drop(guard);
                if let Some(s) = old_sess {
                    s.stop().await;
                }
                let restarted = self.ensure_session().await?;
                return Ok(restarted.listen_addr().map(|a| a.port()));
            }
            return Ok(sess.listen_addr().map(|a| a.port()));
        }
        Ok(None)
    }

    pub async fn inspect_source(&self, source: &str) -> Result<InspectTorrentRes, String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("Enter a magnet link or choose a .torrent file".into());
        }

        // 1. Base64-encoded `.torrent` bytes (e.g. drag-and-drop File in webview)
        if let Some(b64) = trimmed.strip_prefix("base64:") {
            let bytes = decode_base64(b64)?;
            let res = parse_torrent_bytes_meta(&bytes)?;
            self.cached_torrent_bytes
                .lock()
                .unwrap()
                .insert(res.info_hash.clone(), bytes);
            return Ok(res);
        }

        // 2. Magnet URI or 40-hex infohash
        let is_hex_hash =
            trimmed.len() == 40 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) && !Path::new(trimmed).exists();
        if trimmed.to_ascii_lowercase().starts_with("magnet:") || is_hex_hash {
            let magnet = Magnet::parse(trimmed)
                .map_err(|e| format!("Invalid magnet link: {e:#}"))?;
            let id20 = magnet
                .as_id20()
                .ok_or_else(|| "Only BitTorrent v1 (btih) magnet links are supported".to_string())?;
            let info_hash = id20.as_string();

            if let Some(cached) = self
                .cached_torrent_bytes
                .lock()
                .unwrap()
                .get(&info_hash)
                .cloned()
            {
                if let Ok(mut parsed) = parse_torrent_bytes_meta(&cached) {
                    parsed.is_magnet = true;
                    if parsed.trackers.is_empty() {
                        parsed.trackers = magnet.trackers;
                    }
                    return Ok(parsed);
                }
            }

            let name = magnet
                .name
                .map(|n| decode_percent(&n))
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| format!("Magnet {}", &info_hash[..8]));

            return Ok(InspectTorrentRes {
                info_hash,
                name,
                total_bytes: 0,
                is_magnet: true,
                metadata_ready: false,
                files: Vec::new(),
                trackers: magnet.trackers,
            });
        }

        // 3. HTTP / HTTPS `.torrent` URL
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .get(trimmed)
                .send()
                .await
                .map_err(|e| format!("Failed to download .torrent URL: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("Server returned HTTP {} for .torrent URL", resp.status()));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("Failed reading .torrent response: {e}"))?
                .to_vec();
            let res = parse_torrent_bytes_meta(&bytes)?;
            self.cached_torrent_bytes
                .lock()
                .unwrap()
                .insert(res.info_hash.clone(), bytes);
            return Ok(res);
        }

        // 4. Local `.torrent` file (plain path or `file://` URL)
        let local_path = if trimmed.starts_with("file://") {
            normalize_file_url_or_path(trimmed)
                .ok_or_else(|| format!("Invalid .torrent file URL: {trimmed}"))?
        } else {
            trimmed.to_string()
        };
        let bytes = tokio::fs::read(&local_path)
            .await
            .map_err(|e| format!("Cannot read .torrent file '{local_path}': {e}"))?;
        let res = parse_torrent_bytes_meta(&bytes)?;
        self.cached_torrent_bytes
            .lock()
            .unwrap()
            .insert(res.info_hash.clone(), bytes);
        Ok(res)
    }

    pub async fn inspect_files_live(
        &self,
        source: &str,
        timeout_ms: u64,
    ) -> Result<InspectTorrentRes, String> {
        let fast = self.inspect_source(source).await?;
        if fast.metadata_ready {
            return Ok(fast);
        }

        let session = self.ensure_session().await?;
        let add_fut = session.add_torrent(
            AddTorrent::from_url(source.trim().to_string()),
            Some(AddTorrentOptions {
                list_only: true,
                ..Default::default()
            }),
        );
        match tokio::time::timeout(Duration::from_millis(timeout_ms.clamp(500, 30_000)), add_fut)
            .await
        {
            Ok(Ok(AddTorrentResponse::ListOnly(list_res))) => {
                let bytes = list_res.torrent_bytes.to_vec();
                let mut parsed = parse_torrent_bytes_meta(&bytes)?;
                parsed.is_magnet = true;
                self.cached_torrent_bytes
                    .lock()
                    .unwrap()
                    .insert(parsed.info_hash.clone(), bytes);
                Ok(parsed)
            }
            _ => Ok(fast),
        }
    }

    fn status_from_handle(handle: &ManagedTorrent, listen_port: Option<u16>) -> TorrentStatus {
        let stats = handle.stats();
        let info_hash = handle.info_hash().as_string();
        let output_folder_path = handle.output_folder().to_path_buf();
        let output_folder = output_folder_path.to_string_lossy().into_owned();
        let only_set: Option<HashSet<usize>> =
            handle.only_files().map(|v| v.into_iter().collect());

        let mut files = Vec::new();
        let _ = handle.with_metadata(|meta| {
            for (idx, fi) in meta.file_infos.iter().enumerate() {
                if fi.attrs.padding {
                    continue;
                }
                let rel = &fi.relative_filename;
                let fname = rel
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| format!("file_{idx}"));
                let full_path = output_folder_path
                    .join(rel)
                    .to_string_lossy()
                    .into_owned();
                let downloaded_bytes = stats.file_progress.get(idx).copied().unwrap_or(0);
                let included = only_set.as_ref().map(|s| s.contains(&idx)).unwrap_or(true);
                let is_video = is_video_candidate(rel, fi.len);
                files.push(TorrentFileStatus {
                    index: idx,
                    name: fname,
                    relative_path: rel.to_string_lossy().into_owned(),
                    full_path,
                    size: fi.len,
                    downloaded_bytes,
                    included,
                    is_video,
                });
            }
        });
        if !files.iter().any(|f| f.is_video) {
            for f in &mut files {
                if crate::scanner::has_video_extension(Path::new(&f.relative_path)) {
                    f.is_video = true;
                }
            }
        }

        let name = handle
            .name()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("Torrent {}", &info_hash[..8]));

        let (download_speed_bps, upload_speed_bps, peers_live, peers_connecting, peers_seen) =
            if let Some(live) = &stats.live {
                let ps = &live.snapshot.peer_stats;
                (
                    live.download_speed.as_bytes(),
                    live.upload_speed.as_bytes(),
                    ps.live,
                    ps.connecting,
                    ps.seen,
                )
            } else {
                (0, 0, 0, 0, 0)
            };

        let eta_secs = if !stats.finished
            && download_speed_bps > 0
            && stats.total_bytes > stats.progress_bytes
        {
            Some((stats.total_bytes - stats.progress_bytes) / download_speed_bps)
        } else {
            None
        };

        let progress_pct = if stats.total_bytes > 0 {
            ((stats.progress_bytes as f64 / stats.total_bytes as f64) * 100.0).clamp(0.0, 100.0)
        } else if stats.finished {
            100.0
        } else {
            0.0
        };

        let state = match stats.state {
            TorrentStatsState::Error => "error",
            TorrentStatsState::Initializing { .. } => "initializing",
            TorrentStatsState::Paused => {
                if stats.finished {
                    "completed"
                } else {
                    "paused"
                }
            }
            TorrentStatsState::Live => {
                if stats.finished {
                    "seeding"
                } else {
                    "downloading"
                }
            }
        }
        .to_string();

        TorrentStatus {
            info_hash,
            name,
            state,
            progress_bytes: stats.progress_bytes,
            total_bytes: stats.total_bytes,
            uploaded_bytes: stats.uploaded_bytes,
            progress_pct,
            download_speed_bps,
            upload_speed_bps,
            eta_secs,
            peers_live,
            peers_connecting,
            peers_seen,
            finished: stats.finished,
            paused: handle.is_paused(),
            error: stats.error,
            output_folder,
            listen_port,
            files,
        }
    }

    pub async fn add_torrent(
        self: &Arc<Self>,
        req: AddTorrentReq,
        app: Option<AppHandle>,
    ) -> Result<TorrentStatus, String> {
        let inspected = self.inspect_source(&req.source).await?;
        let info_hash = inspected.info_hash.clone();
        let id20 = Id20::from_str(&info_hash).map_err(|e| format!("Invalid info_hash: {e}"))?;

        let target_dir = if req.is_stream {
            self.stream_cache_root().await.join(&info_hash)
        } else {
            let base = req
                .output_folder
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| self.app_data_dir.join("downloads"));
            match req.sub_folder.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(sub) => base.join(sanitize_folder_name(sub)),
                None => base,
            }
        };
        std::fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Cannot create download folder '{}': {e}", target_dir.display()))?;
        let target_dir_str = target_dir.to_string_lossy().into_owned();

        let session = self.ensure_session().await?;
        let listen_port = session.listen_addr().map(|a| a.port());

        // If already managed in session, return (and optionally unpause / update file selection).
        if let Some(existing) = session.get(TorrentIdOrHash::Hash(id20)) {
            if let Some(only) = &req.only_files {
                let set: HashSet<usize> = only.iter().copied().collect();
                let _ = session.update_only_files(&existing, &set).await;
            }
            if !req.paused && existing.is_paused() && !existing.stats().finished {
                let _ = session.unpause(&existing).await;
            }
            return Ok(Self::status_from_handle(&existing, listen_port));
        }

        let initial_peers: Option<Vec<SocketAddr>> = req.initial_peers.as_ref().map(|list| {
            list.iter()
                .filter_map(|s| s.parse::<SocketAddr>().ok())
                .collect()
        });

        let opts = AddTorrentOptions {
            paused: req.paused,
            only_files: req.only_files.clone(),
            overwrite: true,
            output_folder: Some(target_dir_str.clone()),
            initial_peers,
            ..Default::default()
        };

        let cached_bytes = self
            .cached_torrent_bytes
            .lock()
            .unwrap()
            .get(&info_hash)
            .cloned();

        if let Some(bytes) = cached_bytes {
            let resp = session
                .add_torrent(AddTorrent::from_bytes(bytes), Some(opts))
                .await
                .map_err(|e| format!("Failed to add torrent: {e:#}"))?;
            let handle = resp
                .into_handle()
                .ok_or_else(|| "Unexpected list-only response when adding torrent".to_string())?;
            return Ok(Self::status_from_handle(&handle, listen_port));
        }

        // Unresolved magnet link: check if already resolving in background
        {
            let pending = self.pending_magnets.lock().unwrap();
            if let Some(pm) = pending.get(&info_hash) {
                return Ok(TorrentStatus {
                    info_hash: pm.info_hash.clone(),
                    name: pm.name.clone(),
                    state: if pm.error.is_some() {
                        "error".into()
                    } else {
                        "resolving".into()
                    },
                    progress_bytes: 0,
                    total_bytes: 0,
                    uploaded_bytes: 0,
                    progress_pct: 0.0,
                    download_speed_bps: 0,
                    upload_speed_bps: 0,
                    eta_secs: None,
                    peers_live: 0,
                    peers_connecting: 0,
                    peers_seen: 0,
                    finished: false,
                    paused: pm.paused,
                    error: pm.error.clone(),
                    output_folder: pm.output_folder.clone(),
                    listen_port,
                    files: Vec::new(),
                });
            }
        }

        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<TorrentStatus, String>>();
        let mgr_clone = self.clone();
        let session_clone = session.clone();
        let source_owned = req.source.trim().to_string();
        let hash_clone = info_hash.clone();

        let join = tokio::spawn(async move {
            let res = session_clone
                .add_torrent(AddTorrent::from_url(source_owned), Some(opts))
                .await;
            match res {
                Ok(resp) => {
                    mgr_clone
                        .pending_magnets
                        .lock()
                        .unwrap()
                        .remove(&hash_clone);
                    if let Some(handle) = resp.into_handle() {
                        let _ = handle.with_metadata(|m| {
                            mgr_clone
                                .cached_torrent_bytes
                                .lock()
                                .unwrap()
                                .insert(hash_clone.clone(), m.torrent_bytes.to_vec());
                        });
                        let st = Self::status_from_handle(
                            &handle,
                            session_clone.listen_addr().map(|a| a.port()),
                        );
                        if let Some(app_h) = app.as_ref() {
                            let _ = app_h.emit("torrent-metadata-ready", &st);
                        }
                        let _ = done_tx.send(Ok(st));
                    }
                }
                Err(e) => {
                    let msg = format!("{e:#}");
                    if let Some(pm) = mgr_clone
                        .pending_magnets
                        .lock()
                        .unwrap()
                        .get_mut(&hash_clone)
                    {
                        pm.error = Some(msg.clone());
                    }
                    let _ = done_tx.send(Err(msg));
                }
            }
        });

        self.pending_magnets.lock().unwrap().insert(
            info_hash.clone(),
            PendingMagnet {
                info_hash: info_hash.clone(),
                name: inspected.name.clone(),
                output_folder: target_dir_str.clone(),
                paused: req.paused,
                error: None,
                abort_handle: join.abort_handle(),
            },
        );

        match tokio::time::timeout(Duration::from_millis(350), done_rx).await {
            Ok(Ok(Ok(status))) => Ok(status),
            Ok(Ok(Err(err))) => Err(err),
            _ => Ok(TorrentStatus {
                info_hash,
                name: inspected.name,
                state: "resolving".into(),
                progress_bytes: 0,
                total_bytes: 0,
                uploaded_bytes: 0,
                progress_pct: 0.0,
                download_speed_bps: 0,
                upload_speed_bps: 0,
                eta_secs: None,
                peers_live: 0,
                peers_connecting: 0,
                peers_seen: 0,
                finished: false,
                paused: req.paused,
                error: None,
                output_folder: target_dir_str,
                listen_port,
                files: Vec::new(),
            }),
        }
    }

    pub async fn list_torrents(&self) -> Vec<TorrentStatus> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();

        let existing_session = { self.session.lock().await.clone() };
        let listen_port = existing_session
            .as_ref()
            .and_then(|s| s.listen_addr().map(|a| a.port()));

        if let Some(session) = existing_session {
            let live_list = session.with_torrents(|iter| {
                iter.map(|(_, handle)| Self::status_from_handle(handle, listen_port))
                    .collect::<Vec<_>>()
            });
            for st in live_list {
                seen.insert(st.info_hash.clone());
                out.push(st);
            }
        }

        let pending = self.pending_magnets.lock().unwrap();
        for (hash, pm) in pending.iter() {
            if seen.contains(hash) {
                continue;
            }
            out.push(TorrentStatus {
                info_hash: pm.info_hash.clone(),
                name: pm.name.clone(),
                state: if pm.error.is_some() {
                    "error".into()
                } else {
                    "resolving".into()
                },
                progress_bytes: 0,
                total_bytes: 0,
                uploaded_bytes: 0,
                progress_pct: 0.0,
                download_speed_bps: 0,
                upload_speed_bps: 0,
                eta_secs: None,
                peers_live: 0,
                peers_connecting: 0,
                peers_seen: 0,
                finished: false,
                paused: pm.paused,
                error: pm.error.clone(),
                output_folder: pm.output_folder.clone(),
                listen_port,
                files: Vec::new(),
            });
        }

        out
    }

    pub async fn action(&self, info_hash: &str, action: &str) -> Result<(), String> {
        let clean_hash = info_hash.trim().to_ascii_lowercase();

        // Check pending magnet cancellation first for delete actions.
        if action == "delete_keep_files" || action == "delete_with_files" {
            let removed_pending = self.pending_magnets.lock().unwrap().remove(&clean_hash);
            if let Some(pm) = removed_pending {
                pm.abort_handle.abort();
                if action == "delete_with_files" {
                    let _ = std::fs::remove_dir_all(&pm.output_folder);
                }
            }
        }

        let id20 = match Id20::from_str(&clean_hash) {
            Ok(id) => id,
            Err(_) => return Ok(()),
        };

        let session = {
            let g = self.session.lock().await;
            match g.as_ref() {
                Some(s) => s.clone(),
                None => return Ok(()),
            }
        };

        match action {
            "pause" => {
                if let Some(h) = session.get(TorrentIdOrHash::Hash(id20)) {
                    if !h.is_paused() {
                        session.pause(&h).await.map_err(|e| format!("{e:#}"))?;
                    }
                }
                Ok(())
            }
            "resume" => {
                if let Some(h) = session.get(TorrentIdOrHash::Hash(id20)) {
                    if h.is_paused() {
                        session.unpause(&h).await.map_err(|e| format!("{e:#}"))?;
                    }
                }
                Ok(())
            }
            "delete_keep_files" => {
                if session.get(TorrentIdOrHash::Hash(id20)).is_some() {
                    session
                        .delete(TorrentIdOrHash::Hash(id20), false)
                        .await
                        .map_err(|e| format!("{e:#}"))?;
                }
                Ok(())
            }
            "delete_with_files" => {
                let folder_opt = session
                    .get(TorrentIdOrHash::Hash(id20))
                    .map(|h| h.output_folder().to_path_buf());
                if folder_opt.is_some() {
                    session
                        .delete(TorrentIdOrHash::Hash(id20), true)
                        .await
                        .map_err(|e| format!("{e:#}"))?;
                }
                let cache_root = self.stream_cache_root().await;
                if let Some(folder) = folder_opt {
                    if folder.starts_with(&cache_root) {
                        let _ = std::fs::remove_dir_all(&folder);
                    } else {
                        // Remove torrent subfolder only if now empty.
                        let _ = std::fs::remove_dir(&folder);
                    }
                } else {
                    let stream_dir = cache_root.join(&clean_hash);
                    if stream_dir.exists() {
                        let _ = std::fs::remove_dir_all(&stream_dir);
                    }
                }
                Ok(())
            }
            other => Err(format!("Unknown torrent action: {other}")),
        }
    }

    pub async fn set_only_files(
        &self,
        info_hash: &str,
        only_files: Vec<usize>,
    ) -> Result<(), String> {
        let id20 =
            Id20::from_str(info_hash.trim()).map_err(|e| format!("Invalid info_hash: {e}"))?;
        let session = self.ensure_session().await?;
        if let Some(handle) = session.get(TorrentIdOrHash::Hash(id20)) {
            let set: HashSet<usize> = only_files.into_iter().collect();
            session
                .update_only_files(&handle, &set)
                .await
                .map_err(|e| format!("Failed to update file selection: {e:#}"))?;
        }
        Ok(())
    }

    async fn ensure_stream_server(self: &Arc<Self>) -> Result<(u16, String), String> {
        let mgr = self.clone();
        self.stream_server
            .get_or_try_init(|| async move {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|e| format!("Failed to bind local torrent stream server: {e}"))?;
                let port = listener
                    .local_addr()
                    .map_err(|e| format!("Failed to inspect local stream port: {e}"))?
                    .port();
                let secret = random_hex_128();
                let secret_for_loop = secret.clone();
                let mgr_for_loop = mgr.clone();

                tokio::spawn(async move {
                    loop {
                        let Ok((socket, _)) = listener.accept().await else {
                            break;
                        };
                        let mgr_conn = mgr_for_loop.clone();
                        let sec_conn = secret_for_loop.clone();
                        tokio::spawn(async move {
                            let _ = serve_stream_connection(socket, mgr_conn, sec_conn).await;
                        });
                    }
                });

                Ok((port, secret))
            })
            .await
            .cloned()
    }

    pub async fn stream_url(
        self: &Arc<Self>,
        info_hash: &str,
        file_index: Option<usize>,
    ) -> Result<String, String> {
        let id20 =
            Id20::from_str(info_hash.trim()).map_err(|e| format!("Invalid info_hash: {e}"))?;
        let session = self.ensure_session().await?;

        // Wait up to 20s if magnet metadata is currently resolving in background.
        let handle = {
            let mut found = session.get(TorrentIdOrHash::Hash(id20));
            if found.is_none() {
                for _ in 0..80 {
                    let has_pending = self
                        .pending_magnets
                        .lock()
                        .unwrap()
                        .contains_key(&id20.as_string());
                    if !has_pending {
                        found = session.get(TorrentIdOrHash::Hash(id20));
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    found = session.get(TorrentIdOrHash::Hash(id20));
                    if found.is_some() {
                        break;
                    }
                }
            }
            found.ok_or_else(|| "Torrent is not active or metadata has not resolved yet".to_string())?
        };

        let chosen_idx = match file_index {
            Some(i) => i,
            None => handle
                .with_metadata(|meta| {
                    meta.file_infos
                        .iter()
                        .enumerate()
                        .filter(|(_, fi)| !fi.attrs.padding)
                        .max_by_key(|(_, fi)| {
                            (is_video_candidate(&fi.relative_filename, fi.len), fi.len)
                        })
                        .map(|(idx, _)| idx)
                        .unwrap_or(0)
                })
                .map_err(|e| format!("Torrent metadata unavailable: {e:#}"))?,
        };

        // Ensure the chosen file is enabled in `only_files` if a subset was selected.
        if let Some(current_only) = handle.only_files() {
            if !current_only.contains(&chosen_idx) {
                let mut updated: HashSet<usize> = current_only.into_iter().collect();
                updated.insert(chosen_idx);
                let _ = session.update_only_files(&handle, &updated).await;
            }
        }

        if handle.is_paused() && !handle.stats().finished {
            let _ = session.unpause(&handle).await;
        }

        let (port, secret) = self.ensure_stream_server().await?;
        Ok(format!(
            "http://127.0.0.1:{port}/torrent/{secret}/{}/{chosen_idx}",
            id20.as_string()
        ))
    }
}

async fn serve_stream_connection(
    mut socket: TcpStream,
    mgr: Arc<TorrentManager>,
    expected_secret: String,
) -> Result<(), ()> {
    let _ = socket.set_nodelay(true);
    let mut hdr_buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let n = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut chunk))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        hdr_buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = hdr_buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if hdr_buf.len() > 16 * 1024 {
            return Err(());
        }
    };

    let req_text = String::from_utf8_lossy(&hdr_buf[..header_end]);
    let mut lines = req_text.split("\r\n");
    let first_line = lines.next().ok_or(())?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next().ok_or(())?;
    let raw_path = parts.next().ok_or(())?;

    if method != "GET" && method != "HEAD" {
        let _ = socket
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    }

    let path_only = raw_path.split('?').next().unwrap_or(raw_path);
    // Expected: /torrent/<secret>/<info_hash>/<file_idx>
    let segs: Vec<&str> = path_only.trim_start_matches('/').split('/').collect();
    if segs.len() < 4 || segs[0] != "torrent" {
        let _ = socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    }
    if segs[1] != expected_secret {
        let _ = socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    }

    let Ok(id20) = Id20::from_str(segs[2]) else {
        let _ = socket
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    };
    let Ok(file_idx) = segs[3].parse::<usize>() else {
        let _ = socket
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    };

    let mut range_header: Option<String> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    let session = mgr.ensure_session().await.map_err(|_| ())?;
    let Some(handle) = session.get(TorrentIdOrHash::Hash(id20)) else {
        let _ = socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    };

    let _ = tokio::time::timeout(Duration::from_secs(15), handle.wait_until_initialized()).await;
    if handle.is_paused() && !handle.stats().finished {
        let _ = session.unpause(&handle).await;
    }

    let mime = handle
        .with_metadata(|m| {
            m.file_infos
                .get(file_idx)
                .map(|fi| content_type_for_path(&fi.relative_filename))
                .unwrap_or("application/octet-stream")
        })
        .unwrap_or("application/octet-stream");

    let mut fstream = match handle.clone().stream(file_idx).await {
        Ok(s) => s,
        Err(_) => {
            let _ = socket
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            return Ok(());
        }
    };

    let total = fstream.len();
    let (status_line, start, end, content_range_hdr) = if let Some(rh) = range_header {
        if let Some((s, e)) = parse_byte_range(&rh, total) {
            (
                "HTTP/1.1 206 Partial Content",
                s,
                e,
                format!("Content-Range: bytes {s}-{e}/{total}\r\n"),
            )
        } else {
            let hdr = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = socket.write_all(hdr.as_bytes()).await;
            return Ok(());
        }
    } else if total == 0 {
        ("HTTP/1.1 200 OK", 0, 0, String::new())
    } else {
        ("HTTP/1.1 200 OK", 0, total - 1, String::new())
    };

    let body_len = if total == 0 { 0 } else { end - start + 1 };
    if start > 0 {
        fstream
            .seek(SeekFrom::Start(start))
            .await
            .map_err(|_| ())?;
    }

    let response_hdr = format!(
        "{status_line}\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\n{content_range_hdr}Content-Length: {body_len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    socket
        .write_all(response_hdr.as_bytes())
        .await
        .map_err(|_| ())?;

    if method == "HEAD" || body_len == 0 {
        let _ = socket.flush().await;
        return Ok(());
    }

    let mut remaining = body_len;
    let mut buf = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let n = fstream.read(&mut buf[..to_read]).await.map_err(|_| ())?;
        if n == 0 {
            break;
        }
        socket.write_all(&buf[..n]).await.map_err(|_| ())?;
        remaining -= n as u64;
    }
    let _ = socket.flush().await;
    Ok(())
}

// ============================================================================
// OS Default Handler Check & Registration (`magnet:` + `.torrent`)
// ============================================================================

#[cfg(target_os = "macos")]
mod macos_launch_services {
    use std::ffi::{c_char, c_void};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFIndex = isize;
    type CFStringEncoding = u32;
    type LSRolesMask = u32;
    type OSStatus = i32;

    const K_CF_STRING_ENCODING_UTF8: CFStringEncoding = 0x0800_0100;
    const K_LS_ROLES_ALL: LSRolesMask = 0xFFFF_FFFF;
    const K_LS_ROLES_VIEWER: LSRolesMask = 0x0000_0002;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(
            alloc: CFAllocatorRef,
            bytes: *const u8,
            num_bytes: CFIndex,
            encoding: CFStringEncoding,
            is_external_representation: u8,
        ) -> CFStringRef;
        fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
        fn CFStringGetMaximumSizeForEncoding(
            length: CFIndex,
            encoding: CFStringEncoding,
        ) -> CFIndex;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: CFIndex,
            encoding: CFStringEncoding,
        ) -> u8;
        fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultHandlerForURLScheme(in_url_scheme: CFStringRef) -> CFStringRef;
        fn LSSetDefaultHandlerForURLScheme(
            in_url_scheme: CFStringRef,
            in_handler_bundle_id: CFStringRef,
        ) -> OSStatus;
        fn UTTypeCreatePreferredIdentifierForTag(
            in_tag_class: CFStringRef,
            in_tag: CFStringRef,
            in_conforming_to_uti: CFStringRef,
        ) -> CFStringRef;
        fn LSCopyDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: LSRolesMask,
        ) -> CFStringRef;
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: LSRolesMask,
            in_handler_bundle_id: CFStringRef,
        ) -> OSStatus;
    }

    struct CfStr(CFStringRef);
    impl CfStr {
        fn new(s: &str) -> Option<Self> {
            let ptr = unsafe {
                CFStringCreateWithBytes(
                    std::ptr::null(),
                    s.as_ptr(),
                    s.len() as CFIndex,
                    K_CF_STRING_ENCODING_UTF8,
                    0,
                )
            };
            if ptr.is_null() {
                None
            } else {
                Some(Self(ptr))
            }
        }

        fn from_owned(ptr: CFStringRef) -> Option<Self> {
            if ptr.is_null() {
                None
            } else {
                Some(Self(ptr))
            }
        }

        fn to_rust_string(&self) -> Option<String> {
            unsafe {
                let len = CFStringGetLength(self.0);
                let cap = CFStringGetMaximumSizeForEncoding(len, K_CF_STRING_ENCODING_UTF8) + 1;
                if cap <= 0 {
                    return None;
                }
                let mut buf = vec![0u8; cap as usize];
                let ok = CFStringGetCString(
                    self.0,
                    buf.as_mut_ptr() as *mut c_char,
                    cap,
                    K_CF_STRING_ENCODING_UTF8,
                );
                if ok == 0 {
                    return None;
                }
                let nul = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                Some(String::from_utf8_lossy(&buf[..nul]).into_owned())
            }
        }
    }

    impl Drop for CfStr {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn torrent_uti() -> Option<CfStr> {
        let tag_class = CfStr::new("public.filename-extension")?;
        let ext = CfStr::new("torrent")?;
        let uti_ptr = unsafe {
            UTTypeCreatePreferredIdentifierForTag(tag_class.0, ext.0, std::ptr::null())
        };
        CfStr::from_owned(uti_ptr)
    }

    pub fn check(bundle_id: &str) -> (bool, bool) {
        let magnet_ok = CfStr::new("magnet")
            .and_then(|s| CfStr::from_owned(unsafe { LSCopyDefaultHandlerForURLScheme(s.0) }))
            .and_then(|h| h.to_rust_string())
            .map(|h| h.eq_ignore_ascii_case(bundle_id))
            .unwrap_or(false);

        let torrent_ok = torrent_uti()
            .and_then(|uti| {
                CfStr::from_owned(unsafe {
                    LSCopyDefaultRoleHandlerForContentType(uti.0, K_LS_ROLES_VIEWER)
                })
                .or_else(|| {
                    CfStr::from_owned(unsafe {
                        LSCopyDefaultRoleHandlerForContentType(uti.0, K_LS_ROLES_ALL)
                    })
                })
            })
            .and_then(|h| h.to_rust_string())
            .map(|h| h.eq_ignore_ascii_case(bundle_id))
            .unwrap_or(false);

        (magnet_ok, torrent_ok)
    }

    pub fn register(bundle_id: &str) -> Result<(), String> {
        let bid = CfStr::new(bundle_id).ok_or_else(|| "Invalid bundle identifier".to_string())?;
        let scheme = CfStr::new("magnet").ok_or_else(|| "Invalid scheme".to_string())?;
        let status_magnet = unsafe { LSSetDefaultHandlerForURLScheme(scheme.0, bid.0) };

        let mut status_torrent = 0;
        if let Some(uti) = torrent_uti() {
            status_torrent =
                unsafe { LSSetDefaultRoleHandlerForContentType(uti.0, K_LS_ROLES_ALL, bid.0) };
        }
        if let Some(alt_uti) = CfStr::new("org.bittorrent.torrent") {
            let _ = unsafe {
                LSSetDefaultRoleHandlerForContentType(alt_uti.0, K_LS_ROLES_ALL, bid.0)
            };
        }

        if status_magnet != 0 && status_torrent != 0 {
            return Err(format!(
                "macOS LaunchServices returned status {status_magnet} / {status_torrent}"
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
mod windows_assoc {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use tauri::AppHandle;
    use tauri_plugin_deep_link::DeepLinkExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn run_reg(args: &[&str]) -> Result<String, String> {
        let out = Command::new("reg.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to invoke reg.exe: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        }
    }

    pub fn check(app: &AppHandle) -> (bool, bool) {
        let magnet_ok = app.deep_link().is_registered("magnet").unwrap_or(false);
        let torrent_ok = run_reg(&["query", r"HKCU\Software\Classes\.torrent", "/ve"])
            .map(|s| s.contains("TruongFlix.torrent"))
            .unwrap_or(false);
        (magnet_ok, torrent_ok)
    }

    pub fn register(app: &AppHandle) -> Result<(), String> {
        app.deep_link()
            .register("magnet")
            .map_err(|e| format!("Failed registering magnet protocol: {e}"))?;
        let exe = std::env::current_exe()
            .map_err(|e| format!("Cannot locate executable path: {e}"))?
            .to_string_lossy()
            .into_owned();
        let icon_val = format!("\"{exe}\",0");
        let cmd_val = format!("\"{exe}\" \"%1\"");

        run_reg(&[
            "add",
            r"HKCU\Software\Classes\TruongFlix.torrent",
            "/ve",
            "/d",
            "BitTorrent File",
            "/f",
        ])?;
        run_reg(&[
            "add",
            r"HKCU\Software\Classes\TruongFlix.torrent\DefaultIcon",
            "/ve",
            "/d",
            &icon_val,
            "/f",
        ])?;
        run_reg(&[
            "add",
            r"HKCU\Software\Classes\TruongFlix.torrent\shell\open\command",
            "/ve",
            "/d",
            &cmd_val,
            "/f",
        ])?;
        run_reg(&[
            "add",
            r"HKCU\Software\Classes\.torrent",
            "/ve",
            "/d",
            "TruongFlix.torrent",
            "/f",
        ])?;
        Ok(())
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn torrent_configure(
    app: AppHandle,
    config: TorrentEngineConfig,
) -> Result<Option<u16>, String> {
    let mgr = global_manager(&app)?;
    mgr.configure(config).await
}

#[tauri::command]
pub async fn torrent_inspect(
    app: AppHandle,
    source: String,
) -> Result<InspectTorrentRes, String> {
    let mgr = global_manager(&app)?;
    mgr.inspect_source(&source).await
}

#[tauri::command]
pub async fn torrent_inspect_files(
    app: AppHandle,
    source: String,
    timeout_ms: Option<u64>,
) -> Result<InspectTorrentRes, String> {
    let mgr = global_manager(&app)?;
    mgr.inspect_files_live(&source, timeout_ms.unwrap_or(9_000))
        .await
}

#[tauri::command]
pub async fn torrent_add(app: AppHandle, req: AddTorrentReq) -> Result<TorrentStatus, String> {
    let mgr = global_manager(&app)?;
    mgr.add_torrent(req, Some(app)).await
}

#[tauri::command]
pub async fn torrent_list(app: AppHandle) -> Result<Vec<TorrentStatus>, String> {
    let mgr = global_manager(&app)?;
    Ok(mgr.list_torrents().await)
}

#[tauri::command]
pub async fn torrent_action(
    app: AppHandle,
    info_hash: String,
    action: String,
) -> Result<(), String> {
    let mgr = global_manager(&app)?;
    mgr.action(&info_hash, &action).await
}

#[tauri::command]
pub async fn torrent_set_only_files(
    app: AppHandle,
    info_hash: String,
    only_files: Vec<usize>,
) -> Result<(), String> {
    let mgr = global_manager(&app)?;
    mgr.set_only_files(&info_hash, only_files).await
}

#[tauri::command]
pub async fn torrent_stream_url(
    app: AppHandle,
    info_hash: String,
    file_index: Option<usize>,
) -> Result<String, String> {
    let mgr = global_manager(&app)?;
    mgr.stream_url(&info_hash, file_index).await
}

#[tauri::command]
pub fn torrent_take_pending_links() -> Vec<String> {
    let mut q = PENDING_OPEN_LINKS.lock().unwrap();
    std::mem::take(&mut *q)
}

#[tauri::command]
pub fn torrent_check_os_handler(app: AppHandle) -> OsHandlerStatus {
    #[cfg(target_os = "macos")]
    {
        let (m, t) = macos_launch_services::check(&app.config().identifier);
        return OsHandlerStatus {
            magnet_registered: m,
            torrent_file_registered: t,
            platform: "macos".into(),
        };
    }
    #[cfg(windows)]
    {
        let (m, t) = windows_assoc::check(&app);
        return OsHandlerStatus {
            magnet_registered: m,
            torrent_file_registered: t,
            platform: "windows".into(),
        };
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        OsHandlerStatus {
            magnet_registered: false,
            torrent_file_registered: false,
            platform: "other".into(),
        }
    }
}

#[tauri::command]
pub fn torrent_register_os_handler(app: AppHandle) -> Result<OsHandlerStatus, String> {
    #[cfg(target_os = "macos")]
    {
        macos_launch_services::register(&app.config().identifier)?;
        return Ok(torrent_check_os_handler(app));
    }
    #[cfg(windows)]
    {
        windows_assoc::register(&app)?;
        return Ok(torrent_check_os_handler(app));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Ok(torrent_check_os_handler(app))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use librqbit::CreateTorrentOptions;

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "truongflix_torrent_test_{prefix}_{}_{}",
            std::process::id(),
            random_hex_128()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn test_sanitize_and_range_parser() {
        assert_eq!(
            sanitize_folder_name("  Dune: Part Two (2024) / 4K?*  "),
            "Dune Part Two (2024) 4K"
        );
        assert_eq!(parse_byte_range("bytes=0-1023", 5000), Some((0, 1023)));
        assert_eq!(parse_byte_range("bytes=100-", 5000), Some((100, 4999)));
        assert_eq!(parse_byte_range("bytes=-500", 5000), Some((4500, 4999)));
        assert_eq!(parse_byte_range("bytes=6000-7000", 5000), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_magnet_fast_inspect() {
        let root = temp_test_dir("magnet_inspect");
        let mgr = TorrentManager::new(root.join("appdata"));
        let res = mgr
            .inspect_source(
                "magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862&dn=Big.Buck.Bunny.2008.1080p.mp4&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337",
            )
            .await
            .unwrap();
        assert_eq!(res.info_hash, "cab507494d02ebb1178b38f2e9d7be299c86b862");
        assert_eq!(res.name, "Big.Buck.Bunny.2008.1080p.mp4");
        assert!(res.is_magnet);
        assert!(!res.metadata_ready);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn test_local_swarm_download_http_range_stream_and_seeding_cleanup() {
        let root = temp_test_dir("swarm");
        let seeder_dir = root.join("seeder");
        let leecher_appdata = root.join("leecher_appdata");
        let movies_library = root.join("Movies");
        std::fs::create_dir_all(&seeder_dir).unwrap();
        std::fs::create_dir_all(&movies_library).unwrap();

        // Create a deterministic 256 KiB synthetic MP4 payload to seed locally.
        let src_video = seeder_dir.join("Sintel.2010.1080p.mp4");
        let payload: Vec<u8> = (0..(256 * 1024)).map(|i| ((i * 31 + 7) & 0xff) as u8).collect();
        std::fs::write(&src_video, &payload).unwrap();

        // Spin up an isolated local seeder Session (no DHT/trackers/LSD).
        let seeder_session = Session::new_with_opts(
            seeder_dir.clone(),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                persistence: None,
                listen: Some(ListenerOptions {
                    mode: ListenerMode::TcpOnly,
                    listen_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
                    enable_upnp_port_forwarding: false,
                    ipv4_only: true,
                    ..Default::default()
                }),
                ipv4_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let seeder_addr = seeder_session.listen_addr().expect("seeder listen addr");
        let (created, _seeder_handle) = seeder_session
            .create_and_serve_torrent(
                &src_video,
                CreateTorrentOptions {
                    name: Some("Sintel.2010.1080p.mp4"),
                    piece_length: Some(16 * 1024),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let torrent_file = root.join("sintel.torrent");
        std::fs::write(&torrent_file, created.as_bytes().unwrap()).unwrap();

        // Configure our TorrentManager with local-only settings.
        let mgr = TorrentManager::new(leecher_appdata);
        mgr.configure(TorrentEngineConfig {
            listen_port: 0,
            enable_upnp: false,
            enable_dht: false,
            enable_lsd: false,
            disable_trackers: true,
            max_download_kbps: 0,
            max_upload_kbps: 0,
            peer_limit: 32,
            stream_cache_dir: Some(root.join("stream-cache").to_string_lossy().into_owned()),
        })
        .await
        .unwrap();

        // 1. Inspect `.torrent` file
        let inspected = mgr
            .inspect_source(torrent_file.to_str().unwrap())
            .await
            .unwrap();
        assert!(inspected.metadata_ready);
        assert_eq!(inspected.files.len(), 1);
        assert!(inspected.files[0].is_video);
        assert_eq!(inspected.total_bytes, payload.len() as u64);

        // 2. Add as Download into Movies library with clean subfolder
        let added = mgr
            .add_torrent(
                AddTorrentReq {
                    source: torrent_file.to_str().unwrap().to_string(),
                    is_stream: false,
                    output_folder: Some(movies_library.to_string_lossy().into_owned()),
                    sub_folder: Some("Sintel (2010)".into()),
                    only_files: None,
                    paused: false,
                    initial_peers: Some(vec![format!("127.0.0.1:{}", seeder_addr.port())]),
                },
                None,
            )
            .await
            .unwrap();

        // 3. Immediately open HTTP byte-range stream URL and verify 206 Partial Content!
        let stream_url = mgr.stream_url(&added.info_hash, Some(0)).await.unwrap();
        let client = reqwest::Client::new();
        let range_resp = client
            .get(&stream_url)
            .header("Range", "bytes=100-1123")
            .send()
            .await
            .unwrap();
        assert_eq!(range_resp.status().as_u16(), 206);
        let range_bytes = range_resp.bytes().await.unwrap();
        assert_eq!(range_bytes.len(), 1024);
        assert_eq!(&range_bytes[..], &payload[100..1124]);

        // 4. Wait for full download completion
        let mut finished = false;
        for _ in 0..80 {
            let list = mgr.list_torrents().await;
            if let Some(t) = list.first() {
                if t.finished {
                    finished = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(finished, "torrent should finish downloading from local seeder");

        let downloaded_file = movies_library
            .join("Sintel (2010)")
            .join("Sintel.2010.1080p.mp4");
        assert!(downloaded_file.is_file());
        assert_eq!(std::fs::read(&downloaded_file).unwrap(), payload);

        // 5. Verify `delete_keep_files` (hit-and-run / stop seeding on complete):
        // removes torrent from active session while keeping the downloaded media file intact!
        mgr.action(&added.info_hash, "delete_keep_files")
            .await
            .unwrap();
        assert!(mgr.list_torrents().await.is_empty());
        assert!(downloaded_file.is_file());

        // 6. Add in Stream mode and verify `delete_with_files` purges stream-cache file!
        let stream_added = mgr
            .add_torrent(
                AddTorrentReq {
                    source: torrent_file.to_str().unwrap().to_string(),
                    is_stream: true,
                    output_folder: None,
                    sub_folder: None,
                    only_files: None,
                    paused: false,
                    initial_peers: Some(vec![format!("127.0.0.1:{}", seeder_addr.port())]),
                },
                None,
            )
            .await
            .unwrap();
        for _ in 0..80 {
            if mgr
                .list_torrents()
                .await
                .iter()
                .any(|t| t.info_hash == stream_added.info_hash && t.finished)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let cached_stream_file = PathBuf::from(&stream_added.output_folder)
            .join("Sintel.2010.1080p.mp4");
        assert!(cached_stream_file.is_file());
        mgr.action(&stream_added.info_hash, "delete_with_files")
            .await
            .unwrap();
        assert!(!cached_stream_file.exists());

        seeder_session.stop().await;
        let _ = std::fs::remove_dir_all(&root);
    }
}
