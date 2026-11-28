use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::{DirEntry, WalkDir};

const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts"];
const EXTRA_KEYWORDS: &[&str] = &["sample", "trailer", "featurette"];
const EXTRA_MAX_BYTES: u64 = 60 * 1024 * 1024;
/// Plex/Jellyfin folders for bonus material: never titles of their own, whatever their size (a
/// featurette used to become a "movie" matched to some random title). These names only ever mean
/// bonus material.
const EXTRAS_FOLDERS: &[&str] = &["featurettes", "behind the scenes", "deleted scenes"];
/// These also name real things ("Shorts" of short films, the show "Extras"): bonus material only
/// inside a title's own folder, "Inception (2010)/Extras".
const EXTRAS_FOLDERS_IN_TITLE: &[&str] = &["extras", "extra", "interviews", "scenes", "shorts", "trailers", "bonus"];
/// Plex's file-name form of the same: "Inception (2010)-deleted.mkv" ("-short" or "-interview"
/// would also catch "The-Big-Short.mkv" and "The-Interview.mkv").
const EXTRAS_SUFFIXES: &[&str] = &["-behindthescenes", "-deleted", "-featurette", "-trailer"];
/// Plex's other suffixes, which also end real names: bonus material only inside a title's folder.
const EXTRAS_SUFFIXES_IN_TITLE: &[&str] = &["-interview", "-scene", "-short", "-other", "-extra"];

/// "Inception (2010)", "Severance [2022]".
fn has_year(name: &str) -> bool {
    name.as_bytes()
        .windows(6)
        .any(|w| (w[0] == b'(' || w[0] == b'[') && w[1..5].iter().all(u8::is_ascii_digit) && (w[5] == b')' || w[5] == b']'))
}

/// "Season 1", "Series 02", "Staffel 3", "Season 2024", "S01", "Specials": exactly, so a movie
/// folder like "Season of the Witch (2011)" or a library named "Series" doesn't count.
fn is_season_folder(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    if n == "specials" || n == "special" {
        return true;
    }
    let digits = |s: &str| !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit());
    if n.len() <= 3 && n.starts_with('s') && digits(&n[1..]) {
        return true;
    }
    ["season", "series", "staffel", "saison", "temporada"].iter().any(|p| n.strip_prefix(p).is_some_and(|rest| digits(rest.trim_start_matches([' ', '.', '_', '-']))))
}

/// A movie's or show's own folder: it has a year, is a season folder, or holds season folders.
fn is_title_folder(dir: &Path) -> bool {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    has_year(&name)
        || is_season_folder(&name)
        || std::fs::read_dir(dir).is_ok_and(|entries| {
            entries.flatten().any(|e| e.file_type().is_ok_and(|t| t.is_dir()) && is_season_folder(&e.file_name().to_string_lossy()))
        })
}
/// `.ts` is also TypeScript; real MPEG transport streams are never this small.
const MIN_TS_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
pub struct RawVideoFile {
    pub file_path: String,
    pub filename: String,
    pub parent_folder_name: String,
    pub grandparent_folder_name: String,
    pub file_size: u64,
    pub mtime: i64,
}

pub(crate) fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('$')
        || name.eq_ignore_ascii_case("System Volume Information")
        || name.eq_ignore_ascii_case("@eaDir")
}

pub(crate) fn is_hidden_or_system(entry: &DirEntry) -> bool {
    entry.depth() > 0 && is_hidden_name(&entry.file_name().to_string_lossy())
}

pub(crate) fn has_video_extension(path: &Path) -> bool {
    path.extension()
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_string_lossy().to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The single definition of "a playable library video" shared by scanning, organizing and deleting.
pub(crate) fn is_library_video(path: &Path, size: u64) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy()) else { return false };
    if name.starts_with("._") {
        return false;
    }
    let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()) else { return false };
    if !VIDEO_EXTENSIONS.contains(&ext.as_str()) || (ext == "ts" && size < MIN_TS_BYTES) {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(&format!(".{ext}")).unwrap_or(&lower);
    if EXTRAS_SUFFIXES.iter().any(|s| stem.ends_with(s)) {
        return false;
    }
    // Plex's "Title (Year)-interview" form only: "The Big Short (2015)/The-Big-Short.mkv" is the film.
    if EXTRAS_SUFFIXES_IN_TITLE.iter().any(|s| stem.strip_suffix(s).is_some_and(has_year)) {
        return false;
    }
    let parent = path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if EXTRAS_FOLDERS.contains(&parent.as_str()) {
        return false;
    }
    // "Breaking Bad/Extras", "Show (2008)/Season 01/Extras", "Inception (2010)/Trailers"; not
    // "Movies/Shorts" (short films) or the show "Extras".
    if EXTRAS_FOLDERS_IN_TITLE.contains(&parent.as_str()) && path.parent().and_then(|p| p.parent()).is_some_and(is_title_folder) {
        return false;
    }
    !(size < EXTRA_MAX_BYTES && EXTRA_KEYWORDS.iter().any(|k| lower.contains(k)))
}

fn folder_name(path: Option<&Path>) -> String {
    path.and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Walks one media folder. Folders (or files) that couldn't be read are added to `unreadable`: the
/// app must not take their videos for deleted (a network share dropping out mid-scan used to erase
/// the watch history of everything it hadn't reached yet).
fn walk_root(root: &str, seen: &mut HashSet<String>, out: &mut Vec<RawVideoFile>, unreadable: &mut Vec<String>) {
    let walker = WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| !is_hidden_or_system(e));

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                unreadable.push(err.path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string()));
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !has_video_extension(path) {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().into_owned();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                unreadable.push(path.to_string_lossy().into_owned());
                continue;
            }
        };
        let size = meta.len();
        if !is_library_video(path, size) {
            continue;
        }
        let file_path = path.to_string_lossy().into_owned();
        if !seen.insert(file_path.clone()) {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let parent = path.parent();
        out.push(RawVideoFile {
            file_path,
            filename,
            parent_folder_name: folder_name(parent),
            grandparent_folder_name: folder_name(parent.and_then(|p| p.parent())),
            file_size: size,
            mtime,
        });
    }
}

#[derive(Serialize)]
pub struct ScanResult {
    pub files: Vec<RawVideoFile>,
    /// Folders and files that couldn't be read this time: nothing under them counts as deleted.
    pub unreadable: Vec<String>,
}

/// Recursively walks every media directory and returns all playable video files.
/// Runs on a blocking worker so large libraries never stall the UI thread.
#[tauri::command]
pub async fn scan_media_folders(paths: Vec<String>) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        let mut unreadable = Vec::new();
        for root in &paths {
            walk_root(root, &mut seen, &mut files, &mut unreadable);
        }
        ScanResult { files, unreadable }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(path: &Path, size: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path).unwrap().set_len(size).unwrap();
    }

    #[test]
    fn walks_and_filters_video_files() {
        let root = std::env::temp_dir().join(format!("truongflix-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let big = 100 * 1024 * 1024;
        touch(&root.join("Movies/Dune Part Two (2024)/d-dune2-2160p.mkv"), big);
        touch(&root.join("Shows/Severance (2022)/Season 01/S01E01.mkv"), big);
        touch(&root.join("Movies/The.Matrix.1999.sample.mkv"), 1024);
        touch(&root.join("Movies/Big.Trailer.Cut.2020.mkv"), big); // large "trailer" files are kept
        touch(&root.join("Movies/._The.Matrix.mkv"), 4096);
        touch(&root.join("Movies/.hidden/secret.mkv"), big);
        touch(&root.join("Movies/notes.txt"), 10);
        touch(&root.join("Movies/code.ts"), 500);
        // Bonus material, whatever its size.
        touch(&root.join("Movies/Inception (2010)/Featurettes/Making Of.mkv"), big);
        touch(&root.join("Movies/Inception (2010)/Inception (2010)-deleted.mkv"), big);
        touch(&root.join("Movies/Inception (2010)/Extras/Interview.mkv"), big);
        touch(&root.join("Shows/Breaking Bad/Season 1/Breaking.Bad.S01E01.mkv"), big);
        touch(&root.join("Shows/Breaking Bad/Extras/Making Of.mkv"), big);
        touch(&root.join("Movies/Inception (2010)/Inception (2010)-interview.mkv"), big);
        touch(&root.join("Movies/The Big Short (2015)/The-Big-Short.mkv"), big);
        touch(&root.join("Movies/Season of the Witch (2011)/Season of the Witch.mkv"), big);
        // ...but real titles in folders with those names stay.
        touch(&root.join("Movies/Shorts/Piper (2016).mkv"), big);
        touch(&root.join("Shows/Extras/Extras.S01E01.mkv"), big);
        touch(&root.join("Movies/The-Interview.mkv"), big);

        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let mut unreadable = Vec::new();
        walk_root(root.to_str().unwrap(), &mut seen, &mut out, &mut unreadable);
        assert!(unreadable.is_empty());
        let mut names: Vec<_> = out.iter().map(|f| f.filename.as_str()).collect();
        names.sort();
        assert_eq!(names, ["Big.Trailer.Cut.2020.mkv", "Breaking.Bad.S01E01.mkv", "Extras.S01E01.mkv", "Piper (2016).mkv", "S01E01.mkv", "Season of the Witch.mkv", "The-Big-Short.mkv", "The-Interview.mkv", "d-dune2-2160p.mkv"]);

        let ep = out.iter().find(|f| f.filename == "S01E01.mkv").unwrap();
        assert_eq!(ep.parent_folder_name, "Season 01");
        assert_eq!(ep.grandparent_folder_name, "Severance (2022)");
        assert!(ep.mtime > 0);
        fs::remove_dir_all(&root).unwrap();
    }
}

/// Reports which media roots (or files) are currently reachable (e.g. external drives mounted),
/// so the frontend never prunes a library just because a disk is unplugged.
/// An offline network share can block a folder check for a long time; it counts as unreachable.
const PATH_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

#[tauri::command]
pub async fn check_paths(paths: Vec<String>) -> Vec<bool> {
    let checks: Vec<_> = paths.into_iter().map(|p| tauri::async_runtime::spawn_blocking(move || Path::new(&p).exists())).collect();
    let deadline = tokio::time::Instant::now() + PATH_CHECK_TIMEOUT;
    let mut out = Vec::with_capacity(checks.len());
    for check in checks {
        out.push(matches!(tokio::time::timeout_at(deadline, check).await, Ok(Ok(true))));
    }
    out
}

/// Who a library folder is: the disk it is on and the folder's own number on that disk.
#[derive(Serialize, Debug, PartialEq)]
pub struct FolderId {
    /// None when the folder is missing, unreachable, or its disk gives no stable numbers.
    pub id: Option<String>,
    /// On the same disk as TruongFlix's own data (the system disk, as a rule), which can't be
    /// unplugged or swapped while the app runs.
    pub home: bool,
}

/// The disk and the folder's number on it, from the file system.
#[cfg(unix)]
fn folder_identity(path: &Path) -> Option<(u64, u128)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).ok()?;
    m.is_dir().then(|| (m.dev(), m.ino() as u128))
}

#[cfg(windows)]
fn folder_identity(path: &Path) -> Option<(u64, u128)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES};
    if !std::fs::metadata(path).ok()?.is_dir() {
        return None;
    }
    // Folders open only with backup semantics; reading attributes is all that's needed.
    let f = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) } == 0 {
        return None;
    }
    let file = ((info.nFileIndexHigh as u128) << 32) | info.nFileIndexLow as u128;
    // Some network file systems give every folder 0.
    (file != 0).then_some((info.dwVolumeSerialNumber as u64, file))
}

#[cfg(not(any(unix, windows)))]
fn folder_identity(_path: &Path) -> Option<(u64, u128)> {
    None
}

fn folder_id(path: &Path, home_volume: Option<u64>) -> FolderId {
    match folder_identity(path) {
        Some((volume, file)) => FolderId { id: Some(format!("{volume:x}-{file:x}")), home: Some(volume) == home_volume },
        None => FolderId { id: None, home: false },
    }
}

/// Identifies each library folder, so a scan can tell a folder whose files were deleted (the same
/// folder as before) from an empty mount point or another disk on the same letter (a different
/// one). Like `check_paths`, an offline share that doesn't answer counts as unknown.
#[tauri::command]
pub async fn folder_ids(app: tauri::AppHandle, paths: Vec<String>) -> Vec<FolderId> {
    use tauri::Manager;
    let data = app.path().app_data_dir().ok();
    let home = tauri::async_runtime::spawn_blocking(move || data.and_then(|d| folder_identity(&d)).map(|(v, _)| v)).await.ok().flatten();
    let checks: Vec<_> = paths.into_iter().map(|p| tauri::async_runtime::spawn_blocking(move || folder_id(Path::new(&p), home))).collect();
    let deadline = tokio::time::Instant::now() + PATH_CHECK_TIMEOUT;
    let mut out = Vec::with_capacity(checks.len());
    for check in checks {
        out.push(match tokio::time::timeout_at(deadline, check).await {
            Ok(Ok(id)) => id,
            _ => FolderId { id: None, home: false },
        });
    }
    out
}

#[cfg(test)]
mod folder_id_tests {
    use super::*;
    use std::fs;

    #[test]
    fn same_folder_keeps_its_id_and_a_new_one_gets_another() {
        let root = std::env::temp_dir().join(format!("tf-folder-id-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Music")).unwrap();
        let music = root.join("Music");
        let first = folder_id(&music, None);
        assert!(first.id.is_some());
        assert!(!first.home);
        // Emptying the folder keeps it the same folder.
        fs::write(music.join("a.mp3"), b"x").unwrap();
        fs::remove_file(music.join("a.mp3")).unwrap();
        assert_eq!(folder_id(&music, None), first);
        // The same disk as the app's data counts as home.
        let volume = folder_identity(&music).unwrap().0;
        assert!(folder_id(&music, Some(volume)).home);
        // A folder made again at the same path is a different folder.
        fs::remove_dir_all(&music).unwrap();
        assert_eq!(folder_id(&music, None), FolderId { id: None, home: false });
        fs::create_dir_all(&music).unwrap();
        let again = folder_id(&music, None);
        assert!(again.id.is_some());
        // (NTFS and APFS never hand out the same number again; ext4 may.)
        #[cfg(any(windows, target_os = "macos"))]
        assert_ne!(again.id, first.id);
        // A file is not a folder.
        fs::write(root.join("f.txt"), b"x").unwrap();
        assert_eq!(folder_id(&root.join("f.txt"), None).id, None);
        fs::remove_dir_all(&root).unwrap();
    }
}
