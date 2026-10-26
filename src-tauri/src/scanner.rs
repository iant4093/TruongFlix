use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::{DirEntry, WalkDir};

const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts"];
const EXTRA_KEYWORDS: &[&str] = &["sample", "trailer", "featurette"];
const EXTRA_MAX_BYTES: u64 = 60 * 1024 * 1024;
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
    !(size < EXTRA_MAX_BYTES && EXTRA_KEYWORDS.iter().any(|k| lower.contains(k)))
}

fn folder_name(path: Option<&Path>) -> String {
    path.and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn walk_root(root: &str, seen: &mut HashSet<String>, out: &mut Vec<RawVideoFile>) {
    let walker = WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| !is_hidden_or_system(e));

    for entry in walker.filter_map(Result::ok) {
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
            Err(_) => continue,
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

/// Recursively walks every media directory and returns all playable video files.
/// Runs on a blocking worker so large libraries never stall the UI thread.
#[tauri::command]
pub async fn scan_media_folders(paths: Vec<String>) -> Result<Vec<RawVideoFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for root in &paths {
            walk_root(root, &mut seen, &mut out);
        }
        out
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

        let mut seen = HashSet::new();
        let mut out = Vec::new();
        walk_root(root.to_str().unwrap(), &mut seen, &mut out);
        let mut names: Vec<_> = out.iter().map(|f| f.filename.as_str()).collect();
        names.sort();
        assert_eq!(names, ["Big.Trailer.Cut.2020.mkv", "S01E01.mkv", "d-dune2-2160p.mkv"]);

        let ep = out.iter().find(|f| f.filename == "S01E01.mkv").unwrap();
        assert_eq!(ep.parent_folder_name, "Season 01");
        assert_eq!(ep.grandparent_folder_name, "Severance (2022)");
        assert!(ep.mtime > 0);
        fs::remove_dir_all(&root).unwrap();
    }
}

/// Reports which media roots are currently reachable (e.g. external drives mounted),
/// so the frontend never prunes a library just because a disk is unplugged.
#[tauri::command]
pub fn check_paths(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_dir()).collect()
}
