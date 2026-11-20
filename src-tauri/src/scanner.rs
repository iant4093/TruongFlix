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
    let parent = path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if EXTRAS_FOLDERS.contains(&parent.as_str()) {
        return false;
    }
    if EXTRAS_FOLDERS_IN_TITLE.contains(&parent.as_str()) {
        // A title folder carries its year: "Inception (2010)", "Severance (2022)".
        let title = path.parent().and_then(|p| p.parent()).and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let has_year = title.as_bytes().windows(6).any(|w| (w[0] == b'(' || w[0] == b'[') && w[1..5].iter().all(u8::is_ascii_digit) && (w[5] == b')' || w[5] == b']'));
        if has_year {
            return false;
        }
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
        assert_eq!(names, ["Big.Trailer.Cut.2020.mkv", "Extras.S01E01.mkv", "Piper (2016).mkv", "S01E01.mkv", "The-Interview.mkv", "d-dune2-2160p.mkv"]);

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
