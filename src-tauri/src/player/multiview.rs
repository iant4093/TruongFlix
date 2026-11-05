//! The second pane has its own decoder and network options. The primary player still owns
//! playback controls, power events and the session shown in the app.

use super::{create_core, mpv, on_main, read_flag, MiniRect, LIFECYCLE, SESSION};
use crate::live::Transport;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, WebviewWindow};

struct Secondary {
    handle: usize,
    primary: usize,
    #[cfg(windows)]
    window: isize,
    stop: Arc<AtomicBool>,
    primary_audio: String,
    primary_mute: String,
}

static SECONDARY: Mutex<Option<Secondary>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecondaryState {
    load_id: String,
    pane_id: String,
    loaded: bool,
    paused: bool,
    buffering: bool,
    failed: bool,
}

fn primary(load_id: &str) -> Result<*mut mpv::Handle, String> {
    SESSION
        .lock()
        .unwrap()
        .as_ref()
        .filter(|s| s.live && !s.closing && s.load_id == load_id)
        .map(|s| s.handle as *mut mpv::Handle)
        .ok_or_else(|| "No active Live TV session".into())
}

fn validate_rect(rect: MiniRect) -> Result<(), String> {
    let (x, y, w, h) = rect.coords();
    let (vw, vh) = rect.viewport().ok_or("Invalid multiview viewport")?;
    if [x, y, w, h].iter().all(|v| v.is_finite())
        && x >= 0.0
        && y >= 0.0
        && w > 0.0
        && h > 0.0
        && vw <= 32_768.0
        && vh <= 32_768.0
        && x + w <= vw + 1.0
        && y + h <= vh + 1.0
    {
        Ok(())
    } else {
        Err("Invalid multiview pane position".into())
    }
}

fn layout(app: &AppHandle, left: MiniRect, right: MiniRect) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    on_main(app, move || super::macos::set_multiview(left, right))?;
    #[cfg(windows)]
    on_main(app, move || super::win32::set_multiview(left, right))?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (app, left, right);
    Ok(())
}

#[tauri::command]
pub async fn player_multiview_layout(
    app: AppHandle,
    load_id: String,
    left: MiniRect,
    right: MiniRect,
) -> Result<(), String> {
    validate_rect(left)?;
    validate_rect(right)?;
    let _lifecycle = LIFECYCLE.lock().unwrap();
    primary(&load_id)?;
    layout(&app, left, right)
}

#[tauri::command]
pub async fn player_multiview_open(
    app: AppHandle,
    window: WebviewWindow,
    load_id: String,
    pane_id: String,
    source: Transport,
    left: MiniRect,
    right: MiniRect,
) -> Result<(), String> {
    source.validate()?;
    validate_rect(left)?;
    validate_rect(right)?;
    let _lifecycle = LIFECYCLE.lock().unwrap();
    let primary = primary(&load_id)?;
    stop(&app, Some(primary as usize));
    layout(&app, left, right)?;
    let api = mpv::api()?;

    #[cfg(target_os = "macos")]
    let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
    #[cfg(not(target_os = "macos"))]
    let _ = &window;
    #[cfg(windows)]
    let video_window = Some(on_main(&app, super::win32::attach_secondary)??);
    #[cfg(not(windows))]
    let video_window = None;

    let handle = match create_core(api, "", "", video_window) {
        Ok(handle) => handle,
        Err(error) => {
            retire_window(&app, 0, video_window);
            destroy_window(&app, video_window);
            return Err(error);
        }
    };
    let address = handle as usize;
    let initialize = || -> Result<(), String> {
        #[cfg(target_os = "macos")]
        on_main(&app, move || {
            super::macos::attach_secondary(ns_window as *mut _, address as *mut _)
        })??;
        layout(&app, left, right)?;
        for (name, value) in [
            ("aid", "no"),
            ("sid", "no"),
            ("cache", "yes"),
            ("demuxer-max-bytes", "64MiB"),
            ("demuxer-max-back-bytes", "16MiB"),
        ] {
            api.set_property(handle, name, value)?;
        }
        for name in ["audio-device", "volume", "pause", "af", "audio-delay"] {
            if let Some(value) = api.get_property(primary, name) {
                let _ = api.set_property(handle, name, &value);
            }
        }
        if !source.referrer.is_empty() {
            api.set_property(handle, "referrer", &source.referrer)?;
        }
        if !source.user_agent.is_empty() {
            api.set_property(handle, "user-agent", &source.user_agent)?;
        }
        api.command(handle, &["loadfile", &source.url, "replace"])
    };
    if let Err(error) = initialize() {
        retire_window(&app, address, video_window);
        unsafe {
            (api.terminate_destroy)(handle);
        }
        destroy_window(&app, video_window);
        return Err(error);
    }

    let stopping = Arc::new(AtomicBool::new(false));
    let state = SecondaryState {
        load_id,
        pane_id,
        loaded: false,
        paused: false,
        buffering: true,
        failed: false,
    };
    let stop_worker = stopping.clone();
    let worker_app = app.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("mpv-multiview".into())
        .spawn(move || {
            monitor(worker_app, address, video_window, stop_worker, state);
        })
    {
        retire_window(&app, address, video_window);
        unsafe {
            (api.terminate_destroy)(handle);
        }
        destroy_window(&app, video_window);
        return Err(error.to_string());
    }
    let primary_mute = api
        .get_property(primary, "mute")
        .unwrap_or_else(|| "no".into());
    let _ = api.set_property(primary, "mute", "no");
    *SECONDARY.lock().unwrap() = Some(Secondary {
        handle: address,
        primary: primary as usize,
        #[cfg(windows)]
        window: video_window.expect("secondary HWND"),
        stop: stopping,
        primary_audio: api
            .get_property(primary, "aid")
            .filter(|aid| aid != "no")
            .unwrap_or_else(|| "auto".into()),
        primary_mute,
    });
    Ok(())
}

fn monitor(
    app: AppHandle,
    address: usize,
    window: Option<isize>,
    stopping: Arc<AtomicBool>,
    mut state: SecondaryState,
) {
    let Ok(api) = mpv::api() else { return };
    let handle = address as *mut mpv::Handle;
    let mut last_tick = Instant::now();
    while !stopping.load(Ordering::Acquire) {
        let event = unsafe { &*(api.wait_event)(handle, 0.20) };
        match event.event_id {
            mpv::EVENT_FILE_LOADED => {
                state.loaded = true;
                state.buffering = false;
            }
            mpv::EVENT_END_FILE => {
                state.loaded = false;
                state.failed = true;
            }
            mpv::EVENT_PROPERTY_CHANGE if !event.data.is_null() => {
                let property = unsafe { &*(event.data as *const mpv::EventProperty) };
                match event.reply_userdata {
                    1 if last_tick.elapsed() >= Duration::from_secs(1) => {
                        last_tick = Instant::now()
                    }
                    3 => state.paused = read_flag(property).unwrap_or(false),
                    4 if read_flag(property) == Some(true) => state.failed = true,
                    8 => state.buffering = read_flag(property).unwrap_or(false),
                    _ => continue,
                }
            }
            // All externally initiated shutdowns first detach the surface in stop().
            _ => continue,
        }
        if !stopping.load(Ordering::Acquire) {
            let _ = app.emit("player-multiview-state", &state);
        }
    }
    unsafe {
        (api.terminate_destroy)(handle);
    }
    destroy_window(&app, window);
}

fn retire_window(app: &AppHandle, address: usize, window: Option<isize>) {
    #[cfg(target_os = "macos")]
    let _ = on_main(app, move || super::macos::detach_for(address));
    #[cfg(windows)]
    let _ = on_main(app, super::win32::release_secondary);
    let _ = (app, address, window);
}

fn destroy_window(app: &AppHandle, window: Option<isize>) {
    #[cfg(windows)]
    if let Some(window) = window {
        let _ = on_main(app, move || super::win32::destroy_secondary(window));
    }
    let _ = (app, window);
}

/// Called while LIFECYCLE is held before the primary core switches files or closes.
pub(super) fn stop(app: &AppHandle, primary: Option<usize>) {
    let Some(secondary) = SECONDARY.lock().unwrap().take() else {
        return;
    };
    if let Ok(api) = mpv::api() {
        let _ = api.set_property(secondary.handle as *mut _, "aid", "no");
        if let Some(primary) = primary.filter(|handle| *handle == secondary.primary) {
            let _ = api.set_property(primary as *mut _, "aid", &secondary.primary_audio);
            let _ = api.set_property(primary as *mut _, "mute", &secondary.primary_mute);
        }
    }
    #[cfg(windows)]
    let window = Some(secondary.window);
    #[cfg(not(windows))]
    let window = None;
    retire_window(app, secondary.handle, window);
    secondary.stop.store(true, Ordering::Release);
}

pub(super) fn primary_exited(app: &AppHandle, handle: usize) {
    let _lifecycle = LIFECYCLE.lock().unwrap();
    let has_secondary = SECONDARY
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|pane| pane.primary == handle);
    if has_secondary {
        stop(app, None);
    }
}

#[tauri::command]
pub async fn player_multiview_audio(load_id: String, secondary: bool) -> Result<(), String> {
    let _lifecycle = LIFECYCLE.lock().unwrap();
    let primary = primary(&load_id)?;
    let api = mpv::api()?;
    let state = SECONDARY.lock().unwrap();
    let other = state.as_ref().ok_or("The second channel is not open")?;
    let second = other.handle as *mut mpv::Handle;
    if secondary {
        api.set_property(primary, "aid", "no")?;
        if let Err(error) = api.set_property(second, "aid", "auto") {
            let _ = api.set_property(primary, "aid", &other.primary_audio);
            return Err(error);
        }
    } else {
        api.set_property(second, "aid", "no")?;
        api.set_property(primary, "aid", &other.primary_audio)?;
        api.set_property(primary, "mute", "no")?;
    }
    Ok(())
}

pub(super) fn mirror(api: &mpv::Api, name: &str, value: &str) {
    if matches!(
        name,
        "pause" | "volume" | "audio-device" | "audio-delay" | "af"
    ) {
        if let Some(secondary) = SECONDARY.lock().unwrap().as_ref() {
            let _ = api.set_property(secondary.handle as *mut _, name, value);
        }
    }
}
