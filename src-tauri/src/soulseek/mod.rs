//! Soulseek, for downloading albums from Browse → Music.
//!
//! One session, logged in with the user's own Soulseek account (from Settings). An album download
//! searches the network for "artist album", keeps only folders that hold every track of the
//! album's tracklist in an allowed audio format (`matching`), downloads the best one (falling
//! back to the next when its owner doesn't send them), checks each file, rewrites the tags, and
//! files the album into the music folder (`library`). Files arrive in a hidden staging folder
//! inside the music folder, so the library never sees half an album.

pub mod library;
pub mod matching;

use library::AlbumRequest;
use matching::{basename, extension, Candidate, Offer, WantTrack};
use serde::Serialize;
use soulseek_rs::{Client, ClientSettings, ClientVersion, DownloadStatus, PeerAddress};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SERVER: (&str, u16) = ("server.slsknet.org", 2242);
/// The hidden folder (inside the music folder) albums are downloaded into before they're filed.
pub const STAGING: &str = ".truongflix-incoming";
const SEARCH_TIME: Duration = Duration::from_secs(12);
/// Copies tried per album before giving up.
const MAX_SOURCES: usize = 4;
/// How long a source may keep the files queued without sending anything.
const QUEUE_PATIENCE: Duration = Duration::from_secs(150);
/// How long a transfer may stall once it has started.
const STALL_PATIENCE: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "offline" | "connecting" | "online" | "error"
    pub state: &'static str,
    pub username: String,
    pub message: String,
}

impl Status {
    fn offline() -> Self {
        Status { state: "offline", username: String::new(), message: String::new() }
    }
}

static SESSION: Mutex<Option<Arc<Client>>> = Mutex::new(None);
static STATUS: Mutex<Option<Status>> = Mutex::new(None);

fn set_status(app: &AppHandle, status: Status) {
    *STATUS.lock().unwrap() = Some(status.clone());
    let _ = app.emit("slsk-status", status);
}

fn session() -> Result<Arc<Client>, String> {
    SESSION.lock().unwrap().clone().ok_or_else(|| "Not connected to Soulseek. Add your Soulseek account in Settings → Music.".to_string())
}

fn valid_username(name: &str) -> bool {
    (1..=30).contains(&name.len()) && name.chars().all(|c| c.is_ascii_graphic() || c == ' ') && name.trim() == name
}

/// The server to use: Soulseek's own, or a local test server (`TRUONGFLIX_SLSK_SERVER=host:port`)
/// in debug builds.
fn server_address() -> PeerAddress {
    if cfg!(debug_assertions) {
        if let Some((host, port)) = std::env::var("TRUONGFLIX_SLSK_SERVER").ok().as_deref().and_then(|s| s.rsplit_once(':')) {
            if let Ok(port) = port.parse() {
                return PeerAddress::new(host.to_string(), port);
            }
        }
    }
    PeerAddress::new(SERVER.0.to_string(), SERVER.1)
}

#[tauri::command]
pub fn slsk_status() -> Status {
    STATUS.lock().unwrap().clone().unwrap_or_else(Status::offline)
}

/// Logs in (replacing any session). `port` is where other users connect to us (0: don't listen;
/// downloads then only work through the server's relayed connections). `shared` folders are
/// offered to other users; empty shares nothing.
#[tauri::command]
pub async fn slsk_connect(app: AppHandle, username: String, password: String, port: u16, shared: Vec<String>) -> Result<Status, String> {
    if !valid_username(&username) {
        return Err("Soulseek usernames are 1–30 letters, digits or symbols, without spaces at either end.".into());
    }
    if password.is_empty() {
        return Err("Enter your Soulseek password.".into());
    }
    let shared: Vec<String> = shared.into_iter().filter(|d| Path::new(d).is_dir()).collect();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        SESSION.lock().unwrap().take();
        set_status(&handle, Status { state: "connecting", username: username.clone(), message: String::new() });
        let attempt = |listen: bool| -> Result<Client, String> {
            let mut client = Client::with_settings(ClientSettings {
                username: username.clone(),
                password: password.clone(),
                server_address: server_address(),
                enable_listen: listen && port != 0,
                listen_port: port,
                shared_directories: shared.clone(),
                accept_children: false,
                version: ClientVersion::default(),
            });
            client.connect().map_err(|e| format!("Couldn’t reach Soulseek: {e}"))?;
            match client.login() {
                Ok(true) => Ok(client),
                Ok(false) => Err("Soulseek didn’t accept that username and password.".into()),
                Err(e) => Err(format!("Soulseek login failed: {e}")),
            }
        };
        // A port that's already in use (another Soulseek app) must not stop the login.
        let result = attempt(true).or_else(|e| if port != 0 && e.starts_with("Couldn’t reach") { attempt(false) } else { Err(e) });
        match result {
            Ok(client) => {
                let client = Arc::new(client);
                *SESSION.lock().unwrap() = Some(client.clone());
                let online = Status { state: "online", username: username.clone(), message: String::new() };
                set_status(&handle, online.clone());
                watch_session(handle, client);
                Ok(online)
            }
            Err(message) => {
                set_status(&handle, Status { state: "error", username, message: message.clone() });
                Err(message)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reports a lost session (logged in elsewhere, connection dropped) and forgets it.
fn watch_session(app: AppHandle, client: Arc<Client>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let current = SESSION.lock().unwrap().as_ref().is_some_and(|c| Arc::ptr_eq(c, &client));
        if !current {
            return;
        }
        if let Some(loss) = client.session_loss() {
            SESSION.lock().unwrap().take();
            let message = match loss {
                soulseek_rs::SessionLoss::Displaced => "Your Soulseek account logged in somewhere else.".to_string(),
                other => format!("Lost the connection to Soulseek: {other}"),
            };
            set_status(&app, Status { state: "error", username: client.username().to_string(), message });
            return;
        }
    });
}

#[tauri::command]
pub fn slsk_disconnect(app: AppHandle) {
    SESSION.lock().unwrap().take();
    set_status(&app, Status::offline());
}

// ---------------------------------------------------------------------------
// Album jobs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub user: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub release_id: String,
    pub album: String,
    pub artist: String,
    pub cover: Option<String>,
    /// "searching" | "queued" | "downloading" | "checking" | "done" | "failed" | "cancelled"
    pub state: String,
    pub message: String,
    pub bytes: u64,
    pub total: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub source: Option<Source>,
    /// Where the album was filed.
    pub path: Option<String>,
}

struct Running {
    job: Job,
    cancel: Arc<AtomicBool>,
}

static JOBS: Mutex<Option<HashMap<String, Running>>> = Mutex::new(None);

/// Updates a job and tells the app (when there is one: tests run jobs without it).
struct Reporter<'a> {
    app: Option<&'a AppHandle>,
    id: &'a str,
}

impl Reporter<'_> {
    fn set(&self, change: impl FnOnce(&mut Job)) {
        let snapshot = {
            let mut jobs = JOBS.lock().unwrap();
            let Some(running) = jobs.get_or_insert_with(HashMap::new).get_mut(self.id) else { return };
            change(&mut running.job);
            running.job.clone()
        };
        if let Some(app) = self.app {
            let _ = app.emit("slsk-job", snapshot);
        }
    }
}

#[tauri::command]
pub fn slsk_jobs() -> Vec<Job> {
    JOBS.lock().unwrap().as_ref().map(|j| j.values().map(|r| r.job.clone()).collect()).unwrap_or_default()
}

#[tauri::command]
pub fn slsk_cancel(id: String) {
    if let Some(running) = JOBS.lock().unwrap().as_ref().and_then(|j| j.get(&id)) {
        running.cancel.store(true, Ordering::SeqCst);
    }
}

/// Forgets a finished, failed or cancelled job.
#[tauri::command]
pub fn slsk_dismiss(id: String) {
    let mut jobs = JOBS.lock().unwrap();
    if let Some(map) = jobs.as_mut() {
        if map.get(&id).is_some_and(|r| matches!(r.job.state.as_str(), "done" | "failed" | "cancelled")) {
            map.remove(&id);
        }
    }
}

/// Starts downloading an album; progress arrives as `slsk-job` events.
#[tauri::command]
pub fn slsk_download_album(app: AppHandle, request: AlbumRequest) -> Result<Job, String> {
    let client = session()?;
    if request.id.is_empty() || request.id.len() > 64 || !request.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid download id".into());
    }
    if request.tracks.is_empty() || request.tracks.len() > 250 {
        return Err("This release has no tracklist to download.".into());
    }
    if !Path::new(&request.destination).is_dir() {
        return Err("Choose a music folder in Settings → Music first.".into());
    }
    let job = Job {
        id: request.id.clone(),
        release_id: request.release_id.clone(),
        album: request.album.clone(),
        artist: request.album_artist.clone(),
        cover: request.cover_url.clone(),
        state: "searching".into(),
        files_total: request.tracks.len(),
        ..Default::default()
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS.lock().unwrap();
        let map = jobs.get_or_insert_with(HashMap::new);
        if map.values().any(|r| r.job.release_id == request.release_id && !matches!(r.job.state.as_str(), "done" | "failed" | "cancelled")) {
            return Err("This album is already downloading.".into());
        }
        map.insert(job.id.clone(), Running { job: job.clone(), cancel: cancel.clone() });
    }
    let _ = app.emit("slsk-job", job.clone());
    std::thread::Builder::new()
        .name("slsk-album".into())
        .spawn(move || {
            let id = request.id.clone();
            let staging = Path::new(&request.destination).join(STAGING).join(&id);
            let report = Reporter { app: Some(&app), id: &id };
            let outcome = run_job(&report, &client, &request, &cancel, &staging);
            let _ = std::fs::remove_dir_all(&staging);
            // Leave no empty staging folder behind.
            let _ = std::fs::remove_dir(Path::new(&request.destination).join(STAGING));
            match outcome {
                Ok(dir) => report.set(|j| {
                    j.state = "done".into();
                    j.message = String::new();
                    j.files_done = j.files_total;
                    j.path = Some(dir.to_string_lossy().into_owned());
                }),
                Err(Stop::Cancelled) => report.set(|j| {
                    j.state = "cancelled".into();
                    j.message = String::new();
                }),
                Err(Stop::Failed(message)) => report.set(|j| {
                    j.state = "failed".into();
                    j.message = message;
                }),
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(job)
}

enum Stop {
    Cancelled,
    Failed(String),
}

fn offers_from(results: Vec<soulseek_rs::SearchResult>) -> Vec<Offer> {
    results
        .into_iter()
        .flat_map(|r| {
            let (free_slot, speed) = (r.slots > 0, r.speed);
            r.files.into_iter().map(move |f| Offer {
                user: f.username,
                path: f.name,
                size: f.size,
                bitrate: f.attribs.get(&0).copied(),
                duration: f.attribs.get(&1).copied(),
                bit_depth: f.attribs.get(&5).copied(),
                free_slot,
                speed,
            })
        })
        .collect()
}

fn run_job(report: &Reporter, client: &Client, req: &AlbumRequest, cancel: &AtomicBool, staging: &Path) -> Result<PathBuf, Stop> {
    let wants: Vec<WantTrack> = req.tracks.iter().map(|t| t.want.clone()).collect();
    let mut candidates: Vec<Candidate> = Vec::new();
    for query in matching::queries(&req.album_artist, &req.album) {
        if cancel.load(Ordering::SeqCst) {
            return Err(Stop::Cancelled);
        }
        let results = client.search(&query, SEARCH_TIME).map_err(|e| Stop::Failed(format!("Soulseek search failed: {e}")))?;
        candidates = matching::rank(&wants, &req.album, &offers_from(results), req.quality);
        if !candidates.is_empty() {
            break;
        }
    }
    if candidates.is_empty() {
        let what = match req.quality {
            matching::Quality::Lossless => "a lossless (FLAC) copy",
            matching::Quality::Mp3 => "an MP3 copy (256 kbps or better)",
            matching::Quality::Any => "a complete copy",
        };
        return Err(Stop::Failed(format!("Couldn’t find {what} of this album on Soulseek right now. Try again later or pick another quality.")));
    }
    let mut last_error = String::new();
    for (n, candidate) in candidates.iter().take(MAX_SOURCES).enumerate() {
        let dir = staging.join(n.to_string());
        let _ = std::fs::remove_dir_all(&dir);
        report.set(|j| {
            j.state = "queued".into();
            j.message = if n == 0 { String::new() } else { format!("Trying another copy ({last_error})") };
            j.bytes = 0;
            j.total = candidate.files.iter().map(|f| f.size).sum();
            j.files_done = 0;
            j.source = Some(Source { user: candidate.user.clone(), format: candidate.format.clone() });
        });
        match fetch(report, client, req, candidate, &dir, cancel) {
            Ok(paths) => {
                report.set(|j| j.state = "checking".into());
                return file_album(req, candidate, &paths).map_err(Stop::Failed);
            }
            Err(Stop::Cancelled) => return Err(Stop::Cancelled),
            Err(Stop::Failed(e)) => {
                last_error = e;
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }
    Err(Stop::Failed(format!("No copy of this album could be downloaded. Last problem: {last_error}")))
}

struct Transfer {
    offer: Offer,
    status: Receiver<DownloadStatus>,
    last: DownloadStatus,
    path: PathBuf,
}

/// Downloads every file of one candidate into `dir/<track index>/`, then checks each one.
fn fetch(report: &Reporter, client: &Client, req: &AlbumRequest, candidate: &Candidate, dir: &Path, cancel: &AtomicBool) -> Result<Vec<PathBuf>, Stop> {
    let mut transfers = Vec::new();
    let cancel_all = |transfers: &[Transfer]| {
        for t in transfers {
            let _ = client.cancel_download(&t.offer.user, &t.offer.path);
        }
    };
    for (i, offer) in candidate.files.iter().enumerate() {
        let target = dir.join(i.to_string());
        if std::fs::create_dir_all(&target).is_err() {
            cancel_all(&transfers);
            return Err(Stop::Failed("Couldn’t create the download folder".into()));
        }
        match client.download(offer.path.clone(), offer.user.clone(), offer.size, target.to_string_lossy().into_owned()) {
            Ok((_, status)) => transfers.push(Transfer { offer: offer.clone(), status, last: DownloadStatus::Queued, path: target.join(basename(&offer.path)) }),
            Err(e) => {
                cancel_all(&transfers);
                return Err(Stop::Failed(format!("Couldn’t start the download: {e}")));
            }
        }
    }
    let mut last_bytes = 0u64;
    let mut last_progress = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        if cancel.load(Ordering::SeqCst) {
            cancel_all(&transfers);
            return Err(Stop::Cancelled);
        }
        for t in transfers.iter_mut() {
            loop {
                match t.status.try_recv() {
                    Ok(status) => t.last = status,
                    Err(TryRecvError::Empty) => break,
                    // The library closes the channel after a final status.
                    Err(TryRecvError::Disconnected) => {
                        if !t.last.is_terminal() {
                            t.last = DownloadStatus::Failed(Some("the transfer stopped".into()));
                        }
                        break;
                    }
                }
            }
        }
        if let Some(t) = transfers.iter().find(|t| matches!(t.last, DownloadStatus::Failed(_) | DownloadStatus::TimedOut | DownloadStatus::Cancelled)) {
            let why = match &t.last {
                DownloadStatus::Failed(Some(reason)) => reason.clone(),
                DownloadStatus::TimedOut => "timed out".into(),
                _ => "refused".into(),
            };
            let message = format!("{} couldn’t send {}: {why}", candidate.user, basename(&t.offer.path));
            cancel_all(&transfers);
            return Err(Stop::Failed(message));
        }
        let bytes: u64 = transfers
            .iter()
            .map(|t| match &t.last {
                DownloadStatus::InProgress { bytes_downloaded, .. } | DownloadStatus::Paused { bytes_downloaded, .. } => *bytes_downloaded,
                DownloadStatus::Completed => t.offer.size,
                _ => 0,
            })
            .sum();
        let done = transfers.iter().filter(|t| matches!(t.last, DownloadStatus::Completed)).count();
        if bytes > last_bytes {
            last_bytes = bytes;
            last_progress = Instant::now();
        }
        if done == transfers.len() {
            break;
        }
        let waiting = bytes == 0;
        let patience = if waiting { QUEUE_PATIENCE } else { STALL_PATIENCE };
        if last_progress.elapsed() > patience {
            cancel_all(&transfers);
            let why = if waiting { "kept the files queued" } else { "stopped sending" };
            return Err(Stop::Failed(format!("{} {why} for too long", candidate.user)));
        }
        if last_emit.elapsed() >= Duration::from_millis(400) {
            last_emit = Instant::now();
            report.set(|j| {
                j.state = if waiting { "queued" } else { "downloading" }.into();
                j.bytes = bytes;
                j.files_done = done;
            });
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    report.set(|j| {
        j.state = "checking".into();
        j.bytes = j.total;
        j.files_done = j.files_total;
    });
    let mut paths = Vec::new();
    for (i, t) in transfers.iter().enumerate() {
        library::verify(&t.path, &extension(&t.offer.path), t.offer.size, req.tracks[i].want.length_ms).map_err(Stop::Failed)?;
        paths.push(t.path.clone());
    }
    Ok(paths)
}

/// Tags each checked file and moves the album into the music folder; returns its folder.
fn file_album(req: &AlbumRequest, candidate: &Candidate, paths: &[PathBuf]) -> Result<PathBuf, String> {
    let cover = req
        .cover_path
        .as_deref()
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() < 8 * 1024 * 1024))
        .and_then(|p| std::fs::read(p).ok());
    for (i, path) in paths.iter().enumerate() {
        library::tag(path, req, i, cover.as_deref())?;
    }
    let dir = library::album_dir(req, &candidate.format);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t create {}: {e}", dir.display()))?;
    for (i, path) in paths.iter().enumerate() {
        let name = library::track_file_name(req, i, &candidate.format);
        library::move_into(path, &dir.join(name))?;
    }
    if let Some(data) = &cover {
        let ext = if data.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else { "jpg" };
        let _ = std::fs::write(dir.join(format!("cover.{ext}")), data);
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::library::{AlbumRequest, RequestTrack};
    use super::matching::{Quality, WantTrack};
    use super::*;
    use lofty::file::TaggedFileExt;
    use lofty::prelude::*;
    use std::net::{TcpListener, TcpStream};
    use std::process::{Command, Stdio};

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn login(server: u16, name: &str, share: Option<&str>) -> Client {
        let mut client = Client::with_settings(ClientSettings {
            username: name.into(),
            password: "pw".into(),
            server_address: PeerAddress::new("127.0.0.1".into(), server),
            enable_listen: true,
            listen_port: free_port(),
            shared_directories: share.map(|s| vec![s.to_string()]).unwrap_or_default(),
            accept_children: false,
            version: ClientVersion::default(),
        });
        client.connect().expect("connect");
        assert!(client.login().expect("login"));
        client
    }

    fn request(dest: &Path, cover: Option<String>, titles: &[(&str, u32)]) -> AlbumRequest {
        AlbumRequest {
            id: "e2e".into(),
            release_id: "itunes:e2e".into(),
            release_mbid: Some("11111111-2222-3333-4444-555555555555".into()),
            cover_url: None,
            release_group_mbid: None,
            album: "Test Album".into(),
            album_artist: "Test Artist".into(),
            album_artist_mbid: None,
            date: Some("2024-03-01".into()),
            genre: Some("Electronic".into()),
            tracks: titles
                .iter()
                .enumerate()
                .map(|(i, (title, secs))| RequestTrack {
                    want: WantTrack { title: (*title).into(), position: i as u32 + 1, disc: 1, length_ms: Some(secs * 1000) },
                    artist: "Test Artist".into(),
                    recording_mbid: None,
                    track_mbid: None,
                })
                .collect(),
            quality: Quality::Lossless,
            destination: dest.to_string_lossy().into_owned(),
            cover_path: cover,
        }
    }

    /// A whole album through a local Soulseek server: one client shares it, ours finds the folder,
    /// downloads only its audio, checks it, tags it and files it.
    /// `SOULFIND_BIN=…/soulfind TRUONGFLIX_SLSK_TEST_SHARE=…/share cargo test --lib -- --ignored real_album_download --nocapture`
    /// (the share holds `Test Artist/Test Album/0N - {Alpha,Beta,Gamma} Song.flac`, 31/47/62 s long).
    #[test]
    #[ignore]
    fn real_album_download_through_soulfind() {
        let bin = std::env::var("SOULFIND_BIN").expect("set SOULFIND_BIN");
        let share = std::env::var("TRUONGFLIX_SLSK_TEST_SHARE").expect("set TRUONGFLIX_SLSK_TEST_SHARE");
        let work = std::env::temp_dir().join(format!("tf-slsk-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let port = free_port();
        let mut server = Command::new(bin)
            .args(["-p", &port.to_string(), "-d", &work.join("server.db").to_string_lossy()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start soulfind");
        let deadline = Instant::now() + Duration::from_secs(10);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "soulfind didn't start");
            std::thread::sleep(Duration::from_millis(100));
        }
        let _sharer = login(port, "tf_sharer", Some(&share));
        let ours = login(port, "tf_user", None);
        std::thread::sleep(Duration::from_secs(1));

        // A real 1×1 PNG as the cover.
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
            0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0, 0x05, 0,
            0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let cover = work.join("cover-in.png");
        std::fs::write(&cover, png).unwrap();
        let dest = work.join("Music");
        std::fs::create_dir_all(&dest).unwrap();
        let cancel = AtomicBool::new(false);
        let report = Reporter { app: None, id: "e2e" };

        let wanted = [("Alpha Song", 31), ("Beta Song", 47), ("Gamma Song", 62)];
        let req = request(&dest, Some(cover.to_string_lossy().into_owned()), &wanted);
        let t = Instant::now();
        let dir = match run_job(&report, &ours, &req, &cancel, &dest.join(STAGING).join("e2e")) {
            Ok(dir) => dir,
            Err(Stop::Failed(e)) => panic!("download failed: {e}"),
            Err(Stop::Cancelled) => panic!("cancelled"),
        };
        println!("album filed in {:?}: {}", t.elapsed(), dir.display());
        assert!(dir.ends_with(Path::new("Test Artist").join("Test Album (2024)")));
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        // Only the songs (and the cover we chose): never the program or the shared "cover.jpg".
        assert_eq!(names, ["01 - Alpha Song.flac", "02 - Beta Song.flac", "03 - Gamma Song.flac", "cover.png"]);
        let tagged = lofty::read_from_path(dir.join("02 - Beta Song.flac")).unwrap();
        let tag = tagged.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Beta Song"));
        assert_eq!(tag.album().as_deref(), Some("Test Album"));
        assert_eq!(tag.track(), Some(2));
        assert_eq!(tag.track_total(), Some(3));
        assert_eq!(tag.get_string(lofty::tag::ItemKey::MusicBrainzReleaseId), Some("11111111-2222-3333-4444-555555555555"));
        assert_eq!(tag.pictures().len(), 1);

        // A tracklist the shared folder can't complete is never downloaded.
        let more = [("Alpha Song", 31), ("Beta Song", 47), ("Gamma Song", 62), ("Delta Song", 50)];
        let req = request(&dest, None, &more);
        match run_job(&report, &ours, &req, &cancel, &dest.join(STAGING).join("e2e2")) {
            Err(Stop::Failed(e)) => assert!(e.contains("Couldn’t find"), "{e}"),
            _ => panic!("an incomplete copy must not be downloaded"),
        }
        // Nor is a copy in another format than the one asked for.
        let mut mp3 = request(&dest, None, &wanted);
        mp3.quality = Quality::Mp3;
        assert!(matches!(run_job(&report, &ours, &mp3, &cancel, &dest.join(STAGING).join("e2e3")), Err(Stop::Failed(_))));

        let _ = server.kill();
        let _ = server.wait();
        let _ = std::fs::remove_dir_all(&work);
    }
}
