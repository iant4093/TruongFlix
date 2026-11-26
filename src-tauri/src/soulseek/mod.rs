//! Soulseek, for downloading albums from Browse → Music.
//!
//! One session, logged in with the user's own Soulseek account (from Settings). An album download
//! searches the network for "artist album" and the album alone at once, keeps only folders that
//! hold every track of the album's tracklist in an allowed audio format (`matching`), and
//! downloads the best one: a file that fails is asked for again, and songs one person can't send
//! come from the next copy in the same format. Each file is checked, retagged, and the album is
//! filed into the music folder (`library`). Files arrive in a hidden staging folder inside the
//! music folder, so the library never sees half an album.
//!
//! People can also search Soulseek themselves and pick a folder: for an album page it's checked
//! against the tracklist and filed as that album; otherwise its audio is kept as it is.

pub mod library;
pub mod matching;

use library::{AlbumRequest, PickedCopy};
use matching::{basename, extension, Candidate, Offer, WantTrack};
use serde::{Deserialize, Serialize};
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
/// A search stops early once it has a few copies ready to send…
const SEARCH_MIN: Duration = Duration::from_secs(6);
/// …or any complete copy at all…
const SEARCH_TIME: Duration = Duration::from_secs(12);
/// …and gives up after this.
const SEARCH_MAX: Duration = Duration::from_secs(20);
/// Copies tried per album before giving up.
const MAX_SOURCES: usize = 6;
/// Times each file is asked for from the same person.
const FILE_TRIES: u32 = 2;
/// How long a source may keep the files queued without sending anything.
const QUEUE_PATIENCE: Duration = Duration::from_secs(150);
/// How long a transfer may stall once it has started.
const STALL_PATIENCE: Duration = Duration::from_secs(90);
/// How long the last files may sit in the queue after the person's others have arrived (the
/// next one normally starts within seconds).
const TAIL_PATIENCE: Duration = Duration::from_secs(45);

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

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Registers a job and runs `work` on its own thread; its outcome becomes the job's final state.
fn spawn_job(
    app: AppHandle,
    job: Job,
    destination: String,
    work: impl FnOnce(&Reporter, &Arc<Client>, &AtomicBool, &Path) -> Result<PathBuf, Stop> + Send + 'static,
) -> Result<Job, String> {
    let client = session()?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS.lock().unwrap();
        let map = jobs.get_or_insert_with(HashMap::new);
        if map.values().any(|r| r.job.release_id == job.release_id && !matches!(r.job.state.as_str(), "done" | "failed" | "cancelled")) {
            return Err("This album is already downloading.".into());
        }
        map.insert(job.id.clone(), Running { job: job.clone(), cancel: cancel.clone() });
    }
    let _ = app.emit("slsk-job", job.clone());
    let id = job.id.clone();
    std::thread::Builder::new()
        .name("slsk-album".into())
        .spawn(move || {
            let staging = Path::new(&destination).join(STAGING).join(&id);
            let report = Reporter { app: Some(&app), id: &id };
            let outcome = work(&report, &client, &cancel, &staging);
            let _ = std::fs::remove_dir_all(&staging);
            // Leave no empty staging folder behind.
            let _ = std::fs::remove_dir(Path::new(&destination).join(STAGING));
            finish(&report, outcome);
        })
        .map_err(|e| e.to_string())?;
    Ok(job)
}

fn finish(report: &Reporter, outcome: Result<PathBuf, Stop>) {
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
}

/// Starts downloading an album; progress arrives as `slsk-job` events.
#[tauri::command]
pub fn slsk_download_album(app: AppHandle, request: AlbumRequest) -> Result<Job, String> {
    if !valid_id(&request.id) {
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
        // A copy picked by hand needs no search.
        state: if request.copy.is_some() { "queued" } else { "searching" }.into(),
        files_total: request.tracks.len(),
        source: request.copy.as_ref().map(|c| Source { user: c.user.clone(), format: String::new() }),
        ..Default::default()
    };
    let destination = request.destination.clone();
    spawn_job(app, job, destination, move |report, client, cancel, staging| run_job(report, client, &request, cancel, staging))
}

/// A shared folder to download as it is, for music the catalogue doesn't describe.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRequest {
    pub id: String,
    pub copy: PickedCopy,
    /// The music folder; the files go into its "Soulseek" folder, keeping their own names and tags.
    pub destination: String,
}

/// Downloads the audio files of a shared folder the user picked, keeping their names and tags.
#[tauri::command]
pub fn slsk_download_folder(app: AppHandle, request: FolderRequest) -> Result<Job, String> {
    if !valid_id(&request.id) {
        return Err("Invalid download id".into());
    }
    if !Path::new(&request.destination).is_dir() {
        return Err("Choose a music folder in Settings → Music first.".into());
    }
    picked_offers(&request.copy).map_err(|e| match e {
        Stop::Failed(m) => m,
        Stop::Cancelled => String::new(),
    })?;
    let job = Job {
        id: request.id.clone(),
        release_id: format!("folder:{}:{}", request.copy.user, request.copy.folder),
        album: basename(&request.copy.folder).to_string(),
        artist: request.copy.user.clone(),
        state: "queued".into(),
        files_total: request.copy.files.len(),
        source: Some(Source { user: request.copy.user.clone(), format: String::new() }),
        ..Default::default()
    };
    let destination = request.destination.clone();
    spawn_job(app, job, destination, move |report, client, cancel, staging| run_folder(report, client, &request, cancel, staging))
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

/// The audio files of a picked folder, as offers. Only audio inside that folder is accepted.
fn picked_offers(copy: &PickedCopy) -> Result<Vec<Offer>, Stop> {
    if !valid_username(&copy.user) || copy.files.is_empty() || copy.files.len() > 300 {
        return Err(Stop::Failed("That folder can’t be downloaded.".into()));
    }
    let prefix = copy.folder.trim_end_matches(['\\', '/']);
    let mut seen = std::collections::HashSet::new();
    let mut offers = Vec::new();
    for f in &copy.files {
        let inside = prefix.is_empty() || (f.path.len() > prefix.len() + 1 && f.path.starts_with(prefix) && matches!(f.path.as_bytes()[prefix.len()], b'\\' | b'/'));
        if !inside || !matching::AUDIO.contains(&extension(&f.path).as_str()) || f.size == 0 {
            return Err(Stop::Failed(format!("{} isn’t an audio file in that folder.", basename(&f.path))));
        }
        if seen.insert(f.path.clone()) {
            offers.push(Offer {
                user: copy.user.clone(),
                path: f.path.clone(),
                size: f.size,
                bitrate: f.bitrate,
                duration: f.duration,
                bit_depth: f.bit_depth,
                free_slot: true,
                speed: 0,
            });
        }
    }
    Ok(offers)
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/// Queries in flight. The library files results by query, so everything searching for the same
/// words shares one search, and its results are dropped once the last one is done with them.
static QUERIES: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

struct Searching<'a> {
    client: &'a Client,
    queries: Vec<String>,
}

impl<'a> Searching<'a> {
    fn start(client: &'a Client, queries: Vec<String>) -> Result<Self, String> {
        let mut searching = Searching { client, queries: Vec::new() };
        for query in queries {
            let fresh = {
                let mut map = QUERIES.lock().unwrap();
                let n = map.get_or_insert_with(HashMap::new).entry(query.clone()).or_insert(0);
                *n += 1;
                *n == 1
            };
            searching.queries.push(query.clone());
            if fresh {
                // Sends the search and returns at once; results collect in the background.
                client.search(&query, Duration::ZERO).map_err(|e| format!("Soulseek search failed: {e}"))?;
            }
        }
        Ok(searching)
    }

    /// Every file found so far, each once.
    fn offers(&self) -> Vec<Offer> {
        let mut seen = std::collections::HashSet::new();
        self.queries
            .iter()
            .flat_map(|q| offers_from(self.client.get_search_results(q)))
            .filter(|o| seen.insert((o.user.clone(), o.path.clone())))
            .collect()
    }
}

impl Drop for Searching<'_> {
    fn drop(&mut self) {
        let mut map = QUERIES.lock().unwrap();
        let map = map.get_or_insert_with(HashMap::new);
        for query in &self.queries {
            if let Some(n) = map.get_mut(query) {
                *n -= 1;
                if *n == 0 {
                    map.remove(query);
                    let _ = self.client.forget_search(query);
                }
            }
        }
    }
}

/// The phrase Soulseek blocks that this text contains, if any. Users' clients leave files
/// matching these out of every search reply, so such music can't be found there at all.
fn blocked_phrase(client: &Client, text: &str) -> Option<String> {
    let text = text.to_lowercase();
    client.excluded_search_phrases().into_iter().find(|p| {
        let p = p.trim().to_lowercase();
        !p.is_empty() && text.contains(&p)
    })
}

/// Sleeps `total`, waking early when cancelled.
fn wait(total: Duration, cancel: &AtomicBool) -> Result<(), Stop> {
    let until = Instant::now() + total;
    while Instant::now() < until {
        if cancel.load(Ordering::SeqCst) {
            return Err(Stop::Cancelled);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// Searches Soulseek (every query at once) until there are enough complete copies to choose
/// from, or the search has run its course.
fn find_copies(client: &Client, req: &AlbumRequest, wants: &[WantTrack], cancel: &AtomicBool) -> Result<Vec<Candidate>, Stop> {
    if let Some(phrase) = blocked_phrase(client, &format!("{} {}", req.album_artist, req.album)) {
        return Err(Stop::Failed(format!("Soulseek blocks searches for “{phrase}”, so this album can’t be found there.")));
    }
    let queries = matching::queries(&req.album_artist, &req.album);
    let search = Searching::start(client, queries.clone()).map_err(Stop::Failed)?;
    let started = Instant::now();
    loop {
        wait(Duration::from_secs(1), cancel)?;
        let offers = search.offers();
        let candidates = matching::rank(wants, &req.album, &offers, req.quality);
        let t = started.elapsed();
        let free = candidates.iter().filter(|c| c.files.first().is_some_and(|f| f.free_slot)).count();
        // Answers keep arriving for a while, and the late ones are often the better copies; but
        // a few ready-to-send copies are plenty.
        let enough = (t >= SEARCH_MIN && free >= 3) || (t >= SEARCH_TIME && !candidates.is_empty()) || t >= SEARCH_MAX;
        if !enough {
            continue;
        }
        if !candidates.is_empty() {
            return Ok(candidates);
        }
        return Err(Stop::Failed(not_found(req, wants, &offers, &queries)));
    }
}

/// Why no copy was good enough, as specifically as the search results allow.
fn not_found(req: &AlbumRequest, wants: &[WantTrack], offers: &[Offer], queries: &[String]) -> String {
    let audio: Vec<&Offer> = offers.iter().filter(|o| matching::AUDIO.contains(&extension(&o.path).as_str())).collect();
    if audio.is_empty() {
        let searched = queries.first().map(|q| format!(" (searched for “{q}”)")).unwrap_or_default();
        return format!("Nobody on Soulseek is sharing this album right now{searched}. Try again later, or search Soulseek yourself.");
    }
    if req.quality != matching::Quality::Any && !matching::rank(wants, &req.album, offers, matching::Quality::Any).is_empty() {
        let what = match req.quality {
            matching::Quality::Lossless => "lossless (FLAC)",
            _ => "MP3 (256 kbps or better)",
        };
        return format!("There are complete copies of this album, but none in {what}. Pick another quality, or choose a copy yourself.");
    }
    let mut folders: HashMap<(&str, &str), Vec<Offer>> = HashMap::new();
    for o in &audio {
        folders.entry((o.user.as_str(), matching::album_folder(&o.path))).or_default().push((*o).clone());
    }
    let best = folders.values().map(|files| matching::coverage(wants, files)).max().unwrap_or(0);
    format!(
        "Found {} cop{} on Soulseek, but none with all {} songs of this edition (the closest had {best}). Choose a copy yourself to download one anyway.",
        folders.len(),
        if folders.len() == 1 { "y" } else { "ies" },
        wants.len()
    )
}

// ---------------------------------------------------------------------------
// Searching by hand
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HitFile {
    pub path: String,
    pub size: u64,
    pub bitrate: Option<u32>,
    pub duration: Option<u32>,
    pub bit_depth: Option<u32>,
}

/// One shared folder in a search by hand: its audio files, and (for an album) how many of the
/// album's songs it has.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderHit {
    pub user: String,
    pub folder: String,
    pub format: String,
    pub files: Vec<HitFile>,
    pub size: u64,
    pub free_slot: bool,
    pub speed: u32,
    pub matched: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchUpdate {
    id: String,
    folders: Vec<FolderHit>,
    people: usize,
    done: bool,
    blocked: Option<String>,
}

static MANUAL: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);
const MANUAL_TIME: Duration = Duration::from_secs(25);
const MANUAL_FOLDERS: usize = 150;

fn format_rank(ext: &str) -> u8 {
    match ext {
        "flac" => 4,
        "mp3" => 3,
        "m4a" => 2,
        _ => 1,
    }
}

/// Groups search results into folders of audio, best first: most of the album's songs, then
/// ready to send, then quality and speed.
fn folder_hits(offers: &[Offer], tracks: Option<&[WantTrack]>) -> Vec<FolderHit> {
    let mut groups: HashMap<(String, String), Vec<Offer>> = HashMap::new();
    for o in offers {
        if matching::AUDIO.contains(&extension(&o.path).as_str()) && o.size > 0 {
            groups.entry((o.user.clone(), matching::album_folder(&o.path).to_string())).or_default().push(o.clone());
        }
    }
    let mut hits: Vec<FolderHit> = groups
        .into_iter()
        .filter(|(_, files)| files.len() <= 300)
        .map(|((user, folder), mut files)| {
            files.sort_by(|a, b| a.path.cmp(&b.path));
            let mut counts: HashMap<String, usize> = HashMap::new();
            for f in &files {
                *counts.entry(extension(&f.path)).or_default() += 1;
            }
            let format = counts.into_iter().max_by_key(|(ext, n)| (*n, format_rank(ext))).map(|(e, _)| e).unwrap_or_default();
            FolderHit {
                matched: tracks.map(|t| matching::coverage(t, &files)),
                user,
                folder,
                format,
                size: files.iter().map(|f| f.size).sum(),
                free_slot: files[0].free_slot,
                speed: files[0].speed,
                files: files.into_iter().map(|f| HitFile { path: f.path, size: f.size, bitrate: f.bitrate, duration: f.duration, bit_depth: f.bit_depth }).collect(),
            }
        })
        .collect();
    hits.sort_by(|a, b| {
        b.matched
            .cmp(&a.matched)
            .then(b.free_slot.cmp(&a.free_slot))
            .then(format_rank(&b.format).cmp(&format_rank(&a.format)))
            .then(b.speed.cmp(&a.speed))
            .then(a.user.cmp(&b.user))
    });
    hits.truncate(MANUAL_FOLDERS);
    hits
}

/// Searches Soulseek for `query`; folders arrive as `slsk-search` events for about 25 seconds.
/// With `tracks` (an album's tracklist), each folder says how many of its songs it has.
#[tauri::command]
pub fn slsk_search(app: AppHandle, id: String, query: String, tracks: Option<Vec<WantTrack>>) -> Result<(), String> {
    let client = session()?;
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if !valid_id(&id) || query.is_empty() || query.len() > 200 {
        return Err("Type what to search for.".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = MANUAL.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), stop.clone()) {
        old.store(true, Ordering::SeqCst);
    }
    std::thread::Builder::new()
        .name("slsk-search".into())
        .spawn(move || {
            let send = |folders: Vec<FolderHit>, people: usize, done: bool, blocked: Option<String>| {
                let _ = app.emit("slsk-search", SearchUpdate { id: id.clone(), folders, people, done, blocked });
            };
            if let Some(phrase) = blocked_phrase(&client, &query) {
                send(Vec::new(), 0, true, Some(phrase));
            } else if let Ok(search) = Searching::start(&client, vec![query]) {
                let started = Instant::now();
                loop {
                    let stopped = wait(Duration::from_millis(1200), &stop).is_err();
                    let offers = search.offers();
                    let people = offers.iter().map(|o| o.user.as_str()).collect::<std::collections::HashSet<_>>().len();
                    let done = stopped || started.elapsed() >= MANUAL_TIME;
                    send(folder_hits(&offers, tracks.as_deref()), people, done, None);
                    if done {
                        break;
                    }
                }
            } else {
                send(Vec::new(), 0, true, None);
            }
            let mut manual = MANUAL.lock().unwrap();
            let map = manual.get_or_insert_with(HashMap::new);
            if map.get(&id).is_some_and(|s| Arc::ptr_eq(s, &stop)) {
                map.remove(&id);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn slsk_search_stop(id: String) {
    if let Some(stop) = MANUAL.lock().unwrap().as_ref().and_then(|m| m.get(&id)) {
        stop.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

fn run_job(report: &Reporter, client: &Client, req: &AlbumRequest, cancel: &AtomicBool, staging: &Path) -> Result<PathBuf, Stop> {
    let wants: Vec<WantTrack> = req.tracks.iter().map(|t| t.want.clone()).collect();
    let candidates = match &req.copy {
        // A copy the user chose: it must still be this album, in any format.
        Some(copy) => {
            let offers = picked_offers(copy)?;
            let found = matching::rank(&wants, &req.album, &offers, matching::Quality::Any);
            if found.is_empty() {
                return Err(Stop::Failed("That copy doesn’t have every song of this album, so it can’t be filed as this album. Download it as it is instead.".into()));
            }
            found.into_iter().take(1).collect()
        }
        None => find_copies(client, req, &wants, cancel)?,
    };
    let mut got: Vec<Option<(PathBuf, u64)>> = vec![None; wants.len()];
    let mut format: Option<String> = None;
    let mut last_error = String::new();
    let mut tried = 0;
    for (k, candidate) in candidates.iter().enumerate() {
        let have = got.iter().flatten().count();
        // An album is never a mix of formats: once songs have arrived, only copies in the same
        // format can finish it.
        if tried == MAX_SOURCES || (have > 0 && format.as_deref() != Some(candidate.format.as_str())) {
            continue;
        }
        tried += 1;
        let items: Vec<Item> = (0..wants.len())
            .filter(|&i| got[i].is_none())
            .map(|i| Item { index: i, offer: candidate.files[i].clone(), length_ms: wants[i].length_ms })
            .collect();
        let base: u64 = got.iter().flatten().map(|(_, size)| size).sum();
        report.set(|j| {
            j.state = "queued".into();
            j.message = match (k, have) {
                (0, _) => String::new(),
                (_, 0) => format!("Trying another copy ({last_error})"),
                _ if items.len() == 1 => format!("Getting the last song from another copy ({last_error})"),
                _ => format!("Getting the other {} songs from another copy ({last_error})", items.len()),
            };
            j.bytes = base;
            j.total = base + items.iter().map(|i| i.offer.size).sum::<u64>();
            j.files_done = have;
            j.source = Some(Source { user: candidate.user.clone(), format: candidate.format.clone() });
        });
        let result = fetch(report, client, &candidate.user, &items, &staging.join(k.to_string()), cancel, &mut got, base);
        if got.iter().any(Option::is_some) {
            format = Some(candidate.format.clone());
        }
        match result {
            Ok(()) => break,
            Err(Stop::Cancelled) => return Err(Stop::Cancelled),
            Err(Stop::Failed(e)) => last_error = e,
        }
    }
    let have = got.iter().flatten().count();
    let Some(paths) = got.into_iter().map(|g| g.map(|(p, _)| p)).collect::<Option<Vec<_>>>() else {
        return Err(Stop::Failed(if have > 0 {
            format!("Got {have} of {} songs, but nobody could send the rest. Last problem: {last_error}", wants.len())
        } else {
            format!("No copy of this album could be downloaded. Last problem: {last_error}")
        }));
    };
    report.set(|j| j.state = "checking".into());
    file_album(req, format.as_deref().unwrap_or("flac"), &paths).map_err(Stop::Failed)
}

/// Downloads a picked folder as it is into `<music folder>/Soulseek/<folder>/`.
fn run_folder(report: &Reporter, client: &Client, req: &FolderRequest, cancel: &AtomicBool, staging: &Path) -> Result<PathBuf, Stop> {
    let items: Vec<Item> = picked_offers(&req.copy)?.into_iter().enumerate().map(|(index, offer)| Item { index, offer, length_ms: None }).collect();
    let mut got = vec![None; items.len()];
    report.set(|j| {
        j.total = items.iter().map(|i| i.offer.size).sum();
        j.source = Some(Source { user: req.copy.user.clone(), format: items.first().map(|i| extension(&i.offer.path)).unwrap_or_default() });
    });
    fetch(report, client, &req.copy.user, &items, &staging.join("0"), cancel, &mut got, 0)?;
    report.set(|j| j.state = "checking".into());
    let base = Path::new(&req.destination).join("Soulseek");
    let name = library::safe_name(basename(&req.copy.folder));
    let dir = std::iter::once(base.join(&name)).chain((2..).map(|n| base.join(format!("{name} ({n})")))).find(|p| !p.exists()).unwrap();
    let prefix = req.copy.folder.trim_end_matches(['\\', '/']);
    for (item, got) in items.iter().zip(got) {
        let Some((from, _)) = got else { continue };
        let relative = item.offer.path.get(prefix.len()..).unwrap_or(basename(&item.offer.path));
        let to = relative.split(['\\', '/']).filter(|p| !p.is_empty()).fold(dir.clone(), |d, part| d.join(library::safe_name(part)));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Stop::Failed(format!("Couldn’t create {}: {e}", parent.display())))?;
        }
        library::move_into(&from, &to).map_err(Stop::Failed)?;
    }
    Ok(dir)
}

/// One file to fetch: which track (or file) it is, from whom, and how long it should play.
struct Item {
    index: usize,
    offer: Offer,
    length_ms: Option<u32>,
}

struct Transfer<'a> {
    item: &'a Item,
    status: Receiver<DownloadStatus>,
    last: DownloadStatus,
    path: PathBuf,
    tries: u32,
    done: bool,
    dead: Option<String>,
}

/// Asks for one file (again, after a failure) into its own folder.
fn request_file(client: &Client, item: &Item, dir: &Path) -> Result<(Receiver<DownloadStatus>, PathBuf), String> {
    let target = dir.join(item.index.to_string());
    std::fs::create_dir_all(&target).map_err(|_| "Couldn’t create the download folder".to_string())?;
    let path = target.join(basename(&item.offer.path));
    let _ = std::fs::remove_file(&path);
    let _ = client.remove_download(&item.offer.user, &item.offer.path);
    client
        .download(item.offer.path.clone(), item.offer.user.clone(), item.offer.size, target.to_string_lossy().into_owned())
        .map(|(_, status)| (status, path))
        .map_err(|e| format!("Couldn’t start the download: {e}"))
}

/// Downloads `items` from one person, checking each file as it arrives (into `got`). A file that
/// fails is asked for once more; the person's other files carry on regardless. Fails (keeping
/// what arrived) when a file can't be had, or when they don't send for too long.
#[allow(clippy::too_many_arguments)]
fn fetch(report: &Reporter, client: &Client, user: &str, items: &[Item], dir: &Path, cancel: &AtomicBool, got: &mut [Option<(PathBuf, u64)>], base: u64) -> Result<(), Stop> {
    let mut transfers: Vec<Transfer> = Vec::new();
    let cancel_live = |transfers: &[Transfer]| {
        for t in transfers.iter().filter(|t| !t.done && t.dead.is_none()) {
            let _ = client.cancel_download(&t.item.offer.user, &t.item.offer.path);
        }
    };
    for item in items {
        match request_file(client, item, dir) {
            Ok((status, path)) => transfers.push(Transfer { item, status, last: DownloadStatus::Queued, path, tries: 1, done: false, dead: None }),
            Err(e) => {
                cancel_live(&transfers);
                return Err(Stop::Failed(e));
            }
        }
    }
    let mut last_bytes = 0u64;
    let mut last_progress = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        if cancel.load(Ordering::SeqCst) {
            cancel_live(&transfers);
            return Err(Stop::Cancelled);
        }
        for t in transfers.iter_mut().filter(|t| !t.done && t.dead.is_none()) {
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
            let name = basename(&t.item.offer.path);
            let problem = match &t.last {
                DownloadStatus::Completed => match library::verify(&t.path, &extension(&t.item.offer.path), t.item.offer.size, t.item.length_ms) {
                    Ok(()) => {
                        t.done = true;
                        got[t.item.index] = Some((t.path.clone(), t.item.offer.size));
                        continue;
                    }
                    Err(e) => e,
                },
                DownloadStatus::Failed(Some(reason)) => format!("{user} couldn’t send {name}: {reason}"),
                DownloadStatus::Failed(None) | DownloadStatus::Cancelled => format!("{user} refused {name}"),
                DownloadStatus::TimedOut => format!("{user} couldn’t send {name}: timed out"),
                _ => continue,
            };
            // Uploads often fail once and then go through.
            if t.tries < FILE_TRIES {
                match request_file(client, t.item, dir) {
                    Ok((status, path)) => {
                        t.status = status;
                        t.path = path;
                        t.last = DownloadStatus::Queued;
                        t.tries += 1;
                        last_progress = Instant::now();
                        last_bytes = 0;
                    }
                    Err(e) => t.dead = Some(e),
                }
            } else {
                t.dead = Some(problem);
            }
        }
        let live = || transfers.iter().filter(|t| t.dead.is_none());
        let sent: u64 = live()
            .map(|t| match &t.last {
                _ if t.done => t.item.offer.size,
                DownloadStatus::InProgress { bytes_downloaded, .. } | DownloadStatus::Paused { bytes_downloaded, .. } => *bytes_downloaded,
                _ => 0,
            })
            .sum();
        if sent > last_bytes {
            last_bytes = sent;
            last_progress = Instant::now();
        }
        if transfers.iter().all(|t| t.done || t.dead.is_some()) {
            break;
        }
        let waiting = sent == 0;
        let tail = transfers.iter().any(|t| t.done)
            && transfers.iter().filter(|t| !t.done && t.dead.is_none()).all(|t| matches!(t.last, DownloadStatus::Queued));
        let patience = if waiting {
            QUEUE_PATIENCE
        } else if tail {
            TAIL_PATIENCE
        } else {
            STALL_PATIENCE
        };
        if last_progress.elapsed() > patience {
            cancel_live(&transfers);
            let why = if waiting { "kept the files queued" } else { "stopped sending" };
            return Err(Stop::Failed(format!("{user} {why} for too long")));
        }
        if last_emit.elapsed() >= Duration::from_millis(400) {
            last_emit = Instant::now();
            let files_done = got.iter().flatten().count();
            report.set(|j| {
                j.state = if waiting { "queued" } else { "downloading" }.into();
                j.bytes = base + sent;
                j.files_done = files_done;
            });
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Some(problem) = transfers.iter().find_map(|t| t.dead.clone()) {
        return Err(Stop::Failed(problem));
    }
    Ok(())
}

/// Tags each checked file and moves the album into the music folder; returns its folder.
fn file_album(req: &AlbumRequest, format: &str, paths: &[PathBuf]) -> Result<PathBuf, String> {
    let cover = req
        .cover_path
        .as_deref()
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() < 8 * 1024 * 1024))
        .and_then(|p| std::fs::read(p).ok());
    for (i, path) in paths.iter().enumerate() {
        library::tag(path, req, i, cover.as_deref())?;
    }
    let dir = library::album_dir(req, format);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t create {}: {e}", dir.display()))?;
    for (i, path) in paths.iter().enumerate() {
        let name = library::track_file_name(req, i, format);
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
            copy: None,
        }
    }

    fn offer(user: &str, path: &str, secs: u32) -> Offer {
        Offer { user: user.into(), path: path.into(), size: 20_000_000, bitrate: None, duration: Some(secs), bit_depth: Some(16), free_slot: user != "busy", speed: 100 }
    }

    fn wants() -> Vec<WantTrack> {
        vec![
            WantTrack { title: "One".into(), position: 1, disc: 1, length_ms: Some(200_000) },
            WantTrack { title: "Two".into(), position: 2, disc: 1, length_ms: Some(180_000) },
        ]
    }

    #[test]
    fn search_results_become_folders_of_audio_best_first() {
        let offers = vec![
            offer("busy", "m/Album/01 - One.flac", 200),
            offer("busy", "m/Album/02 - Two.flac", 180),
            offer("half", "x/Album/01 - One.mp3", 200),
            offer("half", "x/Album/cover.jpg", 0),
            offer("full", "y/Album/CD1/01 - One.flac", 200),
            offer("full", "y/Album/CD1/02 - Two.flac", 180),
            offer("full", "y/Album/setup.exe", 0),
        ];
        let hits = folder_hits(&offers, Some(&wants()));
        // Complete copies first, ready-to-send before queued; disc folders join their album; only audio is listed.
        let order: Vec<(&str, &str, Option<usize>, usize)> = hits.iter().map(|h| (h.user.as_str(), h.folder.as_str(), h.matched, h.files.len())).collect();
        assert_eq!(order, [("full", "y/Album", Some(2), 2), ("busy", "m/Album", Some(2), 2), ("half", "x/Album", Some(1), 1)]);
        assert_eq!(hits[2].format, "mp3");
        assert!(folder_hits(&offers, None).iter().all(|h| h.matched.is_none()));
    }

    #[test]
    fn a_picked_folder_gives_only_its_own_audio() {
        let file = |path: &str| library::PickedFile { path: path.into(), size: 10, bitrate: None, duration: None, bit_depth: None };
        let copy = |files: Vec<library::PickedFile>| PickedCopy { user: "someone".into(), folder: r"music\Album".into(), files };
        assert_eq!(picked_offers(&copy(vec![file(r"music\Album\01 - One.flac"), file(r"music\Album\CD2\01 - One.flac")])).ok().map(|o| o.len()), Some(2));
        // Nothing outside the folder, nothing that isn't audio.
        for bad in [r"music\Other\01.flac", "music/Album/setup.exe", r"music\AlbumX\01.flac"] {
            assert!(picked_offers(&copy(vec![file(bad)])).is_err(), "{bad}");
        }
        assert!(picked_offers(&copy(Vec::new())).is_err());
    }

    #[test]
    fn not_found_says_what_was_there() {
        let mut req = super::tests::request(Path::new("."), None, &[("One", 200), ("Two", 180)]);
        let queries = vec!["artist album".to_string()];
        assert!(not_found(&req, &wants(), &[], &queries).starts_with("Nobody on Soulseek is sharing this album right now (searched for “artist album”)"));
        let mp3 = vec![offer("a", "x/Album/01 - One.mp3", 200), offer("a", "x/Album/02 - Two.mp3", 180)];
        assert!(not_found(&req, &wants(), &mp3, &queries).contains("none in lossless (FLAC)"));
        let half = vec![offer("a", "x/Album/01 - One.flac", 200), offer("b", "y/Album/02 - Two.flac", 180)];
        assert_eq!(
            not_found(&req, &wants(), &half, &queries),
            "Found 2 copies on Soulseek, but none with all 2 songs of this edition (the closest had 1). Choose a copy yourself to download one anyway."
        );
        req.quality = Quality::Any;
        assert!(not_found(&req, &wants(), &half, &queries).starts_with("Found 2 copies"));
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
        // The server goes when the test does, passed or not.
        struct Server(std::process::Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let _server = Server(Command::new(bin)
            .args(["-p", &port.to_string(), "-d", &work.join("server.db").to_string_lossy()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start soulfind"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "soulfind didn't start");
            std::thread::sleep(Duration::from_millis(100));
        }
        let sharer = login(port, "tf_sharer", Some(&share));
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
            Err(Stop::Failed(e)) => assert!(e.contains("none with all 4 songs") && e.contains("the closest had 3"), "{e}"),
            _ => panic!("an incomplete copy must not be downloaded"),
        }
        // Nor is a copy in another format than the one asked for.
        let mut mp3 = request(&dest, None, &wanted);
        mp3.quality = Quality::Mp3;
        match run_job(&report, &ours, &mp3, &cancel, &dest.join(STAGING).join("e2e3")) {
            Err(Stop::Failed(e)) => assert!(e.contains("none in MP3"), "{e}"),
            _ => panic!("a copy in another format must not be downloaded"),
        }

        // Someone whose copy can't send one of the songs: the other two come from them, and the
        // missing one from the next copy (someone else's, with a bonus song that ranks it second).
        drop(sharer);
        let album_dir = Path::new(&share).join("Test Artist").join("Test Album");
        let share_a = work.join("share-a").join("Test Artist").join("Test Album");
        let share_b = work.join("share-b").join("Rips").join("Test Artist - Test Album");
        for dir in [&share_a, &share_b] {
            std::fs::create_dir_all(dir).unwrap();
            for name in ["01 - Alpha Song.flac", "02 - Beta Song.flac", "03 - Gamma Song.flac"] {
                std::fs::copy(album_dir.join(name), dir.join(name)).unwrap();
            }
        }
        std::fs::copy(album_dir.join("01 - Alpha Song.flac"), share_b.join("04 - Bonus Song.flac")).unwrap();
        let _a = login(port, "tf_a", Some(&work.join("share-a").to_string_lossy()));
        let _b = login(port, "tf_b", Some(&work.join("share-b").to_string_lossy()));
        std::thread::sleep(Duration::from_secs(1));
        std::fs::remove_file(share_a.join("03 - Gamma Song.flac")).unwrap();
        JOBS.lock().unwrap().get_or_insert_with(HashMap::new).insert(
            "e2e-mix".into(),
            Running { job: Job { id: "e2e-mix".into(), ..Default::default() }, cancel: Arc::new(AtomicBool::new(false)) },
        );
        let mixed = Reporter { app: None, id: "e2e-mix" };
        let mut req = request(&dest, None, &wanted);
        req.release_mbid = None;
        let t = Instant::now();
        let dir = match run_job(&mixed, &ours, &req, &cancel, &dest.join(STAGING).join("e2e4")) {
            Ok(dir) => dir,
            Err(Stop::Failed(e)) => panic!("download with a fallback failed: {e}"),
            Err(Stop::Cancelled) => panic!("cancelled"),
        };
        let job = JOBS.lock().unwrap().as_ref().unwrap()["e2e-mix"].job.clone();
        println!("album with one song from another copy filed in {:?}: {} ({})", t.elapsed(), dir.display(), job.message);
        assert!(job.message.starts_with("Getting the last song from another copy"), "{}", job.message);
        assert_eq!(job.source.unwrap().user, "tf_b");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3);

        // A folder picked by hand, downloaded as it is: only its audio, with its own names.
        let search = Searching::start(&ours, vec!["test album".into()]).unwrap();
        std::thread::sleep(Duration::from_secs(3));
        let hits = folder_hits(&search.offers(), Some(&req.tracks.iter().map(|t| t.want.clone()).collect::<Vec<_>>()));
        drop(search);
        let hit = hits.iter().find(|h| h.user == "tf_b").expect("the second sharer's folder");
        assert_eq!((hit.matched, hit.files.len(), hit.format.as_str()), (Some(3), 4, "flac"));
        assert_eq!(hits.iter().find(|h| h.user == "tf_a").and_then(|h| h.matched), Some(3));
        let folder = FolderRequest {
            id: "e2e-folder".into(),
            copy: PickedCopy {
                user: hit.user.clone(),
                folder: hit.folder.clone(),
                files: hit.files.iter().map(|f| library::PickedFile { path: f.path.clone(), size: f.size, bitrate: f.bitrate, duration: f.duration, bit_depth: f.bit_depth }).collect(),
            },
            destination: dest.to_string_lossy().into_owned(),
        };
        let dir = match run_folder(&report, &ours, &folder, &cancel, &dest.join(STAGING).join("e2e5")) {
            Ok(dir) => dir,
            Err(Stop::Failed(e)) => panic!("folder download failed: {e}"),
            Err(Stop::Cancelled) => panic!("cancelled"),
        };
        assert_eq!(dir, dest.join("Soulseek").join("Test Artist - Test Album"));
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["01 - Alpha Song.flac", "02 - Beta Song.flac", "03 - Gamma Song.flac", "04 - Bonus Song.flac"]);

        let _ = std::fs::remove_dir_all(&work);
    }
}
