//! Drives a repack's Inno Setup wizard with every window hidden. Runs inside the elevated helper,
//! because Windows only lets an elevated process hide or press buttons in the elevated installer.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM, WPARAM};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW, GetDlgCtrlID,
    GetMessageW, GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible,
    PostMessageW, SendMessageTimeoutW, ShowWindow, TranslateMessage, GA_PARENT, GA_ROOT,
    GWL_STYLE, MSG, SMTO_ABORTIFHUNG, SW_HIDE, WM_COMMAND, WM_GETTEXT, WM_GETTEXTLENGTH,
    WS_VISIBLE,
};

const EVENT_OBJECT_CREATE: u32 = 0x8000;
const EVENT_OBJECT_SHOW: u32 = 0x8002;
const WINEVENT_OUTOFCONTEXT: u32 = 0;
const OBJID_WINDOW: i32 = 0;
const BM_GETCHECK: u32 = 0x00F0;
const BST_CHECKED: isize = 1;
const PBM_GETRANGE: u32 = 0x0407;
const PBM_GETPOS: u32 = 0x0408;
const IDYES: usize = 6;

/// Every process started by the installer, so its windows can be hidden and its sound muted.
pub struct ProcessTree {
    own_pid: u32,
    known: Mutex<HashSet<u32>>,
}

static TREE: OnceLock<ProcessTree> = OnceLock::new();

pub fn tree() -> &'static ProcessTree {
    TREE.get_or_init(|| ProcessTree {
        own_pid: std::process::id(),
        known: Mutex::new(HashSet::new()),
    })
}

pub struct ProcessEntry {
    parent: u32,
}

fn snapshot() -> HashMap<u32, ProcessEntry> {
    let mut out = HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                out.insert(entry.th32ProcessID, ProcessEntry { parent: entry.th32ParentProcessID });
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

impl ProcessTree {
    pub fn add_root(&self, pid: u32) {
        self.known.lock().unwrap().insert(pid);
    }

    pub fn pids(&self) -> Vec<u32> {
        self.known.lock().unwrap().iter().copied().collect()
    }

    /// Adds every descendant of a known process. A child keeps its parent's id after the parent
    /// exits, so walking parent ids still finds it.
    pub fn refresh(&self) -> HashMap<u32, ProcessEntry> {
        let procs = snapshot();
        let mut known = self.known.lock().unwrap();
        for &pid in procs.keys() {
            if known.contains(&pid) || pid == self.own_pid {
                continue;
            }
            let mut chain = vec![pid];
            let mut current = procs[&pid].parent;
            for _ in 0..32 {
                if known.contains(&current) {
                    known.extend(chain.drain(..));
                    break;
                }
                if current == 0 || current == self.own_pid {
                    break;
                }
                chain.push(current);
                match procs.get(&current) {
                    Some(entry) => current = entry.parent,
                    None => break,
                }
            }
        }
        procs
    }

    pub fn contains(&self, pid: u32) -> bool {
        if pid == self.own_pid {
            return false;
        }
        if self.known.lock().unwrap().contains(&pid) {
            return true;
        }
        self.refresh();
        self.known.lock().unwrap().contains(&pid)
    }

    pub fn any_alive(&self) -> bool {
        let procs = self.refresh();
        self.known.lock().unwrap().iter().any(|pid| procs.contains_key(pid))
    }

    pub fn kill_all(&self) {
        for pid in self.pids() {
            unsafe {
                let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
                if !handle.is_null() {
                    TerminateProcess(handle, 1);
                    CloseHandle(handle);
                }
            }
        }
    }

    /// Folders of running installer processes, used to find Inno's temporary `is-*.tmp` folders.
    pub fn image_dirs(&self) -> Vec<PathBuf> {
        self.pids().into_iter().filter_map(process_image).filter_map(|p| p.parent().map(Path::to_path_buf)).collect()
    }
}

fn process_image(pid: u32) -> Option<PathBuf> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

pub fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn send(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> isize {
    let mut result: usize = 0;
    unsafe { SendMessageTimeoutW(hwnd, msg, wparam, lparam, SMTO_ABORTIFHUNG, 1000, &mut result) };
    result as isize
}

pub fn window_text(hwnd: HWND) -> String {
    let len = send(hwnd, WM_GETTEXTLENGTH, 0, 0);
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let copied = send(hwnd, WM_GETTEXT, buf.len(), buf.as_mut_ptr() as LPARAM);
    String::from_utf16_lossy(&buf[..copied.clamp(0, len) as usize])
}

/// Child visibility from the controls' own flags, because a hidden parent makes Windows report
/// every child as invisible.
fn is_shown(hwnd: HWND) -> bool {
    unsafe {
        if GetAncestor(hwnd, GA_ROOT) == hwnd {
            return IsWindowVisible(hwnd) != 0;
        }
        let mut current = hwnd;
        for _ in 0..50 {
            if current.is_null() || GetAncestor(current, GA_ROOT) == current {
                return true;
            }
            if (GetWindowLongW(current, GWL_STYLE) as u32 & WS_VISIBLE) == 0 {
                return false;
            }
            current = GetAncestor(current, GA_PARENT);
        }
        true
    }
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> i32 {
    let list = &mut *(lparam as *mut Vec<HWND>);
    list.push(hwnd);
    1
}

fn children(parent: HWND) -> Vec<HWND> {
    let mut list: Vec<HWND> = Vec::new();
    unsafe { EnumChildWindows(parent, Some(collect_window), &mut list as *mut _ as LPARAM) };
    list
}

pub fn tree_windows() -> Vec<HWND> {
    let mut all: Vec<HWND> = Vec::new();
    unsafe { EnumWindows(Some(collect_window), &mut all as *mut _ as LPARAM) };
    all.into_iter()
        .filter(|&hwnd| {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            tree().contains(pid)
        })
        .collect()
}

pub fn hide(hwnd: HWND) {
    unsafe {
        if IsWindowVisible(hwnd) != 0 {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

unsafe extern "system" fn on_window_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if id_object != OBJID_WINDOW || hwnd.is_null() || GetAncestor(hwnd, GA_ROOT) != hwnd {
        return;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if tree().contains(pid) {
        hide(hwnd);
    }
}

/// Hides installer windows the moment they are created or shown, before they are drawn.
pub fn start_window_hider() {
    std::thread::spawn(|| unsafe {
        SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_SHOW,
            std::ptr::null_mut(),
            Some(on_window_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

fn plain(text: &str) -> String {
    text.replace('&', "").trim().to_string()
}

fn press(button: HWND) {
    unsafe {
        let id = (GetDlgCtrlID(button) as usize) & 0xFFFF;
        PostMessageW(GetAncestor(button, GA_PARENT), WM_COMMAND, id, button as LPARAM);
    }
}

fn is_checked(checkbox: HWND) -> bool {
    send(checkbox, BM_GETCHECK, 0, 0) == BST_CHECKED
}

struct Control {
    hwnd: HWND,
    class: String,
    text: String,
    enabled: bool,
}

fn visible_controls(wizard: HWND) -> Vec<Control> {
    children(wizard)
        .into_iter()
        .filter(|&c| is_shown(c))
        .map(|hwnd| Control {
            hwnd,
            class: class_name(hwnd),
            text: window_text(hwnd),
            enabled: unsafe { IsWindowEnabled(hwnd) != 0 },
        })
        .collect()
}

/// Identifies the wizard page by its visible notebook pages and button captions.
fn page_signature(controls: &[Control]) -> String {
    controls
        .iter()
        .filter_map(|c| match c.class.as_str() {
            "TNewNotebookPage" => Some(format!("P{:?};", c.hwnd)),
            "TNewButton" => Some(format!("B{}{};", plain(&c.text), if c.enabled { "" } else { "(d)" })),
            _ => None,
        })
        .collect()
}

#[derive(Debug)]
pub enum WizardEvent {
    Progress { percent: f64, status: String },
    Finalizing,
}

#[derive(Debug)]
pub enum WizardOutcome {
    Finished,
    Cancelled,
    Failed(String),
}

pub struct WizardOptions<'a> {
    pub limit_ram: Option<bool>,
    pub cancel_requested: &'a dyn Fn() -> bool,
}

fn dialog_text(dialog: HWND) -> (String, Vec<(HWND, String)>) {
    let mut lines = Vec::new();
    let mut buttons = Vec::new();
    for c in children(dialog) {
        let class = class_name(c);
        let text = window_text(c);
        if text.trim().is_empty() {
            continue;
        }
        if class.eq_ignore_ascii_case("Button") || class == "TNewButton" || class == "TButton" {
            buttons.push((c, plain(&text)));
        } else if !matches!(plain(&text).to_ascii_lowercase().as_str(), "ok" | "cancel" | "browse...") {
            lines.push(text.replace("%n", "\n").trim().to_string());
        }
    }
    (lines.join("\n"), buttons)
}

/// Presses through the wizard (choices are already applied on the command line), reports
/// progress, and returns on the final page without running any of its after-install actions.
pub fn drive_wizard(options: &WizardOptions<'_>, mut report: impl FnMut(WizardEvent)) -> WizardOutcome {
    let started = Instant::now();
    let mut last_signature = String::new();
    let mut last_change = Instant::now();
    let mut last_press: Option<Instant> = None;
    let mut presses_without_change = 0u32;
    let mut last_progress = String::new();
    let mut installing = false;

    loop {
        std::thread::sleep(Duration::from_millis(200));
        if (options.cancel_requested)() {
            return WizardOutcome::Cancelled;
        }
        let windows = tree_windows();
        let mut wizard: Option<HWND> = None;
        for &hwnd in &windows {
            hide(hwnd);
            let class = class_name(hwnd);
            if class == "TWizardForm" {
                wizard = Some(hwnd);
            } else if class == "#32770" || window_text(hwnd).contains("ISDone") {
                let (text, buttons) = dialog_text(hwnd);
                if text.is_empty() {
                    continue;
                }
                let yes = buttons.iter().find(|(_, label)| label.eq_ignore_ascii_case("Yes"));
                if !installing && text.to_ascii_lowercase().contains("already exists") {
                    if let Some((_, _)) = yes {
                        unsafe { PostMessageW(hwnd, WM_COMMAND, IDYES, 0) };
                        continue;
                    }
                }
                return WizardOutcome::Failed(text);
            }
        }

        if !tree().any_alive() {
            return WizardOutcome::Failed("The installer closed before it finished.".into());
        }
        let Some(wizard) = wizard else {
            if started.elapsed() > Duration::from_secs(120) {
                return WizardOutcome::Failed("The installer did not start.".into());
            }
            continue;
        };

        let controls = visible_controls(wizard);
        let signature = page_signature(&controls);
        if signature != last_signature {
            last_signature = signature;
            last_change = Instant::now();
            presses_without_change = 0;
        }

        let button = |caption: &str| {
            controls
                .iter()
                .find(|c| c.class == "TNewButton" && c.enabled && plain(&c.text) == caption)
                .map(|c| c.hwnd)
        };

        if button("Finish").is_some() {
            return WizardOutcome::Finished;
        }

        let next = button("Next >").or_else(|| button("Install"));
        if let Some(next) = next {
            installing = false;
            if let Some(limit) = options.limit_ram {
                if let Some(checkbox) = controls.iter().find(|c| {
                    c.class.contains("CheckBox") && c.text.contains("2 GB") && c.text.to_ascii_lowercase().contains("ram")
                }) {
                    if is_checked(checkbox.hwnd) != limit {
                        press(checkbox.hwnd);
                        std::thread::sleep(Duration::from_millis(300));
                        continue;
                    }
                }
            }
            let settled = last_change.elapsed() > Duration::from_millis(1200);
            let first_press = last_press.is_none_or(|t| t < last_change);
            let retry = last_press.is_some_and(|t| t.elapsed() > Duration::from_secs(5));
            if (first_press && settled) || retry {
                if presses_without_change >= 12 {
                    return WizardOutcome::Failed("The installer stopped responding to its buttons.".into());
                }
                press(next);
                presses_without_change += 1;
                last_press = Some(Instant::now());
            }
            continue;
        }

        installing = true;
        let mut best: Option<(isize, isize)> = None;
        let mut status = String::new();
        for c in &controls {
            if c.class.contains("ProgressBar") {
                let pos = send(c.hwnd, PBM_GETPOS, 0, 0);
                let max = send(c.hwnd, PBM_GETRANGE, 0, 0);
                if max > 0 && best.is_none_or(|(_, m)| max > m) {
                    best = Some((pos, max));
                }
            } else if c.class == "TNewStaticText" && status.is_empty() {
                let text = c.text.trim();
                if !text.is_empty() && !text.starts_with("Please wait") && !text.eq_ignore_ascii_case("Installing") {
                    status = text.to_string();
                }
            }
        }
        if window_text(wizard).to_ascii_lowercase().contains("finaliz") {
            report(WizardEvent::Finalizing);
        }
        if let Some((pos, max)) = best {
            let percent = (pos as f64 / max as f64 * 100.0).clamp(0.0, 100.0);
            let line = format!("{percent:.1}|{status}");
            if line != last_progress {
                last_progress = line;
                last_change = Instant::now();
                report(WizardEvent::Progress { percent, status: status.clone() });
            }
        }
        if last_change.elapsed() > Duration::from_secs(15 * 60) {
            return WizardOutcome::Failed("The installer made no progress for 15 minutes.".into());
        }
    }
}
