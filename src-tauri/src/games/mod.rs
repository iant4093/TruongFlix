//! Games (Windows only): browse a user-configured repack source, install repacks with their wizard
//! hidden, verify, launch and uninstall them.

mod automation;
mod guard;
pub mod helper;
mod installer;
mod launch;
mod mute;
mod source;
mod store;
mod verify;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use guard::Protected;
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

fn job_files(app: &AppHandle, job_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let dir = cache_dir(app, "game-jobs")?;
    let id = safe_job_id(job_id)?;
    Ok((dir.join(format!("{id}.jsonl")), dir.join(format!("{id}.cancel"))))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    job_id: String,
    event: HelperEvent,
}

async fn run_helper(app: AppHandle, job_id: String, job: JobKind) -> Result<bool, String> {
    let (progress_file, cancel_file) = job_files(&app, &job_id)?;
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
    blocking(move || installer::inspect(Path::new(&dir))).await?
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())
}

async fn download_root(app: &AppHandle) -> Result<String, String> {
    store::setting(app, "games_download_dir")
        .await?
        .ok_or_else(|| "Choose a folder for game downloads in Settings › Games.".to_string())
}

/// The install dialog's choices. Everything else comes from the library and the installer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    install_dir: PathBuf,
    language: Option<String>,
    components: Option<Vec<String>>,
    tasks: Option<Vec<String>>,
    no_icons: bool,
    limit_ram: Option<bool>,
    remove_shortcuts: Vec<PathBuf>,
    /// Indices into the installer's after-install (`[Run]`) entries.
    post_actions: Vec<usize>,
}

#[tauri::command]
pub async fn games_install(app: AppHandle, job_id: String, game_id: i64, job: InstallRequest) -> Result<bool, String> {
    safe_job_id(&job_id)?;
    let game = store::game(&app, game_id).await?;
    let installer_dir = game.installer_dir.ok_or("The installer for this game was not found.")?;
    let root = download_root(&app).await?;
    let job = blocking(move || {
        let setup_exe = installer::find_setup(Path::new(&installer_dir))
            .ok_or("The installer is missing from the games download folder.")?;
        let job = InstallJob {
            setup_exe,
            download_root: PathBuf::from(root),
            install_dir: job.install_dir,
            language: job.language,
            components: job.components,
            tasks: job.tasks,
            no_icons: job.no_icons,
            limit_ram: job.limit_ram,
            remove_shortcuts: job.remove_shortcuts,
            post_actions: job.post_actions,
        };
        helper::check_install(&job, &Protected::system(), &guard::shortcut_roots())?;
        Ok::<_, String>(job)
    })
    .await??;
    run_helper(app, job_id, JobKind::Install(job)).await
}

#[tauri::command]
pub async fn games_uninstall(app: AppHandle, job_id: String, game_id: i64) -> Result<bool, String> {
    safe_job_id(&job_id)?;
    let game = store::game(&app, game_id).await?;
    let Some(dir) = game.install_dir else {
        return Ok(true);
    };
    let install_dir = blocking(move || {
        if !Path::new(&dir).exists() {
            return Ok(None);
        }
        guard::uninstall_target(Path::new(&dir), &Protected::system()).map(|(dir, _)| Some(dir))
    })
    .await??;
    match install_dir {
        Some(install_dir) => run_helper(app, job_id, JobKind::Uninstall(UninstallJob { install_dir })).await,
        None => Ok(true),
    }
}

#[tauri::command]
pub fn games_cancel(app: AppHandle, job_id: String) -> Result<(), String> {
    let (_, cancel_file) = job_files(&app, &job_id)?;
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
    blocking(move || {
        verify::verify(Path::new(&install_dir), |progress| {
            let _ = app.emit("games-verify", VerifyEvent { job_id: job_id.clone(), progress: progress.clone() });
        })
    })
    .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    game_id: String,
    seconds: u64,
    error: Option<String>,
}

/// Starts the program recorded for the game, which must be inside its install folder.
#[tauri::command]
pub async fn games_launch(app: AppHandle, game_id: i64) -> Result<(), String> {
    let game = store::game(&app, game_id).await?;
    let missing = "The game's program file is missing. Choose it again in the game's settings.";
    let (Some(exe), Some(dir)) = (game.exe_path, game.install_dir) else {
        return Err(missing.into());
    };
    let (exe, dir) = blocking(move || {
        let dir = guard::plain(&std::fs::canonicalize(&dir).map_err(|_| missing)?);
        let exe = guard::plain(&std::fs::canonicalize(&exe).map_err(|_| missing)?);
        let is_exe = exe.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
        if !exe.is_file() || !is_exe || !guard::strictly_inside(&exe, &dir) || Protected::system().covers(&dir) {
            return Err(missing.to_string());
        }
        Ok((exe, dir))
    })
    .await??;
    std::thread::spawn(move || {
        let game_id = game_id.to_string();
        let event = match launch::launch_and_wait(&exe, &dir) {
            Ok(played) => SessionEvent { game_id, seconds: played.as_secs(), error: None },
            Err(e) => SessionEvent { game_id, seconds: 0, error: Some(e) },
        };
        let _ = app.emit("games-session", event);
    });
    Ok(())
}

#[tauri::command]
pub async fn games_is_running(install_dir: String) -> bool {
    blocking(move || launch::is_running(Path::new(&install_dir))).await.unwrap_or(false)
}

#[tauri::command]
pub async fn games_find_executables(install_dir: String) -> Vec<launch::ExeCandidate> {
    blocking(move || launch::find_executables(Path::new(&install_dir))).await.unwrap_or_default()
}

/// Free space on the drive that would hold `path` (it may not exist yet).
#[tauri::command]
pub async fn games_disk_free(path: String) -> Result<u64, String> {
    blocking(move || disk_free(PathBuf::from(path))).await?
}

fn disk_free(mut existing: PathBuf) -> Result<u64, String> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
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
    blocking(move || {
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

/// Deletes a game's downloaded installer: the folder its torrent was saved to (or the installer
/// folder), which must be strictly inside the games download folder.
#[tauri::command]
pub async fn games_delete_folder(app: AppHandle, game_id: i64) -> Result<(), String> {
    let game = store::game(&app, game_id).await?;
    let saved = match &game.info_hash {
        Some(hash) => store::torrent_save_path(&app, hash).await?,
        None => None,
    };
    let Some(target) = saved.or(game.installer_dir) else {
        return Ok(());
    };
    let root = download_root(&app).await?;
    let dir = blocking(move || {
        if !Path::new(&target).exists() {
            return Ok(None);
        }
        let refused = "Only installers inside the games download folder can be deleted.";
        let protected = Protected::system();
        let root = guard::download_root(Path::new(&root), &protected)?;
        let dir = guard::existing_inside(Path::new(&target), &root).map_err(|_| refused)?;
        if !dir.is_dir() || protected.covers(&dir) {
            return Err(refused.to_string());
        }
        Ok(Some(dir))
    })
    .await??;
    match dir {
        Some(dir) => tokio::fs::remove_dir_all(&dir).await.map_err(|e| format!("Couldn't delete '{}': {e}", dir.display())),
        None => Ok(()),
    }
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

/// Folders behind Inno's shortcut constants, used to find shortcuts the installer creates.
#[tauri::command]
pub fn games_known_folders() -> KnownFolders {
    use guard::known_folder;
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
