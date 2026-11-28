//! Watches the media and music folders and emits a debounced `library-changed` event when videos or
//! songs are added, removed or renamed, so the library updates itself without pressing Scan.

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Quiet period after the last change before the library is rescanned (lets copies finish).
const DEBOUNCE: Duration = Duration::from_secs(5);

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// Files that are never library videos or songs (pictures, subtitles, downloads still running):
/// changes to these alone don't rescan.
const OTHER_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "nfo", "txt", "lrc", "srt", "ass", "ssa", "sub", "idx", "vtt", "log", "ini", "db",
    "tmp", "part", "partial", "crdownload", "download", "!qb", "aria2", "json", "xml", "cue", "m3u", "m3u8", "pdf", "url", "lnk",
    "sfv", "md5", "torrent",
];

/// Changes that can affect the library: video or audio files, or folders (which may contain them).
/// A removed or renamed path can't be asked what it was, and folder names often have a dot
/// ("Vol. 2", "Mr.Robot.S01"), so for those anything that isn't a known other kind of file counts:
/// deleting an album folder (or moving it to the Trash on a Mac) removes its songs.
fn relevant(path: &Path, kind: &EventKind) -> bool {
    if path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.starts_with('.') || s.starts_with('$')
    }) {
        return false; // hidden folders, including .truongflix-trash
    }
    let Some(ext) = path.extension() else { return true };
    if crate::scanner::has_video_extension(path) || crate::music::has_audio_extension(path) {
        return true;
    }
    let gone = matches!(kind, EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)));
    gone && !OTHER_EXTENSIONS.contains(&ext.to_string_lossy().to_ascii_lowercase().as_str())
}

/// Kinds of change that add, remove or rename things. Windows reports a file moved to the Recycle
/// Bin as removed; macOS reports one moved to the Trash as renamed (its new place is outside the
/// watched folders), and deleted folders as removed folders.
fn adds_or_removes(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)))
}

/// (Re)starts watching `paths`. An empty list stops watching. Runs off the async runtime: setting
/// up recursive watches (or touching an offline share) can take a while.
#[tauri::command]
pub async fn watch_folders(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || watch_blocking(app, paths)).await.map_err(|e| e.to_string())?
}

fn watch_blocking(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let mut slot = WATCHER.lock().unwrap();
    *slot = None; // drop the old watcher first
    if paths.is_empty() {
        return Ok(0);
    }
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Changes were dropped (macOS asks for the folders to be looked at again): rescan.
        if event.need_rescan() {
            let _ = tx.send(event.paths.first().cloned().unwrap_or_default());
            return;
        }
        if adds_or_removes(&event.kind) {
            for p in event.paths {
                if relevant(&p, &event.kind) {
                    let _ = tx.send(p);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    let mut watched = 0;
    for p in &paths {
        if Path::new(p).is_dir() && watcher.watch(Path::new(p), RecursiveMode::Recursive).is_ok() {
            watched += 1;
        }
    }
    *slot = Some(watcher);

    // Debounce: wait for a quiet period, then emit once. The thread ends when the watcher is
    // dropped (its sender closes the channel).
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut changed = vec![first];
            while let Ok(p) = rx.recv_timeout(DEBOUNCE) {
                changed.push(p);
            }
            changed.sort();
            changed.dedup();
            let paths: Vec<String> = changed.iter().take(50).map(|p| p.to_string_lossy().into_owned()).collect();
            let _ = app.emit("library-changed", paths);
        }
    });
    Ok(watched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, RemoveKind, RenameMode};

    #[test]
    fn removed_songs_videos_and_folders_count() {
        let removed = EventKind::Remove(RemoveKind::Any);
        let trashed = EventKind::Modify(ModifyKind::Name(RenameMode::Any)); // macOS Finder: Move to Trash
        let created = EventKind::Create(CreateKind::Any);
        for kind in [&removed, &trashed, &created] {
            assert!(relevant(Path::new("/m/Artist/Album/01 Song.flac"), kind));
            assert!(relevant(Path::new(r"C:\Videos\Movie (2020)\Movie.mkv"), kind));
            assert!(relevant(Path::new("/m/Artist"), kind));
            assert!(!relevant(Path::new("/m/Artist/Album/cover.jpg"), kind));
            assert!(!relevant(Path::new("/m/.truongflix-trash/x.mp3"), kind));
        }
        // A deleted folder whose name has a dot.
        assert!(relevant(Path::new("/m/Artist/Greatest Hits Vol. 2"), &removed));
        assert!(relevant(Path::new(r"D:\TV\Mr.Robot.S01"), &trashed));
        // A new one is seen through the songs copied into it.
        assert!(!relevant(Path::new("/m/Artist/Greatest Hits Vol. 2"), &created));
        assert!(!relevant(Path::new("/m/a.mp3.part"), &removed));
    }

    #[test]
    fn only_adds_removes_and_renames() {
        assert!(adds_or_removes(&EventKind::Remove(RemoveKind::Folder)));
        assert!(adds_or_removes(&EventKind::Modify(ModifyKind::Name(RenameMode::From))));
        assert!(!adds_or_removes(&EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content))));
        assert!(!adds_or_removes(&EventKind::Access(notify::event::AccessKind::Any)));
    }
}
