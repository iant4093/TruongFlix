//! Starts installed games and measures play time, including games whose launcher exits after
//! starting the real game process from the same folder.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, INFINITE, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A running process: its executable and when it started (ms since 1970), when Windows says.
struct Running {
    image: PathBuf,
    started_ms: Option<u64>,
}

/// Every process whose executable path can be read (elevated games included: limited query
/// rights are enough).
fn running_processes() -> Vec<Running> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !handle.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0 {
                        let image = PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]));
                        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
                        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
                        let started_ms = if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0 {
                            filetime_ms(created)
                        } else {
                            None
                        };
                        out.push(Running { image, started_ms });
                    }
                    CloseHandle(handle);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// A FILETIME (100 ns ticks since 1601) as ms since 1970.
fn filetime_ms(t: FILETIME) -> Option<u64> {
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
    let ticks = ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    ticks.checked_sub(UNIX_EPOCH_TICKS).map(|t| t / 10_000)
}

pub fn is_running(dir: &Path) -> bool {
    running_processes().iter().any(|p| super::guard::strictly_inside(&p.image, dir))
}

/// Whether a program in a game's folder is the game (or its launcher) rather than its
/// uninstaller, installer, redistributable or crash reporter.
fn is_game_program(image: &Path) -> bool {
    let name = image.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    !NOT_THE_GAME.iter().any(|w| name.contains(w)) || name.contains("launcher")
}

/// For each game folder, when the earliest game program running from it started (ms since
/// 1970), or `None` when none runs. A program whose start time can't be read counts as just
/// started.
fn earliest_in(processes: &[Running], dirs: &[PathBuf], now_ms: u64) -> Vec<Option<u64>> {
    dirs.iter()
        .map(|dir| {
            processes
                .iter()
                .filter(|p| super::guard::strictly_inside(&p.image, dir) && is_game_program(&p.image))
                .map(|p| p.started_ms.unwrap_or(now_ms).min(now_ms))
                .min()
        })
        .collect()
}

/// When a game started from each folder has been running (one look at the process list for all).
pub fn running_since(dirs: &[PathBuf]) -> Vec<Option<u64>> {
    if dirs.is_empty() {
        return Vec::new();
    }
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    earliest_in(&running_processes(), dirs, now_ms)
}

/// Starts the game through the shell (so games that require administrator rights get their UAC
/// prompt) and blocks until it and any processes it started from its folder have exited.
/// Returns the play time.
pub fn launch_and_wait(exe: &Path, install_dir: &Path) -> Result<Duration, String> {
    let verb = wide("open");
    let file = wide(&exe.to_string_lossy());
    let dir = wide(&exe.parent().unwrap_or(install_dir).to_string_lossy());
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpDirectory = dir.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(format!("Couldn't start {}", exe.display()));
    }
    let started = Instant::now();
    let process: HANDLE = info.hProcess;
    if !process.is_null() {
        unsafe {
            WaitForSingleObject(process, INFINITE);
            CloseHandle(process);
        }
    }
    // Launchers often exit right after starting the game; keep counting while anything from the
    // game folder runs (checking a few times first, as the game may take a moment to appear).
    let mut idle_checks = 0;
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if is_running(install_dir) {
            idle_checks = 0;
        } else {
            idle_checks += 1;
            if idle_checks >= 3 {
                break;
            }
        }
    }
    Ok(started.elapsed().saturating_sub(Duration::from_secs(6)))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExeCandidate {
    pub path: String,
    pub size: u64,
}

const NOT_THE_GAME: &[&str] = &[
    "unins", "uninst", "setup", "install", "update", "patch", "config", "crash", "report", "redist",
    "vc_redist", "vcredist", "dxsetup", "dxwebsetup", "dotnet", "physx", "oalinst", "ue4prereq",
    "ueprereq", "prereq", "quicksfv", "7z", "winrar", "unitycrashhandler", "cefsharp", "helper",
];

/// Executables in the game folder (two levels deep), most likely game first.
pub fn find_executables(install_dir: &Path) -> Vec<ExeCandidate> {
    let mut found = Vec::new();
    let mut stack = vec![(install_dir.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if path.is_dir() {
                if depth < 3 && !name.starts_with('_') && name != "redist" && name != "md5" {
                    stack.push((path, depth + 1));
                }
            } else if name.ends_with(".exe") && !NOT_THE_GAME.iter().any(|w| name.contains(w)) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                found.push(ExeCandidate { path: path.to_string_lossy().into_owned(), size });
            }
        }
    }
    // Prefer shallow paths, then larger files.
    found.sort_by_key(|c| (Path::new(&c.path).components().count(), std::cmp::Reverse(c.size)));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_game_executables_and_skips_tools() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_Redist")).unwrap();
        std::fs::create_dir_all(root.join("Game").join("Binaries")).unwrap();
        std::fs::write(root.join("unins000.exe"), b"x").unwrap();
        std::fs::write(root.join("_Redist").join("dxwebsetup.exe"), b"x").unwrap();
        std::fs::write(root.join("Trees.exe"), vec![0u8; 10]).unwrap();
        std::fs::write(root.join("Game").join("Binaries").join("Trees-Shipping.exe"), vec![0u8; 100]).unwrap();
        let names: Vec<String> = find_executables(root)
            .into_iter()
            .map(|c| Path::new(&c.path).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Trees.exe", "Trees-Shipping.exe"]);
    }

    fn process(image: &str, started_ms: Option<u64>) -> Running {
        Running { image: PathBuf::from(image), started_ms }
    }

    #[test]
    fn a_game_runs_from_when_its_first_program_started() {
        let processes = vec![
            process(r"C:\Windows\explorer.exe", Some(1)),
            process(r"C:\Games\Trees\Launcher.exe", Some(5_000)),
            process(r"C:\Games\Trees\Bin\Trees.exe", Some(9_000)),
            process(r"C:\Games\Rocks\Rocks.exe", None),
        ];
        let dirs = [r"C:\Games\Trees", r"c:\games\rocks\", r"C:\Games\Water", r"C:\Games"].map(PathBuf::from);
        // Matched by folder (any case), never by name; no start time: counted from now.
        assert_eq!(earliest_in(&processes, &dirs, 20_000), vec![Some(5_000), Some(20_000), None, Some(5_000)]);
    }

    #[test]
    fn uninstallers_installers_and_crash_reporters_are_not_play() {
        let processes = vec![
            process(r"C:\Games\Trees\unins000.exe", Some(1_000)),
            process(r"C:\Games\Trees\_Redist\vc_redist.x64.exe", Some(2_000)),
            process(r"C:\Games\Trees\CrashReporter.exe", Some(3_000)),
            process(r"C:\Games\Trees\Trees_Launcher_Update.exe", Some(7_000)),
        ];
        let dirs = [PathBuf::from(r"C:\Games\Trees")];
        assert_eq!(earliest_in(&processes[..3], &dirs, 10_000), vec![None]);
        // A launcher counts even when its name has a skipped word.
        assert_eq!(earliest_in(&processes, &dirs, 10_000), vec![Some(7_000)]);
    }

    #[test]
    fn filetimes_become_unix_milliseconds() {
        let t = 116_444_736_000_000_000u64 + 12_345 * 10_000;
        assert_eq!(filetime_ms(FILETIME { dwLowDateTime: t as u32, dwHighDateTime: (t >> 32) as u32 }), Some(12_345));
        assert_eq!(filetime_ms(FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }), None);
    }
}
