//! Music library: walks the music folders, reads each audio file's tags (title, artists, album,
//! track/disc, year, genre, duration, codec), caches embedded or folder cover art, and picks up
//! embedded or sidecar `.lrc` lyrics. Synced lyrics can also be looked up online (NetEase Cloud Music, then LRCLIB).
//!
//! Covers are written to `<app cache>/music-art/<name>` where `name` is a keyed hash of the image
//! (the key is random per install), so the media server can serve them to the browser app without
//! making the names guessable.

use crate::scanner::is_hidden_or_system;
use lofty::config::ParseOptions;
use lofty::file::{AudioFile, TaggedFile};
use lofty::prelude::*;
use lofty::picture::{MimeType, PictureType};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

pub(crate) const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav"];
const FOLDER_COVERS: &[&str] = &["cover", "folder", "front", "album", "albumart"];
const MAX_LYRICS_BYTES: u64 = 256 * 1024;
const MAX_COVER_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
pub struct MusicFile {
    pub file_path: String,
    pub file_size: u64,
    pub mtime: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub track_no: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_no: Option<u32>,
    pub disc_total: Option<u32>,
    pub year: Option<u16>,
    pub duration: f64,
    /// "mp3" | "flac" | "aac" | "alac" | "vorbis" | "opus" | "wav" | …
    pub codec: String,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub bitrate: Option<u32>,
    pub channels: Option<u8>,
    /// File name of the cached cover in the music-art folder.
    pub cover: Option<String>,
    /// LRC (synced) or plain lyrics text.
    pub lyrics: Option<String>,
    /// "sidecar" | "embedded"
    pub lyrics_source: Option<String>,
    /// Tags couldn't be read (the file still plays; the name is used as its title).
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MusicScan {
    /// Every audio file found (including unchanged ones), so the library can drop removed files.
    pub seen: Vec<String>,
    /// New or changed files with their tags.
    pub changed: Vec<MusicFile>,
}

pub(crate) fn has_audio_extension(path: &Path) -> bool {
    path.extension()
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_string_lossy().to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn clean(s: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
    s.map(|v| v.trim().trim_matches('\0').to_string()).filter(|v| !v.is_empty())
}

fn clean_str(s: Option<&str>) -> Option<String> {
    s.map(|v| v.trim().trim_matches('\0').to_string()).filter(|v| !v.is_empty())
}

/// LRC text has at least one `[mm:ss…]` line timestamp.
pub(crate) fn looks_synced(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim_start();
        let Some(rest) = l.strip_prefix('[') else { return false };
        let Some((stamp, _)) = rest.split_once(']') else { return false };
        let Some((m, s)) = stamp.split_once(':') else { return false };
        !m.is_empty() && m.chars().all(|c| c.is_ascii_digit()) && s.chars().next().is_some_and(|c| c.is_ascii_digit())
    })
}

// ---------------------------------------------------------------------------
// Cover cache
// ---------------------------------------------------------------------------

/// `<app cache>/music-art`.
pub(crate) fn art_dir(app: &AppHandle) -> PathBuf {
    app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir()).join("music-art")
}

static ART_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Remembered for the media server (which serves `/music-art/<name>`).
pub(crate) fn served_art_dir() -> Option<&'static PathBuf> {
    ART_DIR.get()
}

pub fn init(app: &AppHandle) {
    let _ = ART_DIR.set(art_dir(app));
}

/// A random per-install key, so cover names can't be guessed from the image.
fn art_key(dir: &Path) -> [u8; 16] {
    let path = dir.join(".key");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(key) = <[u8; 16]>::try_from(bytes.as_slice()) {
            return key;
        }
    }
    let mut key = [0u8; 16];
    getrandom::getrandom(&mut key).expect("OS random generator");
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&path, key);
    key
}

fn keyed_name(key: &[u8; 16], data: &[u8], ext: &str) -> String {
    let half = |salt: u8| {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        salt.hash(&mut h);
        key.hash(&mut h);
        data.hash(&mut h);
        h.finish()
    };
    format!("{:016x}{:016x}.{ext}", half(1), half(2))
}

/// Cover names are 32 hex digits and an image extension; anything else is refused.
pub(crate) fn valid_art_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else { return false };
    stem.len() == 32 && stem.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) && matches!(ext, "jpg" | "png" | "webp" | "gif")
}

fn image_ext(data: &[u8], mime: Option<&MimeType>) -> Option<&'static str> {
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if data.starts_with(b"\x89PNG") {
        return Some("png");
    }
    if data.len() > 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    if data.starts_with(b"GIF8") {
        return Some("gif");
    }
    match mime {
        Some(MimeType::Jpeg) => Some("jpg"),
        Some(MimeType::Png) => Some("png"),
        _ => None,
    }
}

struct ArtCache {
    dir: PathBuf,
    key: [u8; 16],
    /// Folder covers already cached during this scan, by folder.
    folders: HashMap<PathBuf, Option<String>>,
}

impl ArtCache {
    fn new(dir: PathBuf) -> Self {
        let key = art_key(&dir);
        ArtCache { dir, key, folders: HashMap::new() }
    }

    fn store(&self, data: &[u8], mime: Option<&MimeType>) -> Option<String> {
        if data.is_empty() || data.len() as u64 > MAX_COVER_BYTES {
            return None;
        }
        let ext = image_ext(data, mime)?;
        let name = keyed_name(&self.key, data, ext);
        let path = self.dir.join(&name);
        if !path.exists() {
            std::fs::create_dir_all(&self.dir).ok()?;
            let tmp = self.dir.join(format!("{name}.tmp"));
            std::fs::write(&tmp, data).ok()?;
            std::fs::rename(&tmp, &path).ok()?;
        }
        Some(name)
    }

    /// `cover.jpg`, `folder.png`, … next to the audio file.
    fn folder_cover(&mut self, folder: &Path) -> Option<String> {
        if let Some(hit) = self.folders.get(folder) {
            return hit.clone();
        }
        let found = std::fs::read_dir(folder).ok().and_then(|entries| {
            let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
            files.sort();
            FOLDER_COVERS.iter().find_map(|want| {
                files.iter().find(|p| {
                    let stem = p.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                    let ext = p.extension().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                    stem == *want && matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp")
                }).cloned()
            })
        });
        let name = found
            .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() <= MAX_COVER_BYTES))
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|data| self.store(&data, None));
        self.folders.insert(folder.to_path_buf(), name.clone());
        name
    }
}

// ---------------------------------------------------------------------------
// Tag reading
// ---------------------------------------------------------------------------

fn codec_name(file_type: lofty::file::FileType, mp4: Option<lofty::mp4::Mp4Codec>) -> String {
    use lofty::file::FileType as F;
    use lofty::mp4::Mp4Codec as C;
    match file_type {
        F::Mpeg => "mp3",
        F::Flac => "flac",
        F::Aac => "aac",
        F::Mp4 => match mp4 {
            Some(C::ALAC) => "alac",
            Some(C::FLAC) => "flac",
            Some(C::MP3) => "mp3",
            _ => "aac",
        },
        F::Vorbis => "vorbis",
        F::Opus => "opus",
        F::Wav => "wav",
        F::Aiff => "aiff",
        F::Speex => "speex",
        F::WavPack => "wavpack",
        F::Ape => "ape",
        F::Mpc => "musepack",
        _ => "unknown",
    }
    .to_string()
}

fn read_tagged(path: &Path) -> Result<(TaggedFile, Option<lofty::mp4::Mp4Codec>), String> {
    let is_mp4 = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("m4a"));
    if is_mp4 {
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        if let Ok(mp4) = lofty::mp4::Mp4File::read_from(&mut file, ParseOptions::new()) {
            let codec = mp4.properties().codec();
            return Ok((mp4.into(), codec));
        }
    }
    let tagged = lofty::probe::Probe::open(path)
        .map_err(|e| e.to_string())?
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    Ok((tagged, None))
}

fn sidecar_lyrics(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let dir = path.parent()?;
    let candidates = [dir.join(format!("{stem}.lrc")), dir.join(format!("{stem}.LRC"))];
    let lrc = candidates.into_iter().find(|p| p.is_file())?;
    if std::fs::metadata(&lrc).ok()?.len() > MAX_LYRICS_BYTES {
        return None;
    }
    let bytes = std::fs::read(lrc).ok()?;
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned();
    Some(text).filter(|t| !t.trim().is_empty())
}

/// Reads one audio file. Unreadable tags still give a playable entry (named after the file).
fn read_music_file(path: &Path, size: u64, mtime: i64, art: &mut ArtCache) -> MusicFile {
    let mut out = MusicFile { file_path: path.to_string_lossy().into_owned(), file_size: size, mtime, ..Default::default() };
    let mut embedded_lyrics: Vec<String> = Vec::new();
    let mut cover = None;
    match read_tagged(path) {
        Ok((tagged, mp4_codec)) => {
            let props = tagged.properties();
            out.duration = props.duration().as_secs_f64();
            out.sample_rate = props.sample_rate();
            out.bit_depth = props.bit_depth();
            out.bitrate = props.audio_bitrate().or(props.overall_bitrate());
            out.channels = props.channels();
            out.codec = codec_name(tagged.file_type(), mp4_codec);
            // The primary tag first, then any other (e.g. ID3v1 or APE next to ID3v2).
            let mut tags: Vec<&lofty::tag::Tag> = tagged.primary_tag().into_iter().collect();
            tags.extend(tagged.tags().iter().filter(|t| Some(t.tag_type()) != tagged.primary_tag().map(|p| p.tag_type())));
            for tag in tags {
                out.title = out.title.take().or_else(|| clean(tag.title()));
                out.artist = out.artist.take().or_else(|| clean(tag.artist()));
                out.album = out.album.take().or_else(|| clean(tag.album()));
                out.genre = out.genre.take().or_else(|| clean(tag.genre()));
                out.album_artist = out.album_artist.take().or_else(|| clean_str(tag.get_string(ItemKey::AlbumArtist)));
                out.track_no = out.track_no.or(tag.track()).filter(|n| *n > 0);
                out.track_total = out.track_total.or(tag.track_total()).filter(|n| *n > 0);
                out.disc_no = out.disc_no.or(tag.disk()).filter(|n| *n > 0);
                out.disc_total = out.disc_total.or(tag.disk_total()).filter(|n| *n > 0);
                out.year = out.year.or_else(|| tag.date().map(|d| d.year)).or_else(|| {
                    tag.get_string(ItemKey::Year).and_then(|y| y.trim().get(..4)).and_then(|y| y.parse().ok())
                });
                out.year = out.year.filter(|y| (1000..=9999).contains(y));
                for key in [ItemKey::Lyrics, ItemKey::UnsyncLyrics] {
                    for text in tag.get_strings(key) {
                        if !text.trim().is_empty() && text.len() as u64 <= MAX_LYRICS_BYTES {
                            embedded_lyrics.push(text.to_string());
                        }
                    }
                }
                if cover.is_none() {
                    let pic = tag.get_picture_type(PictureType::CoverFront).or_else(|| tag.pictures().first());
                    cover = pic.and_then(|p| art.store(p.data(), p.mime_type()));
                }
            }
        }
        Err(e) => out.error = Some(e),
    }
    if out.codec.is_empty() {
        out.codec = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    }
    out.cover = cover.or_else(|| path.parent().and_then(|dir| art.folder_cover(dir)));

    // Synced lyrics win; a sidecar .lrc wins over embedded text of the same kind.
    let mut candidates: Vec<(String, &'static str)> = Vec::new();
    if let Some(text) = sidecar_lyrics(path) {
        candidates.push((text, "sidecar"));
    }
    candidates.extend(embedded_lyrics.into_iter().map(|t| (t, "embedded")));
    let pick = candidates.iter().position(|(t, _)| looks_synced(t)).or(if candidates.is_empty() { None } else { Some(0) });
    if let Some(i) = pick {
        let (text, source) = candidates.swap_remove(i);
        out.lyrics = Some(text);
        out.lyrics_source = Some(source.to_string());
    }
    out
}

fn walk(roots: &[String], known: &HashMap<String, i64>, force: bool, art: &mut ArtCache) -> MusicScan {
    let mut seen_set = HashSet::new();
    let mut seen = Vec::new();
    let mut changed = Vec::new();
    for root in roots {
        let walker = WalkDir::new(root).follow_links(true).into_iter().filter_entry(|e| !is_hidden_or_system(e));
        for entry in walker.filter_map(Result::ok) {
            if !entry.file_type().is_file() || !has_audio_extension(entry.path()) {
                continue;
            }
            if entry.file_name().to_string_lossy().starts_with("._") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let path = entry.path().to_string_lossy().into_owned();
            if !seen_set.insert(path.clone()) {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if force || known.get(&path) != Some(&mtime) {
                changed.push(read_music_file(entry.path(), meta.len(), mtime, art));
            }
            seen.push(path);
        }
    }
    MusicScan { seen, changed }
}

/// Walks the music folders. `known` maps already-imported files to their mtime; only new or
/// changed files (or all with `force`) are read.
#[tauri::command]
pub async fn music_scan(app: AppHandle, paths: Vec<String>, known: HashMap<String, i64>, force: bool) -> Result<MusicScan, String> {
    let dir = art_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut art = ArtCache::new(dir);
        walk(&paths, &known, force, &mut art)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Folder holding cached covers (the desktop app loads them through the asset protocol).
#[tauri::command]
pub fn music_art_dir(app: AppHandle) -> String {
    art_dir(&app).to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Online lyrics: NetEase Cloud Music and LRCLIB
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
pub struct OnlineLyrics {
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub instrumental: bool,
    /// Where they came from: "netease" or "lrclib" (shown as a credit under the lyrics).
    pub provider: &'static str,
}

fn parse_lrclib(v: &serde_json::Value) -> OnlineLyrics {
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_owned).filter(|s| !s.trim().is_empty());
    OnlineLyrics { synced: text("syncedLyrics"), plain: text("plainLyrics"), instrumental: v.get("instrumental").and_then(|x| x.as_bool()).unwrap_or(false), provider: "lrclib" }
}

/// Best search hit: closest duration (within 5 s), synced lyrics preferred.
fn best_search_hit(list: &[serde_json::Value], duration: f64) -> Option<&serde_json::Value> {
    list.iter()
        .filter(|v| duration <= 0.0 || v.get("duration").and_then(|d| d.as_f64()).is_some_and(|d| (d - duration).abs() <= 5.0))
        .min_by_key(|v| {
            let synced = v.get("syncedLyrics").and_then(|s| s.as_str()).is_some_and(|s| !s.is_empty());
            let diff = v.get("duration").and_then(|d| d.as_f64()).map(|d| (d - duration).abs()).unwrap_or(5.0);
            (!synced as u8, (diff * 10.0) as u64)
        })
}

/// Looks up lyrics online: NetEase Cloud Music first (synced lyrics for most popular songs, many
/// timed word by word), then LRCLIB (free, crowd-sourced). `None` = neither has them.
#[tauri::command]
pub async fn music_lyrics_fetch(artist: String, title: String, album: Option<String>, duration: f64) -> Result<Option<OnlineLyrics>, String> {
    if artist.trim().is_empty() || title.trim().is_empty() {
        return Ok(None);
    }
    match netease_lookup(&artist, &title, duration).await {
        Ok(Some(found)) => return Ok(Some(found)),
        Ok(None) => {}
        // NetEase being down or blocked isn't fatal: LRCLIB may still have the song.
        Err(e) => eprintln!("[music] NetEase lyrics lookup failed: {e}"),
    }
    lrclib_lookup(&artist, &title, album, duration).await
}

async fn lrclib_lookup(artist: &str, title: &str, album: Option<String>, duration: f64) -> Result<Option<OnlineLyrics>, String> {
    let (artist, title) = (artist.to_string(), title.to_string());
    let client = reqwest::Client::builder()
        .user_agent(concat!("TruongFlix/", env!("CARGO_PKG_VERSION"), " (https://github.com/iant4093/TruongFlix)"))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let mut params = vec![("artist_name", artist.clone()), ("track_name", title.clone())];
    if let Some(a) = album.filter(|a| !a.trim().is_empty()) {
        params.push(("album_name", a));
    }
    if duration > 0.0 {
        params.push(("duration", format!("{}", duration.round() as u64)));
    }
    let url = reqwest::Url::parse_with_params("https://lrclib.net/api/get", &params).map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if res.status().is_success() {
        let v: serde_json::Value = serde_json::from_str(&res.text().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        return Ok(Some(parse_lrclib(&v)));
    }
    if res.status().as_u16() != 404 {
        return Err(format!("LRCLIB answered HTTP {}", res.status()));
    }
    // No exact match (album or duration differ): search by artist and title, then by the title
    // without a version tag ("Song (Remastered 2011)" -> "Song"). A failed search is an error, not
    // "no lyrics", so it's tried again later instead of being remembered as missing.
    let mut titles = vec![title.clone()];
    let bare = bare_title(&title);
    if !bare.is_empty() && !bare.eq_ignore_ascii_case(&title) {
        titles.push(bare);
    }
    for name in titles {
        let url = reqwest::Url::parse_with_params("https://lrclib.net/api/search", &[("artist_name", artist.as_str()), ("track_name", name.as_str())]).map_err(|e| e.to_string())?;
        let res = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("LRCLIB search answered HTTP {}", res.status()));
        }
        let list: Vec<serde_json::Value> = serde_json::from_str(&res.text().await.map_err(|e| e.to_string())?).unwrap_or_default();
        if let Some(hit) = best_search_hit(&list, duration) {
            return Ok(Some(parse_lrclib(hit)));
        }
    }
    Ok(None)
}

// NetEase Cloud Music (no key). Its catalogue has time-synced lyrics for most popular songs, and
// many are timed word by word ("YRC"), which become enhanced LRC here.

const NETEASE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// Lowercased letters and digits only, for comparing titles and artists ("Don't" == "Dont").
fn simplify(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The search hit for this song: same title (ignoring version tags) by one of the artists, with the
/// closest length (within 4 s when the length is known). An exact title beats a bare-title match.
fn netease_pick(songs: &[serde_json::Value], artist: &str, title: &str, duration: f64) -> Option<u64> {
    let want_exact = simplify(title);
    let want_bare = simplify(&bare_title(title));
    let our_artist = simplify(artist);
    songs
        .iter()
        .filter_map(|s| {
            let name = s.get("name")?.as_str()?;
            let id = s.get("id")?.as_u64()?;
            let exact = simplify(name) == want_exact;
            if !exact && simplify(&bare_title(name)) != want_bare {
                return None;
            }
            let artists = s.get("ar").and_then(|a| a.as_array())?;
            let by = artists.iter().filter_map(|a| a.get("name")?.as_str()).map(simplify).any(|a| !a.is_empty() && (our_artist.contains(&a) || a.contains(&our_artist)));
            if !by {
                return None;
            }
            let len = s.get("dt").and_then(|d| d.as_f64()).unwrap_or(0.0) / 1000.0;
            let diff = if duration > 0.0 && len > 0.0 { (len - duration).abs() } else { 0.0 };
            if diff > 4.0 {
                return None;
            }
            Some(((!exact) as u8, (diff * 10.0) as u64, id))
        })
        .min()
        .map(|(_, _, id)| id)
}

fn lrc_stamp(ms: u64) -> String {
    format!("{:02}:{:02}.{:02}", ms / 60_000, (ms / 1000) % 60, (ms % 1000) / 10)
}

/// Song credits NetEase puts at the top of its lyrics ("作词 : Someone", "Producer: …").
fn is_credit(text: &str) -> bool {
    let t = text.trim();
    let Some(i) = t.find([':', '：']) else { return false };
    let label = t[..i].trim();
    !label.is_empty() && label.chars().count() <= 12 && (label.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) || ["producer", "producers", "writer", "writers", "composer", "lyricist", "lyrics", "music", "arranger", "mixed by", "mastered by", "recorded by", "vocals", "vocal producer"].contains(&label.to_lowercase().as_str()))
}

/// Word-timed YRC (`[start,dur](start,dur,0)word(start,dur,0)word`, ms) as enhanced LRC.
fn yrc_to_lrc(yrc: &str) -> Option<String> {
    let mut out = Vec::new();
    for line in yrc.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('[') else { continue }; // JSON credit lines start with '{'
        let Some((head, mut body)) = rest.split_once(']') else { continue };
        let Some(start) = head.split(',').next().and_then(|v| v.trim().parse::<u64>().ok()) else { continue };
        let mut words = String::new();
        let mut plain = String::new();
        let mut end = 0u64;
        while let Some(open) = body.find('(') {
            let Some(close) = body[open..].find(')').map(|c| open + c) else { break };
            let nums: Vec<u64> = body[open + 1..close].split(',').filter_map(|v| v.trim().parse().ok()).collect();
            let next = body[close + 1..].find('(').map(|n| close + 1 + n).unwrap_or(body.len());
            let text = &body[close + 1..next];
            if nums.len() >= 2 && !text.is_empty() {
                words.push_str(&format!("<{}>{}", lrc_stamp(nums[0]), text));
                plain.push_str(text);
                end = end.max(nums[0] + nums[1]);
            }
            body = &body[next..];
        }
        if plain.trim().is_empty() || is_credit(&plain) {
            continue;
        }
        out.push(format!("[{}]{}<{}>", lrc_stamp(start), words, lrc_stamp(end)));
    }
    (!out.is_empty()).then(|| out.join("\n"))
}

/// Line-timed LRC without the credits and JSON lines. None when no sung line is left.
fn clean_netease_lrc(lrc: &str) -> Option<String> {
    let kept: Vec<&str> = lrc
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('[') && l.as_bytes().get(1).is_some_and(u8::is_ascii_digit))
        .filter(|l| {
            let text = l.rsplit(']').next().unwrap_or("");
            // "暂无歌词" (no lyrics yet) and "纯音乐，请欣赏" (instrumental) are placeholders, not lyrics.
            !is_credit(text) && !text.contains("暂无歌词") && !text.contains("纯音乐")
        })
        .collect();
    let sung = kept.iter().any(|l| !l.rsplit(']').next().unwrap_or("").trim().is_empty());
    sung.then(|| kept.join("\n"))
}

/// NetEase's lyrics for the song. `Ok(None)` = not found there (or no synced lyrics).
async fn netease_lookup(artist: &str, title: &str, duration: f64) -> Result<Option<OnlineLyrics>, String> {
    let client = reqwest::Client::builder().user_agent(NETEASE_UA).timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let get = |url: reqwest::Url| {
        let req = client.get(url).header("Referer", "https://music.163.com/");
        async move {
            let res = req.send().await.map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("NetEase answered HTTP {}", res.status()));
            }
            serde_json::from_str::<serde_json::Value>(&res.text().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
    };
    let mut queries = vec![format!("{title} {artist}")];
    let bare = bare_title(title);
    if !bare.eq_ignore_ascii_case(title) {
        queries.push(format!("{bare} {artist}"));
    }
    let mut id = None;
    for q in queries {
        let url = reqwest::Url::parse_with_params("https://music.163.com/api/cloudsearch/pc", &[("s", q.as_str()), ("type", "1"), ("limit", "20")]).map_err(|e| e.to_string())?;
        let v = get(url).await?;
        let songs = v.pointer("/result/songs").and_then(|s| s.as_array()).cloned().unwrap_or_default();
        id = netease_pick(&songs, artist, title, duration);
        if id.is_some() {
            break;
        }
    }
    let Some(id) = id else { return Ok(None) };
    let url = reqwest::Url::parse_with_params("https://music.163.com/api/song/lyric/v1", &[("id", id.to_string().as_str()), ("lv", "-1"), ("kv", "-1"), ("tv", "-1"), ("yv", "-1")]).map_err(|e| e.to_string())?;
    let v = get(url).await?;
    if v.get("pureMusic").and_then(|p| p.as_bool()).unwrap_or(false) {
        return Ok(Some(OnlineLyrics { synced: None, plain: None, instrumental: true, provider: "netease" }));
    }
    let text = |p: &str| v.pointer(p).and_then(|s| s.as_str()).unwrap_or("");
    if text("/lrc/lyric").contains("纯音乐，请欣赏") {
        return Ok(Some(OnlineLyrics { synced: None, plain: None, instrumental: true, provider: "netease" }));
    }
    let synced = yrc_to_lrc(text("/yrc/lyric")).or_else(|| clean_netease_lrc(text("/lrc/lyric")));
    Ok(synced.map(|s| OnlineLyrics { synced: Some(s), plain: None, instrumental: false, provider: "netease" }))
}

/// The title without a trailing version tag: "(Remastered 2011)", "[Live]", "- Radio Edit", "feat. X".
pub(crate) fn bare_title(title: &str) -> String {
    let mut t = title.trim().to_string();
    loop {
        let before = t.clone();
        if t.ends_with(')') || t.ends_with(']') {
            let open = if t.ends_with(')') { '(' } else { '[' };
            if let Some(i) = t.rfind(open) {
                if i > 0 {
                    t = t[..i].trim_end().to_string();
                }
            }
        }
        let lower = t.to_lowercase();
        for sep in [" - ", " feat. ", " ft. ", " featuring "] {
            if let Some(i) = lower.rfind(sep) {
                if i > 0 {
                    t = t[..i].trim_end().to_string();
                    break;
                }
            }
        }
        if t == before {
            return t;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::config::WriteOptions;
    use lofty::picture::Picture;
    use lofty::tag::{Tag, TagType};
    use std::fs;

    /// A valid 1-second mono 8 kHz 16-bit PCM WAV file.
    fn wav_bytes() -> Vec<u8> {
        let rate: u32 = 8000;
        let data_len: u32 = rate * 2;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        b.resize(b.len() + data_len as usize, 0);
        b
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("truongflix-music-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn strips_version_tags_for_lyrics_search() {
        assert_eq!(bare_title("Birds Of A Feather (Isolated Vocals)"), "Birds Of A Feather");
        assert_eq!(bare_title("Song [Live] (Remastered 2011)"), "Song");
        assert_eq!(bare_title("Song - Radio Edit"), "Song");
        assert_eq!(bare_title("Song feat. Someone"), "Song");
        assert_eq!(bare_title("(Untitled)"), "(Untitled)");
        assert_eq!(bare_title("Plain"), "Plain");
    }

    #[test]
    fn reads_tags_cover_and_lyrics() {
        let root = temp_root("tags");
        let song = root.join("Album/01 Song.wav");
        fs::create_dir_all(song.parent().unwrap()).unwrap();
        fs::write(&song, wav_bytes()).unwrap();

        let mut tagged = lofty::read_from_path(&song).unwrap();
        let mut tag = Tag::new(TagType::Id3v2);
        tag.set_title("Morning Light".into());
        tag.set_artist("The Examples".into());
        tag.set_album("First Album".into());
        tag.set_genre("Indie".into());
        tag.set_track(3);
        tag.set_track_total(10);
        tag.set_disk(1);
        tag.set_date(lofty::tag::items::Timestamp { year: 2021, ..Default::default() });
        tag.insert_text(ItemKey::AlbumArtist, "Various Examples".into());
        tag.insert_text(ItemKey::UnsyncLyrics, "Just plain words".into());
        tag.push_picture(Picture::unchecked(PNG.to_vec()).pic_type(PictureType::CoverFront).mime_type(MimeType::Png).build());
        tagged.insert_tag(tag);
        tagged.save_to_path(&song, WriteOptions::default()).unwrap();
        // A sidecar .lrc with timestamps beats the embedded plain lyrics.
        fs::write(root.join("Album/01 Song.lrc"), "\u{feff}[00:01.00]Hello\n[00:02.50]World\n").unwrap();

        let mut art = ArtCache::new(root.join("art"));
        let f = read_music_file(&song, 1, 7, &mut art);
        assert_eq!(f.error, None);
        assert_eq!(f.title.as_deref(), Some("Morning Light"));
        assert_eq!(f.artist.as_deref(), Some("The Examples"));
        assert_eq!(f.album_artist.as_deref(), Some("Various Examples"));
        assert_eq!(f.album.as_deref(), Some("First Album"));
        assert_eq!(f.genre.as_deref(), Some("Indie"));
        assert_eq!((f.track_no, f.track_total, f.disc_no), (Some(3), Some(10), Some(1)));
        assert_eq!(f.year, Some(2021));
        assert_eq!(f.codec, "wav");
        assert!((f.duration - 1.0).abs() < 0.05, "duration {}", f.duration);
        assert_eq!(f.lyrics_source.as_deref(), Some("sidecar"));
        assert!(f.lyrics.as_deref().unwrap().starts_with("[00:01.00]Hello"));
        let cover = f.cover.expect("embedded cover cached");
        assert!(valid_art_name(&cover), "{cover}");
        assert!(cover.ends_with(".png"));
        assert_eq!(fs::read(root.join("art").join(&cover)).unwrap(), PNG);

        // Without the sidecar the embedded lyrics are used.
        fs::remove_file(root.join("Album/01 Song.lrc")).unwrap();
        let f = read_music_file(&song, 1, 7, &mut art);
        assert_eq!(f.lyrics.as_deref(), Some("Just plain words"));
        assert_eq!(f.lyrics_source.as_deref(), Some("embedded"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn scans_incrementally_with_folder_covers() {
        let root = temp_root("walk");
        fs::create_dir_all(root.join("lib/A")).unwrap();
        fs::write(root.join("lib/A/one.wav"), wav_bytes()).unwrap();
        fs::write(root.join("lib/A/two.wav"), wav_bytes()).unwrap();
        fs::write(root.join("lib/A/Cover.PNG"), PNG).unwrap();
        fs::write(root.join("lib/A/notes.txt"), "x").unwrap();
        fs::write(root.join("lib/A/._one.wav"), "junk").unwrap();
        fs::create_dir_all(root.join("lib/.hidden")).unwrap();
        fs::write(root.join("lib/.hidden/three.wav"), wav_bytes()).unwrap();

        let mut art = ArtCache::new(root.join("art"));
        let roots = vec![root.join("lib").to_string_lossy().into_owned()];
        let scan = walk(&roots, &HashMap::new(), false, &mut art);
        assert_eq!(scan.seen.len(), 2);
        assert_eq!(scan.changed.len(), 2);
        let one = scan.changed.iter().find(|f| f.file_path.ends_with("one.wav")).unwrap();
        assert!(one.title.is_none(), "untagged file keeps no title");
        assert!(one.cover.as_deref().is_some_and(valid_art_name), "folder cover used");

        let known: HashMap<String, i64> = scan.changed.iter().map(|f| (f.file_path.clone(), f.mtime)).collect();
        let again = walk(&roots, &known, false, &mut art);
        assert_eq!(again.seen.len(), 2);
        assert!(again.changed.is_empty(), "unchanged files are skipped");
        assert_eq!(walk(&roots, &known, true, &mut art).changed.len(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn art_names_are_keyed_and_validated() {
        let a = keyed_name(&[1; 16], b"image", "jpg");
        let b = keyed_name(&[2; 16], b"image", "jpg");
        assert_ne!(a, b);
        assert!(valid_art_name(&a));
        assert!(!valid_art_name("../../etc/passwd"));
        assert!(!valid_art_name("0123456789abcdef0123456789abcdef.exe"));
        assert!(!valid_art_name("0123456789ABCDEF0123456789abcdef.jpg"));
        assert!(!valid_art_name(".key"));
    }

    #[test]
    fn detects_synced_lyrics() {
        assert!(looks_synced("[ar:Someone]\n[00:12.34]Line"));
        assert!(looks_synced("[1:02]Line"));
        assert!(!looks_synced("[Chorus]\nLa la la"));
        assert!(!looks_synced("plain words"));
    }

    #[test]
    fn picks_lrclib_search_hits() {
        let list: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"duration":200,"plainLyrics":"a","syncedLyrics":null},
                {"duration":202,"plainLyrics":"b","syncedLyrics":"[00:01.00]b"},
                {"duration":260,"plainLyrics":"c","syncedLyrics":"[00:01.00]c"}]"#,
        )
        .unwrap();
        let hit = parse_lrclib(best_search_hit(&list, 201.0).unwrap());
        assert_eq!(hit.synced.as_deref(), Some("[00:01.00]b"));
        assert!(best_search_hit(&list, 100.0).is_none());
    }

    #[test]
    fn converts_netease_word_timing() {
        let yrc = "{\"t\":0,\"c\":[{\"tx\":\"作曲: \"},{\"tx\":\"Someone\"}]}
[9520,1350](9520,210,0)If (9730,120,0)you (9850,300,0)wanna
[12000,500](12000,500,0)Run";
        let lrc = yrc_to_lrc(yrc).unwrap();
        assert_eq!(lrc, "[00:09.52]<00:09.52>If <00:09.73>you <00:09.85>wanna<00:10.15>
[00:12.00]<00:12.00>Run<00:12.50>");
    }

    #[test]
    fn drops_netease_credits_and_placeholders() {
        let lrc = "{\"t\":0}
[00:00.00] 作词 : Someone
[00:01.00] Producer: X
[00:05.10]Hello there
[00:07.00]";
        assert_eq!(clean_netease_lrc(lrc).unwrap(), "[00:05.10]Hello there
[00:07.00]");
        assert!(clean_netease_lrc("[00:00.00]暂无歌词").is_none());
        assert!(!is_credit("Baby: I love you so much right now"));
    }

    #[test]
    fn picks_netease_hits() {
        let songs: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"id":1,"name":"Blinding Lights (Live)","ar":[{"name":"The Weeknd"}],"dt":253000},
                {"id":2,"name":"Blinding Lights","ar":[{"name":"Cover Band"}],"dt":200000},
                {"id":3,"name":"Blinding Lights","ar":[{"name":"The Weeknd"}],"dt":200045},
                {"id":4,"name":"Blinding Lights","ar":[{"name":"The Weeknd"}],"dt":215000}]"#,
        )
        .unwrap();
        assert_eq!(netease_pick(&songs, "The Weeknd", "Blinding Lights", 201.0), Some(3));
        assert_eq!(netease_pick(&songs, "The Weeknd", "Blinding Lights (Remastered)", 200.0), Some(3));
        assert_eq!(netease_pick(&songs, "Someone Else", "Blinding Lights", 200.0), None);
    }
}

#[cfg(test)]
mod online_tests {
    /// Real lookups (needs the internet): `cargo test --lib online_lyrics -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn online_lyrics() {
        for (artist, title, dur) in [("The Weeknd", "Blinding Lights", 200.0), ("Taylor Swift", "Anti-Hero", 200.0), ("Dua Lipa", "Levitating", 203.0), ("Queen", "Bohemian Rhapsody (Remastered 2011)", 355.0), ("Billie Eilish", "BIRDS OF A FEATHER", 210.0)] {
            let r = tauri::async_runtime::block_on(super::music_lyrics_fetch(artist.into(), title.into(), None, dur)).unwrap();
            let r = r.expect(title);
            let s = r.synced.unwrap_or_default();
            println!("{title}: {} words={} {:?}", r.provider, s.contains('<'), s.lines().take(2).collect::<Vec<_>>());
        }
    }
}
