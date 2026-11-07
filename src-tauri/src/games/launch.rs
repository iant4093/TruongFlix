//! Starts installed games and measures play time, including games whose launcher exits after
//! starting the real game process from the same folder.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, INFINITE, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Paths of running processes whose executable lives inside `dir`.
fn processes_in(dir: &Path) -> Vec<u32> {
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
                        if image.starts_with(dir) {
                            out.push(entry.th32ProcessID);
                        }
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

pub fn is_running(dir: &Path) -> bool {
    !processes_in(dir).is_empty()
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
}
