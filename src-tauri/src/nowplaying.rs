//! System media controls for the built-in player: media keys, AirPods/headphone buttons, the
//! macOS Now Playing widget (Control Center / lock screen) and the Windows media overlay.
//! The frontend pushes what's playing; button presses come back as `media-control` events.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
pub struct SessionUpdate {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: f64,
    pub position: f64,
    /// "playing" | "paused"
    pub state: String,
    pub rate: f64,
    pub cover_url: Option<String>,
    pub can_next: bool,
}

#[derive(Clone, Serialize)]
struct ControlEvent {
    action: &'static str,
    value: f64,
}

fn emit(app: &AppHandle, action: &'static str, value: f64) {
    let _ = app.emit("media-control", ControlEvent { action, value });
}

/// Shows (or updates) what's playing in the system media controls.
#[tauri::command]
pub fn media_session_update(app: AppHandle, update: SessionUpdate) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || platform::update(&handle, update)).map_err(|e| e.to_string())
}

/// Hands the media keys back to other apps (playback ended).
#[tauri::command]
pub fn media_session_clear(app: AppHandle) -> Result<(), String> {
    app.run_on_main_thread(platform::clear).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// macOS: MPNowPlayingInfoCenter + MPRemoteCommandCenter
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    use super::{emit, SessionUpdate};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSNumber, NSSize, NSString};
    use std::cell::RefCell;
    use tauri::AppHandle;

    #[link(name = "MediaPlayer", kind = "framework")]
    extern "C" {
        static MPMediaItemPropertyTitle: *const AnyObject;
        static MPMediaItemPropertyArtist: *const AnyObject;
        static MPMediaItemPropertyAlbumTitle: *const AnyObject;
        static MPMediaItemPropertyPlaybackDuration: *const AnyObject;
        static MPMediaItemPropertyArtwork: *const AnyObject;
        static MPNowPlayingInfoPropertyElapsedPlaybackTime: *const AnyObject;
        static MPNowPlayingInfoPropertyPlaybackRate: *const AnyObject;
        static MPNowPlayingInfoPropertyMediaType: *const AnyObject;
    }

    const STATE_PLAYING: usize = 1;
    const STATE_PAUSED: usize = 2;
    const STATE_STOPPED: usize = 3;
    const MEDIA_TYPE_VIDEO: usize = 2;
    const SKIP_SECONDS: f64 = 10.0;

    #[derive(Default)]
    struct State {
        /// (command, target) pairs registered with the command center.
        targets: Vec<(Retained<AnyObject>, Retained<AnyObject>)>,
        next_cmd: Option<Retained<AnyObject>>,
        artwork: Option<(String, Retained<AnyObject>)>,
        loading_cover: Option<String>,
        last: Option<SessionUpdate>,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::new(State::default());
    }

    unsafe fn command(center: &AnyObject, name: &str) -> Retained<AnyObject> {
        let cmd: *mut AnyObject = match name {
            "play" => msg_send![center, playCommand],
            "pause" => msg_send![center, pauseCommand],
            "toggle" => msg_send![center, togglePlayPauseCommand],
            "next" => msg_send![center, nextTrackCommand],
            "previous" => msg_send![center, previousTrackCommand],
            "stop" => msg_send![center, stopCommand],
            "skip_forward" => msg_send![center, skipForwardCommand],
            "skip_backward" => msg_send![center, skipBackwardCommand],
            _ => msg_send![center, changePlaybackPositionCommand],
        };
        Retained::retain(cmd).expect("MPRemoteCommandCenter command")
    }

    unsafe fn attach(app: &AppHandle, state: &mut State) {
        if !state.targets.is_empty() {
            return;
        }
        let center: *mut AnyObject = msg_send![class!(MPRemoteCommandCenter), sharedCommandCenter];
        let Some(center) = center.as_ref() else { return };
        for name in ["play", "pause", "toggle", "next", "previous", "stop", "skip_forward", "skip_backward", "position"] {
            let cmd = command(center, name);
            if name == "next" {
                state.next_cmd = Some(cmd.clone());
            }
            if name.starts_with("skip") {
                let interval = NSNumber::new_f64(SKIP_SECONDS);
                let intervals: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: &*interval];
                let _: () = msg_send![&*cmd, setPreferredIntervals: intervals];
            }
            let app = app.clone();
            let block = RcBlock::new(move |event: *mut AnyObject| -> isize {
                match name {
                    "skip_forward" | "skip_backward" => {
                        let mut interval: f64 = if event.is_null() { SKIP_SECONDS } else { unsafe { msg_send![event, interval] } };
                        if interval <= 0.0 {
                            interval = SKIP_SECONDS;
                        }
                        emit(&app, "seek_by", if name == "skip_forward" { interval } else { -interval });
                    }
                    "position" => {
                        if !event.is_null() {
                            let t: f64 = unsafe { msg_send![event, positionTime] };
                            emit(&app, "set_position", t);
                        }
                    }
                    "play" => emit(&app, "play", 0.0),
                    "pause" => emit(&app, "pause", 0.0),
                    "toggle" => emit(&app, "toggle", 0.0),
                    "next" => emit(&app, "next", 0.0),
                    "previous" => emit(&app, "previous", 0.0),
                    _ => emit(&app, "stop", 0.0),
                }
                0 // MPRemoteCommandHandlerStatusSuccess
            });
            let target: *mut AnyObject = msg_send![&*cmd, addTargetWithHandler: &*block];
            let _: () = msg_send![&*cmd, setEnabled: true];
            if let Some(target) = Retained::retain(target) {
                state.targets.push((cmd, target));
            }
        }
    }

    unsafe fn set(dict: &AnyObject, key: *const AnyObject, value: &AnyObject) {
        let _: () = msg_send![dict, setObject: value, forKey: key];
    }

    unsafe fn apply(state: &State, u: &SessionUpdate) {
        let dict: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
        let Some(dict) = dict.as_ref() else { return };
        set(dict, MPMediaItemPropertyTitle, &NSString::from_str(&u.title));
        if let Some(a) = &u.artist {
            set(dict, MPMediaItemPropertyArtist, &NSString::from_str(a));
        }
        if let Some(a) = &u.album {
            set(dict, MPMediaItemPropertyAlbumTitle, &NSString::from_str(a));
        }
        let playing = u.state == "playing";
        set(dict, MPMediaItemPropertyPlaybackDuration, &NSNumber::new_f64(u.duration.max(0.0)));
        set(dict, MPNowPlayingInfoPropertyElapsedPlaybackTime, &NSNumber::new_f64(u.position.max(0.0)));
        set(dict, MPNowPlayingInfoPropertyPlaybackRate, &NSNumber::new_f64(if playing { u.rate.max(0.1) } else { 0.0 }));
        set(dict, MPNowPlayingInfoPropertyMediaType, &NSNumber::new_usize(MEDIA_TYPE_VIDEO));
        if let (Some(url), Some((art_url, art))) = (&u.cover_url, &state.artwork) {
            if url == art_url {
                set(dict, MPMediaItemPropertyArtwork, art);
            }
        }
        let info: *mut AnyObject = msg_send![class!(MPNowPlayingInfoCenter), defaultCenter];
        let _: () = msg_send![info, setNowPlayingInfo: dict];
        let _: () = msg_send![info, setPlaybackState: if playing { STATE_PLAYING } else { STATE_PAUSED }];

        if let Some(next) = &state.next_cmd {
            let _: () = msg_send![&**next, setEnabled: u.can_next];
        }
        if std::env::var_os("TRUONGFLIX_PLAYER_DEBUG").is_some() {
            let current: *mut AnyObject = msg_send![info, nowPlayingInfo];
            let desc: *mut NSString = if current.is_null() { std::ptr::null_mut() } else { msg_send![current, description] };
            let st: usize = msg_send![info, playbackState];
            let text = desc.as_ref().map(|d| d.to_string()).unwrap_or_default().replace('\n', " ");
            eprintln!("[nowplaying] state={st} commands={} info={text}", state.targets.len());
        }
    }

    /// Turns downloaded poster bytes into an MPMediaItemArtwork (main thread).
    unsafe fn artwork_from(bytes: &[u8]) -> Option<Retained<AnyObject>> {
        let data: *mut AnyObject = msg_send![class!(NSData), dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void, length: bytes.len()];
        let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let image: *mut AnyObject = msg_send![image, initWithData: data];
        let image = Retained::from_raw(image)?;
        let size: NSSize = msg_send![&*image, size];
        let handler_image = image.clone();
        let handler = RcBlock::new(move |_size: NSSize| -> *mut AnyObject { Retained::as_ptr(&handler_image) as *mut AnyObject });
        let art: *mut AnyObject = msg_send![class!(MPMediaItemArtwork), alloc];
        let art: *mut AnyObject = msg_send![art, initWithBoundsSize: size, requestHandler: &*handler];
        Retained::from_raw(art)
    }

    fn load_cover(app: &AppHandle, url: String) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let bytes = match reqwest::get(&url).await {
                Ok(r) if r.status().is_success() => r.bytes().await.ok(),
                _ => None,
            };
            let Some(bytes) = bytes else { return };
            let _ = app.clone().run_on_main_thread(move || {
                STATE.with(|s| {
                    let mut s = s.borrow_mut();
                    s.loading_cover = None;
                    if let Some(art) = unsafe { artwork_from(&bytes) } {
                        s.artwork = Some((url, art));
                        if let Some(last) = s.last.clone() {
                            unsafe { apply(&s, &last) };
                        }
                    }
                });
            });
        });
    }

    pub fn update(app: &AppHandle, u: SessionUpdate) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            unsafe { attach(app, &mut s) };
            if let Some(url) = u.cover_url.clone().filter(|u| u.starts_with("http")) {
                let have = s.artwork.as_ref().is_some_and(|(a, _)| *a == url);
                if !have && s.loading_cover.as_deref() != Some(url.as_str()) {
                    s.loading_cover = Some(url.clone());
                    load_cover(app, url);
                }
            }
            unsafe { apply(&s, &u) };
            s.last = Some(u);
        });
    }

    pub fn clear() {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            unsafe {
                for (cmd, target) in s.targets.drain(..) {
                    let _: () = msg_send![&*cmd, removeTarget: &*target];
                    let _: () = msg_send![&*cmd, setEnabled: false];
                }
                s.next_cmd = None;
                let info: *mut AnyObject = msg_send![class!(MPNowPlayingInfoCenter), defaultCenter];
                let none: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![info, setNowPlayingInfo: none];
                let _: () = msg_send![info, setPlaybackState: STATE_STOPPED];
            }
            s.last = None;
        });
    }
}

// ---------------------------------------------------------------------------
// Windows: System Media Transport Controls (via souvlaki)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::{emit, SessionUpdate};
    use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
    use std::cell::RefCell;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    thread_local! {
        static CONTROLS: RefCell<Option<(MediaControls, Option<SessionUpdate>)>> = const { RefCell::new(None) };
    }

    fn create(app: &AppHandle) -> Option<MediaControls> {
        let window = app.get_webview_window("main")?;
        let hwnd = window.hwnd().ok()?.0 as *mut std::ffi::c_void;
        let mut controls = MediaControls::new(PlatformConfig { display_name: "TruongFlix", dbus_name: "truongflix", hwnd: Some(hwnd) }).ok()?;
        let app = app.clone();
        controls
            .attach(move |event| match event {
                MediaControlEvent::Play => emit(&app, "play", 0.0),
                MediaControlEvent::Pause => emit(&app, "pause", 0.0),
                MediaControlEvent::Toggle => emit(&app, "toggle", 0.0),
                MediaControlEvent::Next => emit(&app, "next", 0.0),
                MediaControlEvent::Previous => emit(&app, "previous", 0.0),
                MediaControlEvent::Stop => emit(&app, "stop", 0.0),
                MediaControlEvent::Seek(dir) => emit(&app, "seek_by", if dir == SeekDirection::Forward { 10.0 } else { -10.0 }),
                MediaControlEvent::SeekBy(dir, d) => {
                    emit(&app, "seek_by", if dir == SeekDirection::Forward { d.as_secs_f64() } else { -d.as_secs_f64() })
                }
                MediaControlEvent::SetPosition(MediaPosition(d)) => emit(&app, "set_position", d.as_secs_f64()),
                _ => {}
            })
            .ok()?;
        Some(controls)
    }

    pub fn update(app: &AppHandle, u: SessionUpdate) {
        CONTROLS.with(|c| {
            let mut c = c.borrow_mut();
            if c.is_none() {
                *c = create(app).map(|m| (m, None));
            }
            let Some((controls, last)) = c.as_mut() else { return };
            let metadata_changed = last.as_ref().is_none_or(|l| l.title != u.title || l.artist != u.artist || l.cover_url != u.cover_url);
            if metadata_changed {
                let _ = controls.set_metadata(MediaMetadata {
                    title: Some(&u.title),
                    artist: u.artist.as_deref(),
                    album: u.album.as_deref(),
                    cover_url: u.cover_url.as_deref(),
                    duration: Some(Duration::from_secs_f64(u.duration.max(0.0))),
                });
            }
            let progress = Some(MediaPosition(Duration::from_secs_f64(u.position.max(0.0))));
            let _ = controls.set_playback(if u.state == "playing" { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } });
            *last = Some(u);
        });
    }

    pub fn clear() {
        CONTROLS.with(|c| {
            if let Some((mut controls, _)) = c.borrow_mut().take() {
                let _ = controls.set_playback(MediaPlayback::Stopped);
                let _ = controls.detach();
            }
        });
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::SessionUpdate;
    use tauri::AppHandle;
    pub fn update(_app: &AppHandle, _u: SessionUpdate) {}
    pub fn clear() {}
}
