//! Library file management: tidying loose files into folders, and a per-library
//! "Recently Deleted" trash that lives on the same volume (so deleting is an instant rename).

use crate::scanner::{has_video_extension, is_hidden_name, is_hidden_or_system, is_library_video};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

pub const TRASH_DIR: &str = ".truongflix-trash";
/// Files that belong to a video and should travel with it (subtitles, metadata, artwork).
const SIDECAR_EXTENSIONS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx", "nfo", "jpg", "jpeg", "png", "webp"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileMove {
    pub from: String,
    pub to: String,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn is_video(p: &Path) -> bool {
    has_video_extension(p) && is_library_video(p, file_size(p))
}

fn is_sidecar(p: &Path) -> bool {
    p.extension()
        .map(|e| SIDECAR_EXTENSIONS.contains(&e.to_string_lossy().to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn visible_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| !is_hidden_name(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    out.sort();
    out
}

/// Maps each video in `dir` to its sidecars. A sidecar belongs to the video with the *longest*
/// matching name prefix, so `Alien.Covenant.en.srt` goes with `Alien.Covenant.mkv`, not `Alien.mkv`.
fn sidecars_by_video(dir: &Path) -> HashMap<PathBuf, Vec<PathBuf>> {
    let files = visible_files(dir);
    let videos: Vec<(PathBuf, String)> = files
        .iter()
        .filter(|p| has_video_extension(p))
        .filter_map(|p| Some((p.clone(), p.file_stem()?.to_string_lossy().to_lowercase())))
        .collect();
    let mut map: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for f in files.iter().filter(|p| is_sidecar(p)) {
        let name = f.file_name().unwrap().to_string_lossy().to_lowercase();
        let owner = videos
            .iter()
            .filter(|(_, stem)| {
                name.strip_prefix(stem.as_str())
                    .is_some_and(|rest| rest.starts_with(['.', '-', '_', ' ']))
            })
            .max_by_key(|(_, stem)| stem.len());
        if let Some((video, _)) = owner {
            map.entry(video.clone()).or_default().push(f.clone());
        }
    }
    map
}

// ---------------------------------------------------------------------------
// Organize loose files
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize)]
pub struct OrganizeResult {
    moved: Vec<FileMove>,
    errors: Vec<String>,
}

/// Windows rejects folder names ending in dots/spaces.
fn folder_name_for(video: &Path) -> Option<String> {
    let stem = video.file_stem()?.to_string_lossy();
    let name = stem.trim().trim_end_matches(['.', ' ']).to_owned();
    (!name.is_empty()).then_some(name)
}

fn organize_root(root: &Path, out: &mut OrganizeResult) {
    let sidecars = sidecars_by_video(root);
    for video in visible_files(root).into_iter().filter(|p| is_video(p)) {
        let Some(folder) = folder_name_for(&video) else { continue };
        let target_dir = root.join(&folder);
        if target_dir.exists() && !target_dir.is_dir() {
            out.errors.push(format!("{}: a file named “{folder}” is in the way", s(&video)));
            continue;
        }
        let dest = target_dir.join(video.file_name().unwrap());
        if dest.exists() {
            out.errors.push(format!("{}: “{}” already exists", s(&video), s(&dest)));
            continue;
        }
        let created = !target_dir.exists();
        if let Err(e) = std::fs::create_dir_all(&target_dir) {
            out.errors.push(format!("{}: {e}", s(&video)));
            continue;
        }
        if let Err(e) = std::fs::rename(&video, &dest) {
            out.errors.push(format!("{}: {e}", s(&video)));
            if created {
                let _ = std::fs::remove_dir(&target_dir);
            }
            continue;
        }
        out.moved.push(FileMove { from: s(&video), to: s(&dest) });
        for side in sidecars.get(&video).into_iter().flatten() {
            let side_dest = target_dir.join(side.file_name().unwrap());
            if !side_dest.exists() && std::fs::rename(side, &side_dest).is_ok() {
                out.moved.push(FileMove { from: s(side), to: s(&side_dest) });
            }
        }
    }
}

/// Moves videos sitting directly in a media root into a folder named after the file,
/// bringing their subtitles/artwork along. Already-foldered videos are untouched.
#[tauri::command]
pub async fn organize_loose_files(roots: Vec<String>) -> Result<OrganizeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = OrganizeResult::default();
        for root in roots {
            let root = PathBuf::from(root);
            if root.is_dir() {
                organize_root(&root, &mut out);
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Rename (Plex-style naming) and undo
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize)]
pub struct MoveResult {
    applied: Vec<FileMove>,
    errors: Vec<String>,
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Renames `from` to `to`, creating folders. Handles case-only renames on case-insensitive disks.
fn move_one(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if to.exists() {
        if !same_file(from, to) {
            return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "destination already exists"));
        }
        let tmp = to.with_extension(format!("{}.tfx-rename", to.extension().map(|e| e.to_string_lossy()).unwrap_or_default()));
        std::fs::rename(from, &tmp)?;
        return std::fs::rename(&tmp, to);
    }
    std::fs::rename(from, to)
}

/// Removes now-empty folders (ignoring OS junk files), walking up but never removing a root.
fn prune_empty_dirs(start: &Path, roots: &[PathBuf]) {
    let mut dir = start.to_path_buf();
    loop {
        if roots.iter().any(|r| r == &dir) || !roots.iter().any(|r| dir.starts_with(r)) {
            return;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        let entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        let junk = |p: &PathBuf| p.file_name().is_some_and(|n| n == ".DS_Store" || n == "Thumbs.db" || n == "desktop.ini");
        if entries.iter().any(|p| !junk(p)) {
            return;
        }
        for j in &entries {
            let _ = std::fs::remove_file(j);
        }
        if std::fs::remove_dir(&dir).is_err() {
            return;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return,
        }
    }
}

fn apply_moves_inner(moves: &[FileMove], with_sidecars: bool, roots: &[PathBuf]) -> MoveResult {
    let mut out = MoveResult::default();
    let mut touched_dirs = Vec::new();
    for FileMove { from, to } in moves {
        let (src, dest) = (Path::new(from), Path::new(to));
        if src == dest {
            continue;
        }
        if !src.exists() {
            out.errors.push(format!("{from}: file not found"));
            continue;
        }
        // Collect sidecars before the video moves (they're matched by its old name).
        let sidecars = if with_sidecars {
            src.parent().and_then(|p| sidecars_by_video(p).remove(src)).unwrap_or_default()
        } else {
            Vec::new()
        };
        if let Err(e) = move_one(src, dest) {
            out.errors.push(format!("{from}: {e}"));
            continue;
        }
        out.applied.push(FileMove { from: from.clone(), to: to.clone() });
        if let Some(p) = src.parent() {
            touched_dirs.push(p.to_path_buf());
        }
        let old_stem = src.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let new_stem = dest.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        for side in sidecars {
            let name = side.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let suffix = &name[old_stem.len().min(name.len())..];
            let side_dest = dest.with_file_name(format!("{new_stem}{suffix}"));
            if move_one(&side, &side_dest).is_ok() {
                out.applied.push(FileMove { from: s(&side), to: s(&side_dest) });
            }
        }
    }
    touched_dirs.sort();
    touched_dirs.dedup();
    for d in touched_dirs.iter().rev() {
        prune_empty_dirs(d, roots);
    }
    out
}

/// Applies planned renames. With `with_sidecars`, each video's subtitles/.nfo/artwork follow it
/// (renamed to the new name); undo passes the exact recorded list with `with_sidecars = false`.
#[tauri::command]
pub async fn apply_moves(moves: Vec<FileMove>, with_sidecars: bool, roots: Vec<String>) -> Result<MoveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = roots.iter().map(|r| PathBuf::from(r.trim_end_matches(['/', '\\']))).collect();
        apply_moves_inner(&moves, with_sidecars, &roots)
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Trash ("Recently Deleted")
// ---------------------------------------------------------------------------

fn strictly_inside(path: &Path, root: &Path) -> bool {
    path != root && path.starts_with(root)
}

fn videos_under(dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| !is_hidden_or_system(e))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_video(e.path()))
        .map(|e| e.into_path())
        .collect()
}

/// Decides what to move for a set of videos: the highest folder (below the media root) that
/// contains nothing but these videos — e.g. a movie's folder or a whole show — otherwise
/// just the video files plus their sidecars.
fn plan_trash(videos: &[PathBuf], root: &Path) -> Vec<PathBuf> {
    let wanted: HashSet<&PathBuf> = videos.iter().collect();
    let mut owned_cache: HashMap<PathBuf, bool> = HashMap::new();
    let mut targets = Vec::new();
    for video in videos {
        let mut best = None;
        let mut cur = video.parent();
        while let Some(dir) = cur {
            if !strictly_inside(dir, root) {
                break;
            }
            let owned = *owned_cache
                .entry(dir.to_path_buf())
                .or_insert_with(|| videos_under(dir).iter().all(|v| wanted.contains(v)));
            if !owned {
                break;
            }
            best = Some(dir.to_path_buf());
            cur = dir.parent();
        }
        match best {
            Some(dir) => targets.push(dir),
            None => {
                targets.push(video.clone());
                if let Some(parent) = video.parent() {
                    targets.extend(sidecars_by_video(parent).remove(video).unwrap_or_default());
                }
            }
        }
    }
    targets.sort();
    targets.dedup();
    let all = targets.clone();
    targets.retain(|t| !all.iter().any(|o| o != t && t.starts_with(o)));
    targets
}

fn path_size(p: &Path) -> u64 {
    if p.is_file() {
        return file_size(p);
    }
    WalkDir::new(p).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).map(|e| file_size(e.path())).sum()
}

fn entry_name() -> String {
    use std::hash::{BuildHasher, Hasher};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(now.as_nanos());
    format!("{}-{:08x}", now.as_secs(), h.finish() as u32)
}

#[derive(Debug, Serialize)]
pub struct TrashResult {
    entry_dir: String,
    items: Vec<FileMove>,
    size_bytes: u64,
}

fn trash_paths(videos: &[PathBuf], root: &Path) -> Result<TrashResult, String> {
    let first = videos.first().ok_or("Nothing to delete")?;
    // Keep the trash on the same volume as the files so deleting is a rename, never a copy.
    let root = if strictly_inside(first, root) { root.to_path_buf() } else { first.parent().ok_or("Invalid path")?.to_path_buf() };
    let targets = plan_trash(videos, &root);
    let entry = root.join(TRASH_DIR).join(entry_name());
    let mut items = Vec::new();
    let mut size = 0;
    for (i, target) in targets.iter().enumerate() {
        if !target.exists() {
            continue;
        }
        let slot = entry.join(i.to_string());
        let dest = slot.join(target.file_name().ok_or("Invalid path")?);
        let moved = std::fs::create_dir_all(&slot).and_then(|_| {
            size += path_size(target);
            std::fs::rename(target, &dest)
        });
        if let Err(e) = moved {
            // Roll back so a half-finished delete never leaves the library inconsistent.
            for m in items.iter().rev() {
                let FileMove { from, to } = m;
                let _ = std::fs::rename(to, from);
            }
            let _ = std::fs::remove_dir_all(&entry);
            return Err(format!("Couldn’t delete “{}”: {e}", s(target)));
        }
        items.push(FileMove { from: s(target), to: s(&dest) });
    }
    if items.is_empty() {
        let _ = std::fs::remove_dir_all(&entry);
        return Err("The files no longer exist on disk.".into());
    }
    Ok(TrashResult { entry_dir: s(&entry), items, size_bytes: size })
}

/// Moves a movie/episode/show's files into `<media root>/.truongflix-trash/<entry>/`.
#[tauri::command]
pub async fn trash_media(video_paths: Vec<String>, root: String) -> Result<TrashResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let videos: Vec<PathBuf> = video_paths.into_iter().map(PathBuf::from).collect();
        trash_paths(&videos, Path::new(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
pub struct RestoreResult {
    restored: usize,
    conflicts: Vec<String>,
}

fn is_trash_entry(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str() == TRASH_DIR) && p.file_name().is_some_and(|n| n != TRASH_DIR)
}

/// Moves trashed items back to where they came from (skipping anything that's been replaced).
#[tauri::command]
pub fn restore_trash(entry_dir: String, items: Vec<FileMove>) -> Result<RestoreResult, String> {
    let entry = PathBuf::from(&entry_dir);
    if !is_trash_entry(&entry) {
        return Err("Not a TruongFlix trash entry".into());
    }
    let mut restored = 0;
    let mut conflicts = Vec::new();
    for FileMove { from, to } in &items {
        let (original, trashed) = (Path::new(from), Path::new(to));
        if original.exists() {
            conflicts.push(from.clone());
            continue;
        }
        if !trashed.exists() {
            continue;
        }
        if let Some(parent) = original.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(trashed, original).map_err(|e| format!("Couldn’t restore “{from}”: {e}"))?;
        restored += 1;
    }
    if conflicts.is_empty() {
        let _ = std::fs::remove_dir_all(&entry);
    }
    Ok(RestoreResult { restored, conflicts })
}

/// Permanently deletes one trash entry.
#[tauri::command]
pub async fn purge_trash(entry_dir: String) -> Result<(), String> {
    let entry = PathBuf::from(&entry_dir);
    if !is_trash_entry(&entry) {
        return Err("Not a TruongFlix trash entry".into());
    }
    tauri::async_runtime::spawn_blocking(move || match std::fs::remove_dir_all(&entry) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens Finder / File Explorer with the file selected.
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let target = if p.exists() { p } else { p.parent().filter(|d| d.exists()).ok_or("Path not found")? };
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(target).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(format!("/select,{}", target.display())).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = Command::new("xdg-open").arg(target.parent().unwrap_or(target)).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const BIG: u64 = 100 * 1024 * 1024;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("truongflix-files-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn touch(path: &Path, size: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path).unwrap().set_len(size).unwrap();
    }

    fn rel(root: &Path, p: &str) -> String {
        Path::new(p).strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn organizes_loose_videos_with_their_sidecars() {
        let root = temp_root("organize");
        touch(&root.join("Alien.1979.mkv"), BIG);
        touch(&root.join("Alien.1979.en.srt"), 10);
        touch(&root.join("Alien.Covenant.2017.mkv"), BIG);
        touch(&root.join("Alien.Covenant.2017.en.srt"), 10);
        touch(&root.join("Alien.Covenant.2017.nfo"), 10);
        touch(&root.join("Trailer.mkv"), 1024); // small extra: ignored
        touch(&root.join("Already Foldered (2020)/movie.mkv"), BIG);

        let mut out = OrganizeResult::default();
        organize_root(&root, &mut out);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let mut moved: Vec<_> = out.moved.iter().map(|m| (rel(&root, &m.from), rel(&root, &m.to))).collect();
        moved.sort();
        assert_eq!(
            moved,
            [
                ("Alien.1979.en.srt".into(), "Alien.1979/Alien.1979.en.srt".into()),
                ("Alien.1979.mkv".into(), "Alien.1979/Alien.1979.mkv".into()),
                ("Alien.Covenant.2017.en.srt".into(), "Alien.Covenant.2017/Alien.Covenant.2017.en.srt".into()),
                ("Alien.Covenant.2017.mkv".into(), "Alien.Covenant.2017/Alien.Covenant.2017.mkv".into()),
                ("Alien.Covenant.2017.nfo".into(), "Alien.Covenant.2017/Alien.Covenant.2017.nfo".into()),
            ]
            .map(|(a, b): (String, String)| (a, b))
        );
        assert!(root.join("Trailer.mkv").exists());
        assert!(root.join("Already Foldered (2020)/movie.mkv").exists());

        // Running again is a no-op.
        let mut again = OrganizeResult::default();
        organize_root(&root, &mut again);
        assert!(again.moved.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn renames_with_sidecars_and_undoes() {
        let root = temp_root("rename");
        let video = root.join("Downloads Mess/the.matrix.1999.1080p.mkv");
        touch(&video, BIG);
        touch(&root.join("Downloads Mess/the.matrix.1999.1080p.en.srt"), 10);
        touch(&root.join("Downloads Mess/.DS_Store"), 10);
        let dest = root.join("The Matrix (1999)/The Matrix (1999).mkv");
        let roots = vec![root.clone()];
        let res = apply_moves_inner(&[FileMove { from: s(&video), to: s(&dest) }], true, &roots);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(dest.exists());
        assert!(root.join("The Matrix (1999)/The Matrix (1999).en.srt").exists());
        assert!(!root.join("Downloads Mess").exists(), "empty source folder should be pruned");

        // Undo: exact reverse of what was applied.
        let reverse: Vec<FileMove> = res.applied.iter().rev().map(|m| FileMove { from: m.to.clone(), to: m.from.clone() }).collect();
        let undo = apply_moves_inner(&reverse, false, &roots);
        assert!(undo.errors.is_empty(), "{:?}", undo.errors);
        assert!(video.exists() && root.join("Downloads Mess/the.matrix.1999.1080p.en.srt").exists());
        assert!(!root.join("The Matrix (1999)").exists());

        // Case-only rename works on case-insensitive filesystems too.
        let upper = root.join("Downloads Mess/The.Matrix.1999.1080p.mkv");
        let res = apply_moves_inner(&[FileMove { from: s(&video), to: s(&upper) }], false, &roots);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(upper.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn trash_takes_owned_folders_and_restores() {
        let root = temp_root("trash");
        let movie = root.join("Movies/Dune (2021)/Dune.2021.mkv");
        touch(&movie, BIG);
        touch(&root.join("Movies/Dune (2021)/Dune.2021.en.srt"), 10);
        let e1 = root.join("Shows/Severance/Season 01/S01E01.mkv");
        let e2 = root.join("Shows/Severance/Season 01/S01E02.mkv");
        touch(&e1, BIG);
        touch(&e2, BIG);
        touch(&root.join("Shows/Severance/Season 01/S01E01.en.srt"), 10);
        let loose = root.join("Loose.Movie.mkv");
        touch(&loose, BIG);
        touch(&root.join("Loose.Movie.en.srt"), 10);
        touch(&root.join("Loose.Movie.Two.mkv"), BIG);

        let movies_root = root.join("Movies");
        // A movie in its own folder: the whole folder goes.
        assert_eq!(plan_trash(&[movie.clone()], &movies_root), [root.join("Movies/Dune (2021)")]);
        // One episode of several: just that file + its subtitle.
        let shows_root = root.join("Shows");
        assert_eq!(
            plan_trash(&[e1.clone()], &shows_root),
            [root.join("Shows/Severance/Season 01/S01E01.en.srt"), e1.clone()]
        );
        // Every episode: the whole show folder.
        assert_eq!(plan_trash(&[e1.clone(), e2.clone()], &shows_root), [root.join("Shows/Severance")]);
        // Loose file in the root: file + its own sidecar only (not Loose.Movie.Two).
        assert_eq!(plan_trash(&[loose.clone()], &root), [root.join("Loose.Movie.en.srt"), loose.clone()]);

        let res = trash_paths(&[e1.clone(), e2.clone()], &shows_root).unwrap();
        assert!(!root.join("Shows/Severance").exists());
        assert!(res.entry_dir.contains(TRASH_DIR));
        assert_eq!(res.size_bytes, BIG * 2 + 10);

        let restored = restore_trash(res.entry_dir.clone(), res.items).unwrap();
        assert_eq!(restored.restored, 1);
        assert!(e1.exists() && e2.exists());
        assert!(!Path::new(&res.entry_dir).exists());

        // Purge refuses paths outside the trash.
        assert!(tauri::async_runtime::block_on(purge_trash(s(&root))).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
