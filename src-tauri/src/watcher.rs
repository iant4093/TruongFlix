//! Watches the media folders and emits a debounced `library-changed` event when videos are added,
//! removed or renamed, so the library updates itself without pressing Scan.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Quiet period after the last change before the library is rescanned (lets copies finish).
const DEBOUNCE: Duration = Duration::from_secs(5);

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// Changes that can affect the library: video files, or folders (which may contain videos).
fn relevant(path: &Path) -> bool {
    if path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.starts_with('.') || s.starts_with('$')
    }) {
        return false; // hidden folders, including .truongflix-trash
    }
    path.extension().is_none() || crate::scanner::has_video_extension(path)
}

/// (Re)starts watching `paths`. An empty list stops watching.
#[tauri::command]
pub fn watch_folders(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let mut slot = WATCHER.lock().unwrap();
    *slot = None; // drop the old watcher first
    if paths.is_empty() {
        return Ok(0);
    }
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))) {
                for p in event.paths {
                    if relevant(&p) {
                        let _ = tx.send(p);
                    }
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
