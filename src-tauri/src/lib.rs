mod audio;
mod cast;
mod files;
mod imdb;
mod media;
mod nas;
mod nowplaying;
mod player;
mod power;
mod scanner;
mod stream;
mod subsync;
mod subtitles;
mod vlc;
mod watcher;

#[cfg(target_os = "macos")]
#[doc(hidden)]
pub use player::smoke_test as player_smoke_test;

use tauri::Manager;

/// `TRUONGFLIX_AUTOPLAY=<video path>` starts playback at launch (used by CI's player smoke test).
#[tauri::command]
fn startup_autoplay() -> Option<String> {
    std::env::var("TRUONGFLIX_AUTOPLAY").ok().filter(|p| std::path::Path::new(p).is_file())
}

/// The updater only reports "no valid release JSON" when the feed fails, so this fetches the feed
/// itself to tell the user what actually happened (offline, HTTP 403/404/429, …).
#[tauri::command]
async fn update_feed_status(app: tauri::AppHandle) -> String {
    let url = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.get(0))
        .and_then(|e| e.as_str())
        .unwrap_or_default()
        .to_owned();
    if url.is_empty() {
        return "no update feed is configured".into();
    }
    let client = match reqwest::Client::builder().user_agent("tauri-updater").timeout(std::time::Duration::from_secs(15)).build() {
        Ok(c) => c,
        Err(e) => return e.to_string(),
    };
    match client.get(&url).send().await {
        Ok(res) if res.status().is_success() => "ok".into(),
        Ok(res) => format!("GitHub answered HTTP {}", res.status()),
        Err(e) if e.is_timeout() => "GitHub didn’t answer within 15 seconds".into(),
        Err(e) if e.is_connect() => "couldn’t connect to GitHub (offline, VPN or firewall?)".into(),
        Err(e) => e.to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(vlc::VlcState::default())
        .manage(subtitles::SubtitleState::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(player::on_main_window_event);
            }
            power::start(app.handle());
            stream::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_autoplay,
            update_feed_status,
            cast::cast_discover,
            cast::cast_start,
            cast::cast_control,
            stream::stream_probe,
            stream::stream_encoder,
            stream::stream_register,
            stream::stream_url,
            stream::stream_release,
            stream::remote_access_set,
            stream::server_info,
            stream::remote_api_reply,
            audio::audio_devices,
            audio::default_audio_device,
            nas::share_info,
            nas::connect_share,
            nowplaying::media_session_update,
            nowplaying::media_session_clear,
            scanner::scan_media_folders,
            scanner::check_paths,
            vlc::detect_vlc,
            vlc::install_vlc,
            vlc::launch_vlc,
            vlc::stop_vlc,
            vlc::pause_vlc,
            subtitles::subtitle_hash,
            subtitles::opensubtitles_verify,
            subtitles::opensubtitles_search,
            subtitles::opensubtitles_download,
            subtitles::list_local_subtitles,
            subtitles::sidecar_subtitle_languages,
            subsync::sync_subtitle,
            subsync::undo_subtitle_sync,
            subsync::subtitle_sync_backup_exists,
            subtitles::delete_subtitle_file,
            files::organize_loose_files,
            files::trash_media,
            files::restore_trash,
            files::purge_trash,
            files::reveal_in_file_manager,
            imdb::imdb_lookup,
            player::player_status,
            player::player_open,
            player::player_command,
            player::player_set,
            player::player_close,
            player::player_layout,
            media::media_probe,
            media::extract_frames,
            media::detect_intros,
            watcher::watch_folders,
            files::apply_moves,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TruongFlix");
}
