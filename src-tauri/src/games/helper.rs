//! The elevated helper. TruongFlix relaunches itself with `--games-helper <job>` (one UAC prompt per
//! job) because repack installers need administrator rights, and only an elevated process can hide
//! and operate their windows. The job travels on the command line so it cannot be altered after the
//! user approves it; progress comes back as JSON lines in a file, and a cancel file stops the job.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use super::automation::{self, drive_wizard, tree, WizardEvent, WizardOptions, WizardOutcome};

const HELPER_FLAG: &str = "--games-helper";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAction {
    pub label: String,
    pub filename: String,
    pub parameters: String,
    pub working_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallJob {
    pub setup_exe: PathBuf,
    pub install_dir: PathBuf,
    pub language: Option<String>,
    pub components: Option<Vec<String>>,
    pub tasks: Option<Vec<String>>,
    pub no_icons: bool,
    pub limit_ram: Option<bool>,
    /// Shortcut paths the installer always creates that the user did not want.
    pub remove_shortcuts: Vec<PathBuf>,
    pub post_actions: Vec<PostAction>,
    #[serde(default)]
    pub log_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallJob {
    pub uninstaller: Option<PathBuf>,
    pub install_dir: PathBuf,
    pub remove_shortcuts: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobKind {
    Install(InstallJob),
    Uninstall(UninstallJob),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperJob {
    pub job: JobKind,
    pub progress_file: PathBuf,
    pub cancel_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HelperEvent {
    Phase { phase: String },
    Progress { percent: f64, status: String },
    Error { message: String },
    Done { ok: bool, cancelled: bool },
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

struct Reporter {
    file: File,
}

impl Reporter {
    fn send(&mut self, event: HelperEvent) {
        if let Ok(line) = serde_json::to_string(&event) {
            let _ = writeln!(self.file, "{line}");
            let _ = self.file.flush();
        }
    }
}

/// Runs the helper when TruongFlix was started with `--games-helper`, returning the exit code.
pub fn run_from_args() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(HELPER_FLAG) {
        return None;
    }
    let job: HelperJob = args
        .next()
        .and_then(|hex| decode_hex(&hex))
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
    let file = OpenOptions::new().create(true).append(true).open(&job.progress_file).ok()?;
    let mut reporter = Reporter { file };
    let cancel_file = job.cancel_file.clone();
    let cancelled = move || cancel_file.exists();

    automation::start_window_hider();
    let ok = match &job.job {
        JobKind::Install(install) => run_install(install, &mut reporter, &cancelled),
        JobKind::Uninstall(uninstall) => run_uninstall(uninstall, &mut reporter),
    };
    let was_cancelled = cancelled();
    reporter.send(HelperEvent::Done { ok, cancelled: was_cancelled });
    Some(if ok { 0 } else { 1 })
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', ""))
}

fn setup_arguments(job: &InstallJob) -> String {
    let mut args = vec![
        "/SP-".to_string(),
        "/NORESTART".to_string(),
        format!("/DIR={}", quote(&job.install_dir.to_string_lossy())),
        format!("/LOG={}", quote(&job.log_file.to_string_lossy())),
    ];
    if let Some(lang) = &job.language {
        args.push(format!("/LANG={lang}"));
    }
    if let Some(components) = &job.components {
        args.push(format!("/COMPONENTS={}", quote(&components.join(","))));
    }
    if let Some(tasks) = &job.tasks {
        args.push(format!("/TASKS={}", quote(&tasks.join(","))));
    }
    if job.no_icons {
        args.push("/NOICONS".into());
    }
    args.join(" ")
}

/// Inno's own temporary folders (`%TEMP%\is-*.tmp`), which stay behind because the installer is
/// closed on its last page.
fn installer_temp_dirs() -> Vec<PathBuf> {
    let temp = std::env::temp_dir();
    let mut dirs: Vec<PathBuf> = tree()
        .image_dirs()
        .into_iter()
        .filter(|d| {
            d.parent() == Some(temp.as_path())
                && d.file_name().is_some_and(|n| {
                    let n = n.to_string_lossy().to_ascii_lowercase();
                    n.starts_with("is-") && n.ends_with(".tmp")
                })
        })
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

/// The installer's `{tmp}` folder, as recorded in its log ("Created temporary directory: ...").
fn temp_dirs_from_log(log: &Path) -> Vec<PathBuf> {
    let Ok(bytes) = std::fs::read(log) else {
        return Vec::new();
    };
    let temp = std::env::temp_dir();
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| line.split_once("Created temporary directory: ").map(|(_, p)| PathBuf::from(p.trim())))
        .filter(|p| p.parent() == Some(temp.as_path()))
        .collect()
}

fn wait_for_tree_exit(timeout: Duration) {
    let started = std::time::Instant::now();
    while tree().any_alive() && started.elapsed() < timeout {
        for hwnd in automation::tree_windows() {
            automation::hide(hwnd);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Quiet switches for the redistributable installers repacks bundle.
fn silent_parameters(action: &PostAction) -> String {
    let name = Path::new(&action.filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut params = action.parameters.trim().to_string();
    let add = |params: &mut String, extra: &str| {
        if !params.to_ascii_lowercase().contains(&extra.to_ascii_lowercase()) {
            if !params.is_empty() {
                params.push(' ');
            }
            params.push_str(extra);
        }
    };
    if name.starts_with("dxwebsetup") || name.starts_with("dxsetup") {
        add(&mut params, "/Q");
    } else if name.starts_with("vc_redist") || name.starts_with("vcredist") {
        add(&mut params, "/install /quiet /norestart");
    } else if name.starts_with("oalinst") {
        add(&mut params, "/S");
    } else if name.starts_with("physx") || name.ends_with(".msi") {
        add(&mut params, "/quiet /norestart");
    }
    params
}

fn run_post_action(action: &PostAction, temp_dir: Option<&Path>) -> Result<(), String> {
    let resolve = |s: &str| match temp_dir {
        Some(t) => s.replace("{tmp}", &t.to_string_lossy()),
        None => s.to_string(),
    };
    let filename = resolve(&action.filename);
    let mut command = Command::new(&filename);
    command.raw_arg(resolve(&silent_parameters(action)));
    command.creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = &action.working_dir {
        command.current_dir(resolve(dir));
    } else if let Some(parent) = Path::new(&filename).parent() {
        command.current_dir(parent);
    }
    let mut child = command.spawn().map_err(|e| format!("{}: {e}", action.label))?;
    tree().add_root(child.id());
    loop {
        for hwnd in automation::tree_windows() {
            automation::hide(hwnd);
        }
        if let Ok(Some(_)) = child.try_wait() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn run_install(job: &InstallJob, reporter: &mut Reporter, cancelled: &dyn Fn() -> bool) -> bool {
    let created_dir = !job.install_dir.exists();
    let installer_dir = job.setup_exe.parent().map(Path::to_path_buf).unwrap_or_default();
    reporter.send(HelperEvent::Phase { phase: "starting".into() });

    let mut command = Command::new(&job.setup_exe);
    command.raw_arg(setup_arguments(job)).current_dir(&installer_dir);
    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            reporter.send(HelperEvent::Error { message: format!("Could not start the installer: {e}") });
            return false;
        }
    };
    tree().add_root(child.id());
    let stop_mute = Arc::new(AtomicBool::new(false));
    super::mute::start(stop_mute.clone());

    reporter.send(HelperEvent::Phase { phase: "installing".into() });
    let options = WizardOptions { limit_ram: job.limit_ram, cancel_requested: cancelled };
    let mut finalizing_sent = false;
    let outcome = drive_wizard(&options, |event| match event {
        WizardEvent::Progress { percent, status } => {
            reporter.send(HelperEvent::Progress { percent, status });
        }
        WizardEvent::Finalizing if !finalizing_sent => {
            finalizing_sent = true;
            reporter.send(HelperEvent::Phase { phase: "finalizing".into() });
        }
        WizardEvent::Finalizing => {}
    });

    let setup_temp = temp_dirs_from_log(&job.log_file).into_iter().next();
    let mut temp_dirs = installer_temp_dirs();
    temp_dirs.extend(setup_temp.clone());

    // Closing on the final page means none of the installer's own after-install actions run.
    let ok = match outcome {
        WizardOutcome::Finished => {
            let actions: Vec<_> = job.post_actions.clone();
            if !actions.is_empty() {
                reporter.send(HelperEvent::Phase { phase: "afterInstall".into() });
            }
            let mut ok = true;
            for action in &actions {
                reporter.send(HelperEvent::Progress { percent: 100.0, status: action.label.clone() });
                if let Err(message) = run_post_action(action, setup_temp.as_deref()) {
                    reporter.send(HelperEvent::Error { message });
                    ok = false;
                }
            }
            ok
        }
        WizardOutcome::Cancelled => false,
        WizardOutcome::Failed(message) => {
            reporter.send(HelperEvent::Error { message });
            false
        }
    };

    tree().kill_all();
    wait_for_tree_exit(Duration::from_secs(15));
    stop_mute.store(true, Ordering::Relaxed);

    reporter.send(HelperEvent::Phase { phase: "cleanup".into() });
    for dir in temp_dirs {
        let _ = std::fs::remove_dir_all(dir);
    }
    if ok {
        for shortcut in &job.remove_shortcuts {
            let _ = std::fs::remove_file(shortcut);
        }
    } else if created_dir {
        let _ = std::fs::remove_dir_all(&job.install_dir);
    }
    ok
}

fn run_uninstall(job: &UninstallJob, reporter: &mut Reporter) -> bool {
    reporter.send(HelperEvent::Phase { phase: "uninstalling".into() });
    let found = || -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = std::fs::read_dir(&job.install_dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name().is_some_and(|n| {
                    let n = n.to_string_lossy().to_ascii_lowercase();
                    n.starts_with("unins") && n.ends_with(".exe")
                })
            })
            .collect();
        candidates.sort();
        candidates.pop()
    };
    let uninstaller = job.uninstaller.clone().filter(|p| p.is_file()).or_else(found);
    if let Some(uninstaller) = uninstaller.as_ref() {
        let mut command = Command::new(uninstaller);
        command.raw_arg("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
        match command.spawn() {
            Ok(child) => {
                tree().add_root(child.id());
                let stop_mute = Arc::new(AtomicBool::new(false));
                super::mute::start(stop_mute.clone());
                wait_for_tree_exit(Duration::from_secs(30 * 60));
                stop_mute.store(true, Ordering::Relaxed);
            }
            Err(e) => reporter.send(HelperEvent::Error { message: format!("Could not start the uninstaller: {e}") }),
        }
    }
    for shortcut in &job.remove_shortcuts {
        let _ = std::fs::remove_file(shortcut);
    }
    if job.install_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&job.install_dir) {
            reporter.send(HelperEvent::Error { message: format!("Could not delete '{}': {e}", job.install_dir.display()) });
            return false;
        }
    }
    true
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Starts the helper with administrator rights and relays its events until it exits.
pub fn run_elevated(job: &HelperJob, mut on_event: impl FnMut(HelperEvent)) -> Result<bool, String> {
    let _ = std::fs::remove_file(&job.cancel_file);
    File::create(&job.progress_file).map_err(|e| format!("Could not create the progress file: {e}"))?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let payload = serde_json::to_vec(job).map_err(|e| e.to_string())?;
    let params = format!("{HELPER_FLAG} {}", encode_hex(&payload));

    let verb = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let parameters = wide(&params);
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
        return Err("Windows administrator permission is needed to install games, and it was not granted.".into());
    }

    let mut reader = BufReader::new(File::open(&job.progress_file).map_err(|e| e.to_string())?);
    let mut position = 0u64;
    let mut read_events = |reader: &mut BufReader<File>, position: &mut u64| {
        let _ = reader.seek(SeekFrom::Start(*position));
        let mut line = String::new();
        while let Ok(n) = reader.read_line(&mut line) {
            if n == 0 || !line.ends_with('\n') {
                break;
            }
            *position += n as u64;
            if let Ok(event) = serde_json::from_str::<HelperEvent>(line.trim()) {
                on_event(event);
            }
            line.clear();
        }
    };
    loop {
        let waited = unsafe { WaitForSingleObject(info.hProcess, 250) };
        read_events(&mut reader, &mut position);
        if waited == WAIT_OBJECT_0 {
            break;
        }
    }
    let mut code = 1u32;
    unsafe {
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
    }
    read_events(&mut reader, &mut position);
    let _ = std::fs::remove_file(&job.progress_file);
    let _ = std::fs::remove_file(&job.cancel_file);
    Ok(code == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_round_trips_through_hex() {
        let job = HelperJob {
            job: JobKind::Uninstall(UninstallJob {
                uninstaller: Some(PathBuf::from(r"D:\Games\Ünïcode Game\unins000.exe")),
                install_dir: PathBuf::from(r"D:\Games\Ünïcode Game"),
                remove_shortcuts: vec![],
            }),
            progress_file: PathBuf::from("p.jsonl"),
            cancel_file: PathBuf::from("c"),
        };
        let hex = encode_hex(&serde_json::to_vec(&job).unwrap());
        let back: HelperJob = serde_json::from_slice(&decode_hex(&hex).unwrap()).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&job).unwrap());
        assert!(decode_hex("abc").is_none());
    }

    #[test]
    fn setup_arguments_quote_paths_and_pass_choices() {
        let job = InstallJob {
            setup_exe: PathBuf::from(r"E:\Installers\Game\setup.exe"),
            install_dir: PathBuf::from(r"D:\My Games\Game"),
            language: Some("en".into()),
            components: Some(vec!["text".into(), "lang_de".into()]),
            tasks: Some(vec![]),
            no_icons: true,
            limit_ram: None,
            remove_shortcuts: vec![],
            post_actions: vec![],
            log_file: PathBuf::from(r"C:\Temp\setup.log"),
        };
        assert_eq!(
            setup_arguments(&job),
            r#"/SP- /NORESTART /DIR="D:\My Games\Game" /LOG="C:\Temp\setup.log" /LANG=en /COMPONENTS="text,lang_de" /TASKS="" /NOICONS"#
        );
    }

    #[test]
    fn redistributables_get_quiet_switches() {
        let action = |file: &str, params: &str| PostAction {
            label: String::new(),
            filename: file.into(),
            parameters: params.into(),
            working_dir: None,
        };
        assert_eq!(silent_parameters(&action(r"D:\G\_Redist\dxwebsetup.exe", "")), "/Q");
        assert_eq!(silent_parameters(&action(r"D:\G\_Redist\vc_redist.x64.exe", "")), "/install /quiet /norestart");
        assert_eq!(silent_parameters(&action("cmd.exe", r#"/c "x.cmd""#)), r#"/c "x.cmd""#);
        assert_eq!(silent_parameters(&action(r"D:\G\_Redist\DXSETUP.exe", "/q")), "/q");
    }
}
