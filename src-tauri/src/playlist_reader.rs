//! Reads a whole Spotify or Apple Music playlist from its public page, for playlists longer than
//! the page first shows (Spotify's embed stops at 100 songs, Apple Music's page at 300).
//!
//! The page opens in a window of its own, off-screen and never shown, with its own browsing data,
//! and is scrolled the way a person would scroll it: the page's own code loads the rest of the
//! songs as it goes, exactly as it does for any visitor who isn't signed in. A small script reads
//! each row from the screen (`playlist_reader.js`) and hands the songs back by "navigating" to a
//! made-up address, which the app catches and cancels. The page gets no access to the app: no
//! commands, nothing but those bounded messages. Everything else the page might try to open
//! (other sites, new windows, downloads, permissions) is refused, and the window closes when the
//! playlist is read.

use crate::playlists::PlaylistSong;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl};

const LABEL: &str = "playlist-reader";
const REPLY_HOST: &str = "truongflix-reader.invalid";
/// The longest a playlist may take to read (a 1,000-song Apple Music playlist takes ~30 s).
const LIMIT: Duration = Duration::from_secs(240);
/// Largest single message accepted from the page.
const MAX_MESSAGE: usize = 400_000;
/// Most songs accepted from one playlist.
const MAX_SONGS: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    at: i64,
    id: Option<String>,
    title: String,
    #[serde(default)]
    artists: Vec<String>,
    album: Option<String>,
    length_ms: Option<u32>,
    #[serde(default)]
    explicit: bool,
}

#[derive(Default)]
struct Reading {
    songs: BTreeMap<i64, Row>,
    finished: Option<Result<(), String>>,
}

/// Which page to read.
pub enum Page {
    Spotify(String),
    /// Storefront, playlist id.
    Apple(String, String),
}

impl Page {
    fn address(&self) -> (String, &'static str, &'static str) {
        match self {
            Page::Spotify(id) => (format!("https://open.spotify.com/playlist/{id}"), "open.spotify.com", "spotify"),
            Page::Apple(cc, id) => (format!("https://music.apple.com/{cc}/playlist/{id}"), "music.apple.com", "apple"),
        }
    }
}

/// What a message from the page says, when it's one of ours: its kind, number and content.
fn parse_reply(url: &Url) -> Option<(String, u64, String)> {
    if url.host_str() != Some(REPLY_HOST) {
        return None;
    }
    let kind = url.path().trim_start_matches('/').to_string();
    let n = url.query_pairs().find(|(k, _)| k == "n")?.1.parse().ok()?;
    let body = url.fragment().unwrap_or("");
    if body.len() > MAX_MESSAGE * 3 {
        return None;
    }
    let body = percent_decode(body)?;
    (body.len() <= MAX_MESSAGE).then_some((kind, n, body))
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Takes in one message from the page; true when it was ours (and so must not be navigated to).
fn take_reply(reading: &Mutex<Reading>, kind: &str, body: &str) {
    let mut reading = reading.lock().unwrap();
    match kind {
        "songs" => {
            if let Ok(rows) = serde_json::from_str::<Vec<Row>>(body) {
                for row in rows {
                    if reading.songs.len() >= MAX_SONGS {
                        break;
                    }
                    if !row.title.trim().is_empty() && row.title.len() < 400 {
                        reading.songs.insert(row.at, row);
                    }
                }
            }
        }
        "done" => reading.finished = Some(Ok(())),
        "error" => {
            let message = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v["message"].as_str().map(|m| m.chars().take(200).collect()))
                .unwrap_or_else(|| "The playlist page couldn’t be read".to_string());
            reading.finished = Some(Err(message));
        }
        _ => {}
    }
}

fn song_from(row: Row, apple: bool) -> PlaylistSong {
    PlaylistSong {
        title: row.title.trim().to_string(),
        artists: row.artists.into_iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).take(20).collect(),
        album: row.album.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()),
        length_ms: row.length_ms,
        apple_id: row.id.filter(|id| apple && !id.is_empty() && id.len() < 20 && id.chars().all(|c| c.is_ascii_digit())),
        cover: None,
        explicit: row.explicit,
    }
}

/// Reads every song of the playlist on `page`, in order. Progress goes to the app as
/// `playlist-read-progress` events (songs read so far).
pub async fn read_all(app: &AppHandle, page: Page) -> Result<Vec<PlaylistSong>, String> {
    // One playlist page at a time.
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _turn = ONE.lock().await;
    if let Some(old) = app.get_webview_window(LABEL) {
        let _ = old.destroy();
    }
    let (address, host, service) = page.address();
    let apple = matches!(page, Page::Apple(..));
    let reading = Arc::new(Mutex::new(Reading::default()));
    let config = serde_json::json!({ "service": service, "host": host, "limitMs": (LIMIT.as_millis() as u64).saturating_sub(20_000) });
    let script = include_str!("playlist_reader.js").replace("__READER_CONFIG__", &config.to_string());
    let target: Url = address.parse().map_err(|_| "Not a playlist page".to_string())?;

    let nav_reading = reading.clone();
    let nav_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(target))
        .title("Reading playlist")
        // A hidden window doesn't scroll or load the way a visible one does, so this one is
        // "visible" but far off-screen, with no taskbar button, title bar or focus.
        .visible(true)
        .position(-32000.0, -32000.0)
        .inner_size(1100.0, 900.0)
        .skip_taskbar(true)
        .decorations(false)
        .focused(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(script)
        .on_navigation(move |url| {
            if let Some((kind, n, body)) = parse_reply(url) {
                take_reply(&nav_reading, &kind, &body);
                let count = nav_reading.lock().unwrap().songs.len();
                let app = nav_app.clone();
                // Answered from outside the navigation callback (re-entering the webview here
                // can deadlock on Windows).
                tauri::async_runtime::spawn(async move {
                    if let Some(window) = app.get_webview_window(LABEL) {
                        let _ = window.eval(format!("window.__truongflixAck && window.__truongflixAck({n})"));
                    }
                    let _ = app.emit_to("main", "playlist-read-progress", count);
                });
                return false;
            }
            // The playlist's own site only (its pages redirect within it); nothing else loads.
            url.scheme() == "about" || (url.scheme() == "https" && url.host_str() == Some(host))
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .on_download(|_, _| false);
    // Its own browsing data, apart from the app's and the source browser's.
    #[cfg(target_os = "windows")]
    let builder = match app.path().app_cache_dir() {
        Ok(dir) => builder.data_directory(dir.join("playlist-reader")),
        Err(_) => builder,
    };
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(*b"TruongFlixPlayRd");
    let window = builder.build().map_err(|e| format!("Couldn’t open the playlist page: {e}"))?;

    let started = std::time::Instant::now();
    let outcome = loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Some(done) = reading.lock().unwrap().finished.take() {
            break done;
        }
        if started.elapsed() > LIMIT {
            break Err("Reading the playlist took too long".to_string());
        }
    };
    let _ = window.destroy();
    let songs = std::mem::take(&mut reading.lock().unwrap().songs);
    match outcome {
        Ok(()) if !songs.is_empty() => Ok(songs.into_values().map(|row| song_from(row, apple)).collect()),
        Ok(()) => Err("The playlist page didn’t show any songs".into()),
        Err(e) if songs.is_empty() => Err(e),
        // Ran out of time partway: what was read still counts.
        Err(_) => Ok(songs.into_values().map(|row| song_from(row, apple)).collect()),
    }
}

/// Manual check against real playlists: opens a real app, reads each link given (the whole
/// playlist), prints what it found and exits.
/// `cargo run --example playlist_reader_smoke --features playlist-reader-smoke -- <link> [<link>…]`
#[cfg(feature = "playlist-reader-smoke")]
pub fn smoke() {
    let links: Vec<String> = std::env::args().skip(1).collect();
    let mut context = crate::app_context();
    context.config_mut().identifier = "com.iantruong.truongflix.playlistsmoke".into();
    context.config_mut().product_name = Some("Playlist Reader Smoke".into());
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                for link in links {
                    let started = std::time::Instant::now();
                    match crate::playlists::music_playlist(handle.clone(), link.clone()).await {
                        Ok(p) => {
                            let ids = p.songs.iter().filter(|s| s.apple_id.is_some()).count();
                            println!("{} · {} · {} songs (partial: {}) in {:.0}s · {ids} with store ids", p.source, p.name, p.songs.len(), p.partial, started.elapsed().as_secs_f64());
                            for s in p.songs.iter().take(2).chain(p.songs.iter().rev().take(2)) {
                                println!("   {} — {} [{:?}] {:?}", s.title, s.artists.join(", "), s.album, s.length_ms);
                            }
                        }
                        Err(e) => println!("{link}: {e}"),
                    }
                }
                handle.exit(0);
            });
            Ok(())
        })
        .run(context)
        .expect("playlist reader smoke");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_made_up_address_is_a_reply() {
        let url: Url = "https://truongflix-reader.invalid/songs?n=3#%5B%7B%22at%22%3A1%7D%5D".parse().unwrap();
        assert_eq!(parse_reply(&url), Some(("songs".into(), 3, r#"[{"at":1}]"#.into())));
        for other in ["https://open.spotify.com/songs?n=3#x", "https://truongflix-reader.invalid.evil/songs?n=1#x", "https://truongflix-reader.invalid/songs#x"] {
            assert_eq!(parse_reply(&other.parse().unwrap()), None, "{other}");
        }
    }

    #[test]
    fn songs_arrive_in_playlist_order_and_bounded() {
        let reading = Mutex::new(Reading::default());
        take_reply(&reading, "songs", r#"[{"at":5,"id":"1","title":"Later","artists":["B"],"album":null,"lengthMs":1000,"explicit":false},{"at":2,"id":"2","title":"Earlier","artists":["A"],"album":"X","lengthMs":2000,"explicit":true},{"at":3,"title":""}]"#);
        take_reply(&reading, "songs", "not json");
        take_reply(&reading, "done", "{}");
        let mut reading = reading.into_inner().unwrap();
        assert!(matches!(reading.finished, Some(Ok(()))));
        let songs: Vec<PlaylistSong> = std::mem::take(&mut reading.songs).into_values().map(|r| song_from(r, true)).collect();
        assert_eq!(songs.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), ["Earlier", "Later"]);
        assert_eq!(songs[0].apple_id.as_deref(), Some("2"));
        assert!(songs[0].explicit);
        // Spotify ids aren't store ids.
        let spotify = song_from(Row { at: 1, id: Some("0wbDgMuAoy7O7pL3a69uZx".into()), title: "x".into(), artists: vec![], album: None, length_ms: None, explicit: false }, false);
        assert_eq!(spotify.apple_id, None);
        let failed = Mutex::new(Reading::default());
        take_reply(&failed, "error", r#"{"message":"Private"}"#);
        assert!(matches!(failed.into_inner().unwrap().finished, Some(Err(m)) if m == "Private"));
    }
}
