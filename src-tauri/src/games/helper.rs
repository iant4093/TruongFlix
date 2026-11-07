//! The elevated helper. TruongFlix relaunches itself with `--games-helper <job>` (one UAC prompt per
//! job) because repack installers need administrator rights, and only an elevated process can hide
//! and operate their windows. The job travels on the command line so it cannot be altered after the
//! user approves it; progress comes back as JSON lines in a file, and a cancel file stops the job.
//! The helper checks the whole job again (see `guard`) and takes everything it runs from the
//! installer itself.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
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
use super::guard::{self, Constants, PostAction, Protected};
use super::installer;

const HELPER_FLAG: &str = "--games-helper";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallJob {
    pub setup_exe: PathBuf,
    /// The games download folder the installer must be in.
    pub download_root: PathBuf,
    pub install_dir: PathBuf,
    pub language: Option<String>,
    pub components: Option<Vec<String>>,
    pub tasks: Option<Vec<String>>,
    pub no_icons: bool,
    pub limit_ram: Option<bool>,
    /// Shortcuts the installer always creates that the user did not want.
    pub remove_shortcuts: Vec<PathBuf>,
    /// Indices into the installer's `[Run]` entries.
    pub post_actions: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallJob {
    pub install_dir: PathBuf,
}

/// An install job whose every part was checked against the installer and the file system.
#[derive(Debug)]
pub struct CheckedInstall {
    pub setup_exe: PathBuf,
    pub install_dir: PathBuf,
    pub language: Option<String>,
    pub components: Option<Vec<String>>,
    pub tasks: Option<Vec<String>>,
    pub no_icons: bool,
    pub limit_ram: Option<bool>,
    pub remove_shortcuts: Vec<PathBuf>,
    pub post_actions: Vec<PostAction>,
}

pub fn check_install(job: &InstallJob, protected: &Protected, shortcut_roots: &[PathBuf]) -> Result<CheckedInstall, String> {
    let root = guard::download_root(&job.download_root, protected)?;
    let missing = "The installer is missing from the games download folder.";
    let setup_exe = guard::existing_inside(&job.setup_exe, &root).map_err(|_| missing.to_string())?;
    if !setup_exe.is_file() || setup_exe.extension().is_none_or(|e| !e.eq_ignore_ascii_case("exe")) {
        return Err(missing.into());
    }
    let info = installer::read(&setup_exe)?;
    let install_dir = guard::install_dir(&job.install_dir, protected)?;
    let language = job.language.as_deref().map(|l| guard::language(l, &info)).transpose()?;
    let components = job.components.as_deref().map(|c| guard::components(c, &info)).transpose()?;
    let tasks = job.tasks.as_deref().map(|t| guard::tasks(t, &info)).transpose()?;
    let remove_shortcuts = job
        .remove_shortcuts
        .iter()
        .map(|s| guard::shortcut(s, shortcut_roots))
        .collect::<Result<Vec<_>, _>>()?;
    let src = setup_exe.parent().unwrap_or(&root).to_path_buf();
    let constants = Constants::new(&install_dir, &src);
    let post_actions = guard::post_actions(&job.post_actions, &info, language.as_deref(), &constants)?;
    Ok(CheckedInstall {
        setup_exe,
        install_dir,
        language,
        components,
        tasks,
        no_icons: job.no_icons,
        limit_ram: job.limit_ram,
        remove_shortcuts,
        post_actions,
    })
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

/// The progress and cancel files sit side by side as `<job>.jsonl` / `<job>.cancel`; the
/// installer's log goes next to them as `<job>.log`.
fn job_files_ok(job: &HelperJob) -> bool {
    let has_ext = |p: &Path, ext: &str| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext));
    job.progress_file.is_absolute()
        && has_ext(&job.progress_file, "jsonl")
        && job.cancel_file == job.progress_file.with_extension("cancel")
}

/// Opens the progress file without following links, so it can't redirect the elevated writes.
fn open_progress(path: &Path) -> Option<File> {
    let file = OpenOptions::new().append(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).ok()?;
    let meta = file.metadata().ok()?;
    (meta.is_file() && !meta.file_type().is_symlink()).then_some(file)
}

/// Runs the helper when TruongFlix was started with `--games-helper`, returning the exit code.
pub fn run_from_args() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(HELPER_FLAG) {
        return None;
    }
    let Some(job) = args
        .next()
        .and_then(|hex| decode_hex(&hex))
        .and_then(|bytes| serde_json::from_slice::<HelperJob>(&bytes).ok())
        .filter(job_files_ok)
    else {
        return Some(1);
    };
    let Some(file) = open_progress(&job.progress_file) else {
        return Some(1);
    };
    let mut reporter = Reporter { file };
    let cancel_file = job.cancel_file.clone();
    let cancelled = move || cancel_file.exists();
    let log_file = job.progress_file.with_extension("log");

    automation::start_window_hider();
    let protected = Protected::system();
    let ok = match &job.job {
        JobKind::Install(install) => {
            // Shortcuts outside this account's Desktop/Start Menu (e.g. when another administrator
            // approved the prompt) are left alone rather than failing the install.
            let roots = guard::shortcut_roots();
            let mut install = install.clone();
            install.remove_shortcuts.retain(|s| guard::shortcut(s, &roots).is_ok());
            match check_install(&install, &protected, &roots) {
                Ok(checked) => run_install(&checked, &log_file, &mut reporter, &cancelled),
                Err(message) => {
                    reporter.send(HelperEvent::Error { message });
                    false
                }
            }
        }
        JobKind::Uninstall(uninstall) => run_uninstall(uninstall, &protected, &mut reporter),
    };
    let was_cancelled = cancelled();
    reporter.send(HelperEvent::Done { ok, cancelled: was_cancelled });
    Some(if ok { 0 } else { 1 })
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', ""))
}

fn setup_arguments(job: &CheckedInstall, log_file: &Path) -> String {
    let mut args = vec![
        "/SP-".to_string(),
        "/NORESTART".to_string(),
        format!("/DIR={}", quote(&job.install_dir.to_string_lossy())),
        format!("/LOG={}", quote(&log_file.to_string_lossy())),
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
    tree().image_dirs().into_iter().filter(|d| guard::is_installer_temp_dir(d, &temp)).collect()
}

/// The installer's `{tmp}` folder, as recorded in its log ("Created temporary directory: ...").
/// The log is user-writable, so this is only used to find a folder to delete, never to run
/// anything, and only real `%TEMP%\is-*.tmp` folders qualify.
fn temp_dirs_from_log(log: &Path) -> Vec<PathBuf> {
    let Ok(bytes) = std::fs::read(log) else {
        return Vec::new();
    };
    let temp = std::env::temp_dir();
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| line.split_once("Created temporary directory: ").map(|(_, p)| PathBuf::from(p.trim())))
        .filter(|p| guard::is_installer_temp_dir(p, &temp))
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
fn silent_parameters(filename: &Path, parameters: &str) -> String {
    let name = filename
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut params = parameters.trim().to_string();
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

fn run_post_action(action: &PostAction) -> Result<(), String> {
    let mut command = Command::new(&action.filename);
    command.raw_arg(silent_parameters(&action.filename, &action.parameters));
    command.creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = action.working_dir.as_deref().or_else(|| action.filename.parent()) {
        command.current_dir(dir);
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

/// Deletes an unwanted shortcut after checking again, now that it exists, where it really is.
fn remove_shortcut(path: &Path, roots: &[PathBuf]) {
    let Ok(real) = guard::shortcut(path, roots) else { return };
    if std::fs::symlink_metadata(&real).is_ok_and(|m| m.is_file()) {
        let _ = std::fs::remove_file(real);
    }
}

fn run_install(job: &CheckedInstall, log_file: &Path, reporter: &mut Reporter, cancelled: &dyn Fn() -> bool) -> bool {
    let created_dir = !job.install_dir.exists();
    let installer_dir = job.setup_exe.parent().map(Path::to_path_buf).unwrap_or_default();
    reporter.send(HelperEvent::Phase { phase: "starting".into() });
    let _ = std::fs::remove_file(log_file);

    let mut command = Command::new(&job.setup_exe);
    command.raw_arg(setup_arguments(job, log_file)).current_dir(&installer_dir);
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

    let mut temp_dirs = installer_temp_dirs();
    temp_dirs.extend(temp_dirs_from_log(log_file));
    temp_dirs.sort();
    temp_dirs.dedup();

    // Closing on the final page means none of the installer's own after-install actions run.
    let ok = match outcome {
        WizardOutcome::Finished => {
            if !job.post_actions.is_empty() {
                reporter.send(HelperEvent::Phase { phase: "afterInstall".into() });
            }
            let mut ok = true;
            for action in &job.post_actions {
                reporter.send(HelperEvent::Progress { percent: 100.0, status: action.label.clone() });
                if let Err(message) = run_post_action(action) {
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
    let temp = std::env::temp_dir();
    for dir in temp_dirs.into_iter().filter(|d| guard::is_installer_temp_dir(d, &temp)) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if ok {
        let roots = guard::shortcut_roots();
        for shortcut in &job.remove_shortcuts {
            remove_shortcut(shortcut, &roots);
        }
    } else if created_dir {
        let _ = std::fs::remove_dir_all(&job.install_dir);
    }
    ok
}

fn run_uninstall(job: &UninstallJob, protected: &Protected, reporter: &mut Reporter) -> bool {
    reporter.send(HelperEvent::Phase { phase: "uninstalling".into() });
    let (dir, uninstaller) = match guard::uninstall_target(&job.install_dir, protected) {
        Ok(target) => target,
        Err(message) => {
            reporter.send(HelperEvent::Error { message });
            return false;
        }
    };
    let mut command = Command::new(&uninstaller);
    command.raw_arg("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART").current_dir(&dir);
    match command.spawn() {
        Ok(child) => {
            tree().add_root(child.id());
            let stop_mute = Arc::new(AtomicBool::new(false));
            super::mute::start(stop_mute.clone());
            wait_for_tree_exit(Duration::from_secs(30 * 60));
            stop_mute.store(true, Ordering::Relaxed);
        }
        Err(e) => {
            reporter.send(HelperEvent::Error { message: format!("Could not start the uninstaller: {e}") });
            return false;
        }
    }
    if dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            reporter.send(HelperEvent::Error { message: format!("Could not delete '{}': {e}", dir.display()) });
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

    fn install_job(setup_exe: PathBuf, download_root: PathBuf, install_dir: PathBuf) -> InstallJob {
        InstallJob {
            setup_exe,
            download_root,
            install_dir,
            language: Some("en".into()),
            components: Some(vec!["text".into()]),
            tasks: None,
            no_icons: false,
            limit_ram: None,
            remove_shortcuts: vec![],
            post_actions: vec![],
        }
    }

    #[test]
    fn job_round_trips_through_hex() {
        let job = HelperJob {
            job: JobKind::Uninstall(UninstallJob { install_dir: PathBuf::from(r"D:\Games\Ünïcode Game") }),
            progress_file: PathBuf::from(r"C:\cache\game-jobs\p.jsonl"),
            cancel_file: PathBuf::from(r"C:\cache\game-jobs\p.cancel"),
        };
        let hex = encode_hex(&serde_json::to_vec(&job).unwrap());
        let back: HelperJob = serde_json::from_slice(&decode_hex(&hex).unwrap()).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&job).unwrap());
        assert!(decode_hex("abc").is_none());
        assert!(job_files_ok(&back));
        assert!(!job_files_ok(&HelperJob { cancel_file: PathBuf::from(r"C:\Windows\x.cancel"), ..back.clone() }));
        assert!(!job_files_ok(&HelperJob { progress_file: PathBuf::from("p.jsonl"), cancel_file: PathBuf::from("p.cancel"), ..back }));
    }

    #[test]
    fn progress_file_must_not_be_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("p.jsonl");
        std::fs::write(&file, b"").unwrap();
        assert!(open_progress(&file).is_some());
        assert!(open_progress(&dir.path().join("missing.jsonl")).is_none());
        let link = dir.path().join("link.jsonl");
        if std::os::windows::fs::symlink_file(&file, &link).is_ok() {
            assert!(open_progress(&link).is_none());
        }
    }

    #[test]
    fn setup_arguments_quote_paths_and_pass_choices() {
        let job = CheckedInstall {
            setup_exe: PathBuf::from(r"E:\Installers\Game\setup.exe"),
            install_dir: PathBuf::from(r"D:\My Games\Game"),
            language: Some("en".into()),
            components: Some(vec!["text".into(), "lang_de".into()]),
            tasks: Some(vec![]),
            no_icons: true,
            limit_ram: None,
            remove_shortcuts: vec![],
            post_actions: vec![],
        };
        assert_eq!(
            setup_arguments(&job, Path::new(r"C:\Temp\setup.log")),
            r#"/SP- /NORESTART /DIR="D:\My Games\Game" /LOG="C:\Temp\setup.log" /LANG=en /COMPONENTS="text,lang_de" /TASKS="" /NOICONS"#
        );
    }

    #[test]
    fn redistributables_get_quiet_switches() {
        let quiet = |file: &str, params: &str| silent_parameters(Path::new(file), params);
        assert_eq!(quiet(r"D:\G\_Redist\dxwebsetup.exe", ""), "/Q");
        assert_eq!(quiet(r"D:\G\_Redist\vc_redist.x64.exe", ""), "/install /quiet /norestart");
        assert_eq!(quiet(r"C:\Windows\System32\cmd.exe", r#"/c "x.cmd""#), r#"/c "x.cmd""#);
        assert_eq!(quiet(r"D:\G\_Redist\DXSETUP.exe", "/q"), "/q");
    }

    #[test]
    fn installers_must_be_inno_setups_inside_the_download_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Downloads");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("setup.exe"), b"MZ not an installer").unwrap();
        std::fs::write(dir.path().join("setup.exe"), b"MZ").unwrap();
        let none = Protected::new(vec![], vec![], vec![]);
        let target = dir.path().join("Games").join("Game");

        let outside = install_job(dir.path().join("setup.exe"), root.clone(), target.clone());
        assert!(check_install(&outside, &none, &[]).unwrap_err().contains("missing"));
        let escape = install_job(game.join("..").join("..").join("setup.exe"), root.clone(), target.clone());
        assert!(check_install(&escape, &none, &[]).is_err());
        let not_inno = install_job(game.join("setup.exe"), root.clone(), target);
        assert!(check_install(&not_inno, &none, &[]).unwrap_err().contains("Inno Setup"));
        let root_is_drive = install_job(game.join("setup.exe"), PathBuf::from(r"C:\"), dir.path().join("x"));
        assert!(check_install(&root_is_drive, &Protected::system(), &[]).is_err());
    }

    /// Set `TRUONGFLIX_TEST_INSTALLER_DIR` to a downloaded repack folder to check a job against it.
    #[test]
    fn checks_a_job_against_a_real_installer_when_available() {
        let Ok(dir) = std::env::var("TRUONGFLIX_TEST_INSTALLER_DIR") else {
            return;
        };
        let dir = PathBuf::from(dir);
        let setup = installer::find_setup(&dir).expect("setup.exe");
        let info = installer::read(&setup).expect("installer parses");
        let index = |pred: &dyn Fn(&installer::RunInfo) -> bool| info.run_entries.iter().position(pred).expect("run entry");
        let dx = index(&|r| r.filename.contains("dxwebsetup") && r.languages.as_deref() == Some("en"));
        let tmp = index(&|r| r.parameters.contains("{tmp}"));
        let target = tempfile::tempdir().unwrap();
        let roots = guard::shortcut_roots();
        let desktop = PathBuf::from(guard::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_PublicDesktop));

        let mut job = install_job(setup, dir.parent().unwrap().to_path_buf(), target.path().join("Game"));
        job.components = Some(vec!["TEXT".into(), "directx".into()]);
        job.post_actions = vec![dx];
        job.remove_shortcuts = vec![desktop.join(format!("{}.lnk", info.app_name))];
        let checked = check_install(&job, &Protected::system(), &roots).expect("job is valid");
        assert_eq!(checked.components, Some(vec!["text".to_string(), "directx".to_string()]));
        assert_eq!(checked.post_actions.len(), 1);
        assert!(checked.post_actions[0].filename.starts_with(&checked.install_dir));
        assert!(checked.post_actions[0].filename.ends_with(r"_Redist\dxwebsetup.exe"));

        assert!(check_install(&InstallJob { post_actions: vec![tmp], ..job.clone() }, &Protected::system(), &roots).is_err());
        assert!(check_install(&InstallJob { language: Some("en /SILENT".into()), ..job.clone() }, &Protected::system(), &roots).is_err());
        assert!(check_install(&InstallJob { tasks: Some(vec!["evil".into()]), ..job.clone() }, &Protected::system(), &roots).is_err());
        let elsewhere = InstallJob { remove_shortcuts: vec![target.path().join("x.lnk")], ..job.clone() };
        assert!(check_install(&elsewhere, &Protected::system(), &roots).is_err());
        let windows = guard::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_Windows);
        assert!(check_install(&InstallJob { install_dir: PathBuf::from(windows), ..job }, &Protected::system(), &roots).is_err());
    }
}
