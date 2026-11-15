//! Music library: walks the music folders, reads each audio file's tags (title, artists, album,
//! track/disc, year, genre, duration, codec), caches embedded or folder cover art, and picks up
//! embedded or sidecar `.lrc` lyrics. Synced lyrics can also be looked up on LRCLIB.
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
// LRCLIB
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
pub struct OnlineLyrics {
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub instrumental: bool,
}

fn parse_lrclib(v: &serde_json::Value) -> OnlineLyrics {
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_owned).filter(|s| !s.trim().is_empty());
    OnlineLyrics { synced: text("syncedLyrics"), plain: text("plainLyrics"), instrumental: v.get("instrumental").and_then(|x| x.as_bool()).unwrap_or(false) }
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

/// Looks up lyrics on LRCLIB (free, no key). `None` = not found.
#[tauri::command]
pub async fn music_lyrics_fetch(artist: String, title: String, album: Option<String>, duration: f64) -> Result<Option<OnlineLyrics>, String> {
    if artist.trim().is_empty() || title.trim().is_empty() {
        return Ok(None);
    }
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
    // No exact match (album or duration differ): search by artist and title.
    let url = reqwest::Url::parse_with_params("https://lrclib.net/api/search", &[("artist_name", artist), ("track_name", title)]).map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let list: Vec<serde_json::Value> = serde_json::from_str(&res.text().await.map_err(|e| e.to_string())?).unwrap_or_default();
    Ok(best_search_hit(&list, duration).map(parse_lrclib))
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
}
