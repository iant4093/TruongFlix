//! Games (Windows only): browse a user-configured repack source, install repacks with their wizard
//! hidden, verify, launch and uninstall them.

mod automation;
pub mod helper;
mod installer;
mod launch;
mod mute;
mod source;
mod verify;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use helper::{HelperEvent, HelperJob, InstallJob, JobKind, UninstallJob};

fn cache_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_job_id(job_id: &str) -> Result<&str, String> {
    if job_id.is_empty() || job_id.len() > 64 || !job_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Invalid job id".into());
    }
    Ok(job_id)
}

fn job_files(app: &AppHandle, job_id: &str) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let dir = cache_dir(app, "game-jobs")?;
    let id = safe_job_id(job_id)?;
    Ok((dir.join(format!("{id}.jsonl")), dir.join(format!("{id}.cancel")), dir.join(format!("{id}.log"))))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    job_id: String,
    event: HelperEvent,
}

async fn run_helper(app: AppHandle, job_id: String, job: JobKind) -> Result<bool, String> {
    let (progress_file, cancel_file, _) = job_files(&app, &job_id)?;
    let helper_job = HelperJob { job, progress_file, cancel_file };
    tauri::async_runtime::spawn_blocking(move || {
        helper::run_elevated(&helper_job, |event| {
            let _ = app.emit("games-job", JobEvent { job_id: job_id.clone(), event });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn games_source_get(origin: String, path: String) -> Result<source::SourceResponse, String> {
    source::get(&origin, &path).await
}

#[tauri::command]
pub async fn games_cache_image(app: AppHandle, url: String) -> Result<String, String> {
    source::cache_image(cache_dir(&app, "game-images")?, &url).await
}

#[tauri::command]
pub async fn games_inspect_installer(dir: String) -> Result<installer::InstallerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || installer::inspect(Path::new(&dir)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn games_install(app: AppHandle, job_id: String, mut job: InstallJob) -> Result<bool, String> {
    if !job.setup_exe.is_file() || job.setup_exe.extension().is_none_or(|e| !e.eq_ignore_ascii_case("exe")) {
        return Err("The installer is missing from the download folder.".into());
    }
    if !job.install_dir.is_absolute() {
        return Err("Choose an install folder.".into());
    }
    job.log_file = job_files(&app, &job_id)?.2;
    run_helper(app, job_id, JobKind::Install(job)).await
}

#[tauri::command]
pub async fn games_uninstall(app: AppHandle, job_id: String, job: UninstallJob) -> Result<bool, String> {
    if !job.install_dir.is_absolute() || job.install_dir.parent().is_none() {
        return Err("Invalid game folder.".into());
    }
    run_helper(app, job_id, JobKind::Uninstall(job)).await
}

#[tauri::command]
pub fn games_cancel(app: AppHandle, job_id: String) -> Result<(), String> {
    let (_, cancel_file, _) = job_files(&app, &job_id)?;
    std::fs::write(cancel_file, b"cancel").map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyEvent {
    job_id: String,
    progress: verify::VerifyProgress,
}

#[tauri::command]
pub async fn games_verify(app: AppHandle, job_id: String, install_dir: String) -> Result<verify::VerifyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        verify::verify(Path::new(&install_dir), |progress| {
            let _ = app.emit("games-verify", VerifyEvent { job_id: job_id.clone(), progress: progress.clone() });
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    game_id: String,
    seconds: u64,
    error: Option<String>,
}

#[tauri::command]
pub fn games_launch(app: AppHandle, game_id: String, exe: String, install_dir: String) -> Result<(), String> {
    let exe = PathBuf::from(exe);
    let dir = PathBuf::from(install_dir);
    if !exe.is_file() || !exe.starts_with(&dir) {
        return Err("The game's program file is missing. Choose it again in the game's settings.".into());
    }
    std::thread::spawn(move || {
        let event = match launch::launch_and_wait(&exe, &dir) {
            Ok(played) => SessionEvent { game_id, seconds: played.as_secs(), error: None },
            Err(e) => SessionEvent { game_id, seconds: 0, error: Some(e) },
        };
        let _ = app.emit("games-session", event);
    });
    Ok(())
}

#[tauri::command]
pub fn games_is_running(install_dir: String) -> bool {
    launch::is_running(Path::new(&install_dir))
}

#[tauri::command]
pub fn games_find_executables(install_dir: String) -> Vec<launch::ExeCandidate> {
    launch::find_executables(Path::new(&install_dir))
}

/// Free space on the drive that would hold `path` (it may not exist yet).
#[tauri::command]
pub fn games_disk_free(path: String) -> Result<u64, String> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut existing = PathBuf::from(&path);
    while !existing.exists() {
        if !existing.pop() {
            return Err("Invalid folder".into());
        }
    }
    let wide: Vec<u16> = existing.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 {
        return Err("Couldn't read free space".into());
    }
    Ok(free)
}

#[tauri::command]
pub async fn games_folder_size(dir: String) -> u64 {
    tauri::async_runtime::spawn_blocking(move || {
        walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    })
    .await
    .unwrap_or(0)
}

/// Deletes a downloaded installer folder. Only folders strictly inside the games download folder
/// may be deleted.
#[tauri::command]
pub async fn games_delete_folder(dir: String, root: String) -> Result<(), String> {
    let dir = std::fs::canonicalize(&dir).map_err(|e| format!("Couldn't find '{dir}': {e}"))?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("Couldn't find '{root}': {e}"))?;
    if dir == root || !dir.starts_with(&root) {
        return Err("Only installers inside the games download folder can be deleted.".into());
    }
    tokio::fs::remove_dir_all(&dir).await.map_err(|e| format!("Couldn't delete '{}': {e}", dir.display()))
}

/// Installed memory, used to pre-tick a repack's "limit installer to 2 GB of RAM" option on PCs
/// with 8 GB or less (WebView2 caps `navigator.deviceMemory` at 8).
#[tauri::command]
pub fn games_total_memory_gb() -> f64 {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return 16.0;
    }
    status.ullTotalPhys as f64 / (1024.0 * 1024.0 * 1024.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownFolders {
    common_desktop: String,
    user_desktop: String,
    common_programs: String,
    user_programs: String,
}

fn known_folder(id: &windows_sys::core::GUID) -> String {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;
    unsafe {
        let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
        if SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut raw) != 0 || raw.is_null() {
            return String::new();
        }
        let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
        let path = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
        CoTaskMemFree(raw as _);
        path
    }
}

/// Folders behind Inno's shortcut constants, used to find shortcuts the installer creates.
#[tauri::command]
pub fn games_known_folders() -> KnownFolders {
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_Programs, FOLDERID_PublicDesktop,
    };
    KnownFolders {
        common_desktop: known_folder(&FOLDERID_PublicDesktop),
        user_desktop: known_folder(&FOLDERID_Desktop),
        common_programs: known_folder(&FOLDERID_CommonPrograms),
        user_programs: known_folder(&FOLDERID_Programs),
    }
}
