//! Keeps TruongFlix running when its window is closed (Settings → Devices, off by default), for
//! people who use it as a media server, seed torrents or share music on Soulseek.
//!
//! With the setting on, closing the window hides it, and an icon in the notification area
//! (Windows) or the menu bar (macOS) shows what's still going on, pauses or resumes torrents,
//! opens the window again and quits for real. Quitting (from that menu, or Cmd+Q on macOS) goes
//! through the app's normal exit, so the exit cleanup in `lib.rs` still runs.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

const MAIN: &str = "main";
const TRAY: &str = "truongflix-background";
/// How often the menu's status lines are brought up to date.
const REFRESH: Duration = Duration::from_secs(2);

/// The setting, as the app last sent it.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// Bumped whenever the status refresh should stop (or a new one replaces it).
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CONTROLS: Mutex<Option<Controls>> = Mutex::new(None);

/// The menu items that change.
struct Controls {
    status: [MenuItem<Wry>; 3],
    torrents: MenuItem<Wry>,
    /// What they show now, so they're only touched when something changed.
    shown: Option<([String; 3], TorrentToggle)>,
}

/// What closing a window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Not the main window: nothing special.
    NotMain,
    /// The main window closes and TruongFlix quits (the setting is off).
    Quit,
    /// The main window hides and TruongFlix keeps running in the background.
    Hide,
}

/// What closing the window labelled `label` does. It only hides when the setting is on and the
/// tray / menu bar icon is there, so there's always a way back to the window and to quitting.
pub fn close_action(label: &str, keep_running: bool, icon_shown: bool) -> CloseAction {
    if label != MAIN {
        CloseAction::NotMain
    } else if keep_running && icon_shown {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

/// [`close_action`] for this app right now.
pub fn close_action_now(app: &AppHandle, label: &str) -> CloseAction {
    close_action(label, ENABLED.load(Ordering::SeqCst), app.tray_by_id(TRAY).is_some())
}

/// What's running in the background, for the menu.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Activity {
    pub downloading: usize,
    pub seeding: usize,
    pub paused: usize,
    /// Soulseek's connection: "offline" | "connecting" | "online" | "error".
    pub soulseek: &'static str,
    pub music_downloads: usize,
    pub media_server: bool,
}

impl Activity {
    /// Counts one torrent by its engine state (see `torrent::TorrentStatus`).
    pub fn count_torrent(&mut self, state: &str, paused: bool, failed: bool) {
        if failed || state == "error" {
            return;
        }
        if paused {
            self.paused += 1;
        } else if state == "seeding" {
            self.seeding += 1;
        } else if matches!(state, "resolving" | "initializing" | "downloading") {
            self.downloading += 1;
        }
    }
}

/// The menu's torrent button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TorrentToggle {
    Pause,
    Resume,
    /// No torrents to pause or resume (shown greyed out).
    Nothing,
}

impl TorrentToggle {
    fn label(self) -> &'static str {
        match self {
            TorrentToggle::Resume => "Resume torrents",
            TorrentToggle::Pause | TorrentToggle::Nothing => "Pause torrents",
        }
    }
}

/// Pause while anything downloads or seeds; resume once everything is paused.
pub fn torrent_toggle(a: &Activity) -> TorrentToggle {
    if a.downloading + a.seeding > 0 {
        TorrentToggle::Pause
    } else if a.paused > 0 {
        TorrentToggle::Resume
    } else {
        TorrentToggle::Nothing
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The menu's three status lines: torrents, Soulseek and the media server.
pub fn status_lines(a: &Activity) -> [String; 3] {
    let mut torrents = Vec::new();
    if a.downloading > 0 {
        torrents.push(format!("{} downloading", a.downloading));
    }
    if a.seeding > 0 {
        torrents.push(format!("{} seeding", a.seeding));
    }
    if a.paused > 0 {
        torrents.push(format!("{} paused", a.paused));
    }
    let torrents = if torrents.is_empty() { "Torrents: none".to_string() } else { format!("Torrents: {}", torrents.join(", ")) };

    let connection = match a.soulseek {
        "online" => "connected",
        "connecting" => "connecting",
        _ => "off",
    };
    let soulseek = if a.music_downloads > 0 {
        format!("Soulseek: {connection}, {}", plural(a.music_downloads, "music download", "music downloads"))
    } else {
        format!("Soulseek: {connection}")
    };

    let server = format!("Media server: {}", if a.media_server { "on" } else { "off" });
    [torrents, soulseek, server]
}

/// Turns keeping TruongFlix running in the background on or off (the app sends its setting at
/// startup and whenever it changes).
#[tauri::command]
pub fn background_mode_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        if app.tray_by_id(TRAY).is_none() {
            build_icon(&app).map_err(|e| format!("Couldn’t add the TruongFlix icon: {e}"))?;
        }
        if !ENABLED.swap(true, Ordering::SeqCst) {
            nap::prevent(true);
            start_refresh();
        }
    } else {
        ENABLED.store(false, Ordering::SeqCst);
        GENERATION.fetch_add(1, Ordering::SeqCst);
        *CONTROLS.lock().unwrap() = None;
        // Dropping the last handle takes the icon away.
        drop(app.remove_tray_by_id(TRAY));
        nap::prevent(false);
        // Never leave the app running with no window and no icon.
        show_if_hidden(&app);
    }
    Ok(())
}

fn build_icon(app: &AppHandle) -> tauri::Result<()> {
    let start = status_lines(&Activity::default());
    let line = |i: usize| MenuItem::with_id(app, format!("status-{i}"), &start[i], false, None::<&str>);
    let status = [line(0)?, line(1)?, line(2)?];
    let torrents = MenuItem::with_id(app, "torrents", TorrentToggle::Nothing.label(), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open TruongFlix", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TruongFlix", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &status[0],
            &status[1],
            &status[2],
            &PredefinedMenuItem::separator(app)?,
            &torrents,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let builder = TrayIconBuilder::with_id(TRAY)
        .tooltip("TruongFlix")
        .menu(&menu)
        // Menu bar icons open their menu on click; on Windows a click opens the window and a
        // right-click the menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "open" => show_main(app),
            "torrents" => toggle_torrents(app.clone()),
            // The normal exit: the exit cleanup runs (`RunEvent::Exit`).
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
                | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => show_main(tray.app_handle()),
                _ => {}
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder.icon(tauri::image::Image::new_owned(template_icon(MENU_BAR_ICON), MENU_BAR_ICON, MENU_BAR_ICON)).icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder.icon(tauri::image::Image::new_owned(template_icon(MENU_BAR_ICON), MENU_BAR_ICON, MENU_BAR_ICON)),
    };
    builder.build(app)?;
    *CONTROLS.lock().unwrap() = Some(Controls { status, torrents, shown: None });
    Ok(())
}

/// Pixels across the menu bar icon (18 points on a Retina display, scaled down elsewhere).
const MENU_BAR_ICON: u32 = 36;

/// The app icon's rounded square with its "T" cut out, black on transparent (RGBA), for macOS to
/// tint to match the menu bar.
pub fn template_icon(size: u32) -> Vec<u8> {
    // In units of the 128-pixel app icon, which this follows.
    const SQUARE: (f64, f64) = (8.0, 120.0);
    const RADIUS: f64 = 24.0;
    const BAR: (f64, f64, f64, f64) = (34.0, 30.0, 94.0, 48.0);
    const STEM: (f64, f64, f64, f64) = (55.0, 48.0, 73.0, 100.0);
    let inside = |x: f64, y: f64| {
        let (lo, hi) = SQUARE;
        if !(lo..hi).contains(&x) || !(lo..hi).contains(&y) {
            return false;
        }
        let cx = x.clamp(lo + RADIUS, hi - RADIUS);
        let cy = y.clamp(lo + RADIUS, hi - RADIUS);
        let in_square = (x - cx).powi(2) + (y - cy).powi(2) <= RADIUS * RADIUS;
        let in_rect = |(l, t, r, b): (f64, f64, f64, f64)| (l..r).contains(&x) && (t..b).contains(&y);
        in_square && !in_rect(BAR) && !in_rect(STEM)
    };
    // 4×4 samples a pixel for smooth edges.
    const SAMPLES: u32 = 4;
    let scale = 128.0 / size as f64;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for py in 0..size {
        for px in 0..size {
            let mut hits = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = (px as f64 + (sx as f64 + 0.5) / SAMPLES as f64) * scale;
                    let y = (py as f64 + (sy as f64 + 0.5) / SAMPLES as f64) * scale;
                    hits += inside(x, y) as u32;
                }
            }
            rgba.extend_from_slice(&[0, 0, 0, (hits * 255 / (SAMPLES * SAMPLES)) as u8]);
        }
    }
    rgba
}

/// Brings the window back (from the icon, the Dock, or opening TruongFlix again).
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        after_visibility_change(app);
    }
}

/// Shows the window if it's hidden in the background (opening a link or a .torrent file).
pub fn show_if_hidden(app: &AppHandle) {
    let hidden = app.get_webview_window(MAIN).is_some_and(|w| !w.is_visible().unwrap_or(true));
    if hidden {
        show_main(app);
    }
}

/// Hides the window instead of closing it; the app is told so it can pause a video.
pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
        let _ = app.emit_to(MAIN, "window-hidden", ());
        after_visibility_change(app);
    }
}

fn after_visibility_change(app: &AppHandle) {
    let _ = app.run_on_main_thread(crate::player::on_main_window_visibility);
}

async fn activity() -> Activity {
    let mut a = Activity {
        soulseek: crate::soulseek::slsk_status().state,
        music_downloads: crate::soulseek::running_downloads(),
        media_server: crate::stream::browser_access_on(),
        ..Activity::default()
    };
    if let Some(manager) = crate::torrent::running_manager() {
        for t in manager.list_torrents().await {
            a.count_torrent(&t.state, t.paused, t.error.is_some());
        }
    }
    a
}

fn start_refresh() {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        while GENERATION.load(Ordering::SeqCst) == generation {
            refresh().await;
            tokio::time::sleep(REFRESH).await;
        }
    });
}

async fn refresh() {
    let a = activity().await;
    let lines = status_lines(&a);
    let toggle = torrent_toggle(&a);
    // Copied out: changing an item waits on the main thread, which may want this lock.
    let (status, torrents) = {
        let mut controls = CONTROLS.lock().unwrap();
        let Some(c) = controls.as_mut() else { return };
        let next = Some((lines.clone(), toggle));
        if c.shown == next {
            return;
        }
        c.shown = next;
        (c.status.clone(), c.torrents.clone())
    };
    for (item, text) in status.iter().zip(&lines) {
        let _ = item.set_text(text);
    }
    let _ = torrents.set_text(toggle.label());
    let _ = torrents.set_enabled(toggle != TorrentToggle::Nothing);
}

/// Pauses every running torrent, or resumes them all when they're all paused.
fn toggle_torrents(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(manager) = crate::torrent::running_manager() else { return };
        let list = manager.list_torrents().await;
        let mut a = Activity::default();
        for t in &list {
            a.count_torrent(&t.state, t.paused, t.error.is_some());
        }
        let (action, paused) = match torrent_toggle(&a) {
            TorrentToggle::Pause => ("pause", false),
            TorrentToggle::Resume => ("resume", true),
            TorrentToggle::Nothing => return,
        };
        for t in list.iter().filter(|t| t.paused == paused && t.error.is_none()) {
            let _ = manager.action(&t.info_hash, action, None).await;
        }
        // The Torrents page shows it right away instead of at its next check.
        let _ = app.emit_to(MAIN, "torrents-changed", ());
        refresh().await;
    });
}

/// macOS puts apps with no visible window to sleep (App Nap), which would slow torrents, the
/// media server and Soulseek down while TruongFlix runs in the background.
#[cfg(target_os = "macos")]
mod nap {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use std::sync::Mutex;

    struct Activity(Retained<AnyObject>);
    // Only ever handed back to NSProcessInfo, which is thread-safe.
    unsafe impl Send for Activity {}

    static ACTIVITY: Mutex<Option<Activity>> = Mutex::new(None);
    /// NSActivityUserInitiatedAllowingIdleSystemSleep: no App Nap, but the computer may still
    /// go to sleep.
    const OPTIONS: u64 = 0x00FF_FFFF & !(1 << 20);

    pub fn prevent(on: bool) {
        let mut slot = ACTIVITY.lock().unwrap();
        if on == slot.is_some() {
            return;
        }
        unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
            if on {
                let reason = NSString::from_str("Running in the background");
                let token: Retained<AnyObject> = msg_send![&*info, beginActivityWithOptions: OPTIONS, reason: &*reason];
                *slot = Some(Activity(token));
            } else if let Some(Activity(token)) = slot.take() {
                let _: () = msg_send![&*info, endActivity: &*token];
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod nap {
    pub fn prevent(_on: bool) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_quits_unless_the_setting_is_on() {
        assert_eq!(close_action("main", false, false), CloseAction::Quit);
        assert_eq!(close_action("main", false, true), CloseAction::Quit);
        assert_eq!(close_action("main", true, true), CloseAction::Hide);
    }

    #[test]
    fn closing_quits_when_there_is_no_icon_to_come_back_from() {
        assert_eq!(close_action("main", true, false), CloseAction::Quit);
    }

    #[test]
    fn other_windows_close_as_usual() {
        for label in ["source-browser", "playlist-reader", "anything"] {
            assert_eq!(close_action(label, true, true), CloseAction::NotMain);
            assert_eq!(close_action(label, false, false), CloseAction::NotMain);
        }
    }

    #[test]
    fn torrents_are_counted_by_state() {
        let mut a = Activity::default();
        a.count_torrent("downloading", false, false);
        a.count_torrent("resolving", false, false);
        a.count_torrent("initializing", false, false);
        a.count_torrent("seeding", false, false);
        a.count_torrent("paused", true, false);
        a.count_torrent("downloading", true, false);
        a.count_torrent("error", false, false);
        a.count_torrent("downloading", false, true);
        assert_eq!((a.downloading, a.seeding, a.paused), (3, 1, 2));
    }

    #[test]
    fn the_torrent_button_pauses_while_anything_runs() {
        let mut a = Activity::default();
        assert_eq!(torrent_toggle(&a), TorrentToggle::Nothing);
        a.paused = 2;
        assert_eq!(torrent_toggle(&a), TorrentToggle::Resume);
        a.seeding = 1;
        assert_eq!(torrent_toggle(&a), TorrentToggle::Pause);
        a = Activity { downloading: 1, ..Activity::default() };
        assert_eq!(torrent_toggle(&a), TorrentToggle::Pause);
    }

    #[test]
    fn status_lines_are_short_and_plain() {
        assert_eq!(status_lines(&Activity::default()), ["Torrents: none", "Soulseek: off", "Media server: off"]);
        let busy = Activity { downloading: 2, seeding: 5, paused: 1, soulseek: "online", music_downloads: 1, media_server: true };
        assert_eq!(
            status_lines(&busy),
            ["Torrents: 2 downloading, 5 seeding, 1 paused", "Soulseek: connected, 1 music download", "Media server: on"],
        );
        let connecting = Activity { soulseek: "connecting", music_downloads: 3, ..Activity::default() };
        assert_eq!(status_lines(&connecting)[1], "Soulseek: connecting, 3 music downloads");
        assert_eq!(status_lines(&Activity { soulseek: "error", ..Activity::default() })[1], "Soulseek: off");
    }

    #[test]
    fn the_menu_bar_icon_is_the_app_icon_with_its_t_cut_out() {
        let size = MENU_BAR_ICON as usize;
        let icon = template_icon(MENU_BAR_ICON);
        assert_eq!(icon.len(), size * size * 4);
        let alpha = |x: usize, y: usize| icon[(y * size + x) * 4 + 3];
        // Template icons are black; only the alpha carries the shape.
        assert!(icon.chunks(4).all(|p| p[..3] == [0, 0, 0]));
        assert_eq!(alpha(0, 0), 0, "corners are rounded off");
        assert_eq!(alpha(size / 2, size * 3 / 4), 0, "the T's stem is cut out");
        assert_eq!(alpha(size / 2, size / 4), 0, "the T's bar is cut out");
        assert_eq!(alpha(size / 5, size / 2), 255, "the square around it is solid");
    }
}
