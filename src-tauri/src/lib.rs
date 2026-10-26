mod files;
mod imdb;
mod media;
mod player;
mod scanner;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_autoplay,
            scanner::scan_media_folders,
            scanner::check_paths,
            vlc::detect_vlc,
            vlc::install_vlc,
            vlc::launch_vlc,
            vlc::stop_vlc,
            subtitles::subtitle_hash,
            subtitles::opensubtitles_verify,
            subtitles::opensubtitles_search,
            subtitles::opensubtitles_download,
            subtitles::list_local_subtitles,
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
