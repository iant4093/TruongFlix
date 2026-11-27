//! The music catalogue behind Browse → Music, all public Apple data: Apple Music's "most played"
//! charts (what people are actually streaming), and the iTunes Search API for search, artists'
//! discographies and album tracklists. Every request goes through here: chart feeds are fetched
//! freely (they're served from a CDN), search and lookups are paced so a burst of rows or fast
//! typing stays within Apple's limits, and answers are kept on disk for a while so browsing back
//! and forth costs nothing. Artist photos come from the artist's public Apple Music page.

use reqwest::{Client, Url};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::Instant;

const USER_AGENT: &str = concat!("TruongFlix/", env!("CARGO_PKG_VERSION"));
/// Largest answer accepted (a 200-result lookup is ~500 KB).
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Which service a URL belongs to, and how long its answers stay fresh.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Service {
    /// Apple Music's most-played charts.
    Charts,
    /// iTunes search and lookup.
    Store,
}

fn classify(url: &Url) -> Result<(Service, Duration), String> {
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return Err("Not a music catalogue address".into());
    }
    let path = url.path();
    let hour = Duration::from_secs(3600);
    match url.host_str() {
        // `/api/v2/<country>/music/most-played/<n>/<albums|songs>.json`: refreshed through the day.
        Some("rss.marketingtools.apple.com") if is_chart_path(path) => Ok((Service::Charts, hour * 3)),
        Some("itunes.apple.com") if path == "/search" || path == "/lookup" => Ok((Service::Store, hour * 24)),
        _ => Err("Not a music catalogue address".into()),
    }
}

fn country(code: &str) -> bool {
    code.len() == 2 && code.chars().all(|c| c.is_ascii_lowercase())
}

fn is_chart_path(path: &str) -> bool {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    matches!(parts.as_slice(), ["api", "v2", cc, "music", "most-played", n, kind]
        if country(cc) && !n.is_empty() && n.len() <= 3 && n.chars().all(|c| c.is_ascii_digit())
            && matches!(*kind, "albums.json" | "songs.json"))
}

fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

/// Search and lookups start at most every 350 ms (Apple asks for moderation, not a fixed rate).
/// Background work (matching an imported playlist's songs) has its own, slower lane, so it never
/// holds up what you're browsing.
async fn wait_turn(service: Service, background: bool) {
    if service != Service::Store {
        return;
    }
    static LAST: Mutex<Option<Instant>> = Mutex::const_new(None);
    static LAST_BACKGROUND: Mutex<Option<Instant>> = Mutex::const_new(None);
    let (lane, gap) = if background { (&LAST_BACKGROUND, Duration::from_millis(1200)) } else { (&LAST, Duration::from_millis(350)) };
    let mut last = lane.lock().await;
    if let Some(at) = *last {
        let next = at + gap;
        if next > Instant::now() {
            tokio::time::sleep_until(next).await;
        }
    }
    *last = Some(Instant::now());
}

fn cache_path(app: &AppHandle, key: &str) -> Option<PathBuf> {
    let h = key.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    Some(app.path().app_cache_dir().ok()?.join("music-catalog").join(format!("{h:016x}.json")))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A cached answer and how old it is.
fn read_cache(path: &PathBuf) -> Option<(Duration, Value)> {
    let text = std::fs::read(path).ok()?;
    let mut entry: Value = serde_json::from_slice(&text).ok()?;
    let at = entry.get("at")?.as_u64()?;
    let body = entry.get_mut("body")?.take();
    Some((Duration::from_millis(now_ms().saturating_sub(at)), body))
}

fn write_cache(path: &PathBuf, body: &Value) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let entry = serde_json::json!({ "at": now_ms(), "body": body });
    // Written whole, then put in place, so a crash never leaves half an answer cached.
    let partial = path.with_extension("part");
    if std::fs::write(&partial, entry.to_string()).is_ok() && std::fs::rename(&partial, path).is_err() {
        let _ = std::fs::remove_file(&partial);
    }
}

async fn read_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Could not read the catalogue's answer".to_string())? {
        if body.len() + chunk.len() > limit {
            return Err("The catalogue's answer was too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch(url: &Url, service: Service, background: bool) -> Result<Value, String> {
    let client = client()?;
    let mut attempt = 0;
    loop {
        wait_turn(service, background).await;
        // Chart feeds come from a CDN that now and then stalls: give up on them quickly (the
        // page shows what the other feeds had) rather than waiting.
        let timeout = if service == Service::Charts { Duration::from_secs(4) } else { Duration::from_secs(12) };
        let sent = client.get(url.clone()).header("Accept", "application/json").timeout(timeout).send().await;
        let response = match sent {
            Ok(r) => r,
            // A dropped search or lookup connection is retried once before giving up.
            Err(_) if attempt == 0 && service == Service::Store => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(600)).await;
                continue;
            }
            Err(_) => return Err("The music catalogue couldn’t be reached".into()),
        };
        let status = response.status().as_u16();
        // Too many requests: wait and try once more.
        if matches!(status, 403 | 429 | 503) && attempt == 0 {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(2000)).await;
            continue;
        }
        if status == 404 {
            return Err("Not found in the music catalogue".into());
        }
        if !(200..300).contains(&status) {
            return Err(format!("The music catalogue answered {status}"));
        }
        let body = read_body(response, MAX_BYTES).await?;
        return serde_json::from_slice(&body).map_err(|_| "The catalogue sent something unreadable".into());
    }
}

/// GETs a chart, search or lookup URL and returns its JSON. A fresh cached answer is used as is;
/// an expired one is used when the store can't be reached.
#[tauri::command]
pub async fn music_catalog(app: AppHandle, url: String, background: Option<bool>) -> Result<Value, String> {
    let parsed = Url::parse(&url).map_err(|_| "Not a music catalogue address".to_string())?;
    let (service, ttl) = classify(&parsed)?;
    let path = cache_path(&app, parsed.as_str());
    let cached = path.as_ref().and_then(read_cache);
    if let Some((age, body)) = &cached {
        if *age < ttl {
            return Ok(body.clone());
        }
    }
    match fetch(&parsed, service, background.unwrap_or(false)).await {
        Ok(body) => {
            if let Some(path) = &path {
                write_cache(path, &body);
            }
            Ok(body)
        }
        Err(e) => cached.map(|(_, body)| body).ok_or(e),
    }
}

/// The photo an Apple Music artist page shares (its `og:image`), when it's an artist photo.
fn photo_in(html: &str) -> Option<String> {
    let at = html.find("property=\"og:image\"")?;
    let tag_start = html[..at].rfind('<')?;
    let tag_end = at + html[at..].find('>')?;
    let tag = &html[tag_start..tag_end];
    let content = tag.split("content=\"").nth(1)?.split('"').next()?;
    let url = Url::parse(content).ok()?;
    let host = url.host_str()?;
    // Pages without a photo share the album art or Apple's generic artwork instead.
    let path = url.path();
    (url.scheme() == "https" && host.ends_with(".mzstatic.com") && (path.contains("ArtistImages") || path.contains("/Features"))).then(|| content.to_string())
}

/// An artist's photo from their public Apple Music page, or null when they have none. Only the
/// start of the page is read (the photo is named in its `<head>`); answers are kept for a week.
#[tauri::command]
pub async fn music_artist_photo(app: AppHandle, id: String, country: String) -> Result<Option<String>, String> {
    static SLOTS: Semaphore = Semaphore::const_new(4);
    if id.is_empty() || id.len() > 20 || !id.chars().all(|c| c.is_ascii_digit()) || !self::country(&country) {
        return Err("Invalid artist".into());
    }
    let path = cache_path(&app, &format!("artist-photo:{country}:{id}"));
    if let Some((age, body)) = path.as_ref().and_then(read_cache) {
        if age < Duration::from_secs(7 * 24 * 3600) {
            return Ok(body.as_str().map(str::to_string));
        }
    }
    let _slot = SLOTS.acquire().await.map_err(|e| e.to_string())?;
    let response = client()?
        .get(format!("https://music.apple.com/{country}/artist/{id}"))
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|_| "Apple Music couldn’t be reached".to_string())?;
    // Only real answers are remembered: a photo, or a page that has none (or no such artist).
    // A failed or refused request is retried next time instead of hiding the photo for a week.
    let status = response.status().as_u16();
    if status != 404 && !response.status().is_success() {
        return Err(format!("Apple Music answered {status}"));
    }
    let photo = if response.status().is_success() {
        let mut response = response;
        let mut head = Vec::new();
        // The tag sits near the top; stop once the head is read (the whole page is ~800 KB).
        while head.len() < 512 * 1024 {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    head.extend_from_slice(&chunk);
                    if head.windows(7).any(|w| w == b"</head>") {
                        break;
                    }
                }
                _ => break,
            }
        }
        photo_in(&String::from_utf8_lossy(&head))
    } else {
        None
    };
    if let Some(path) = &path {
        write_cache(path, &photo.clone().map(Value::String).unwrap_or(Value::Null));
    }
    Ok(photo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class(url: &str) -> Result<(Service, Duration), String> {
        classify(&Url::parse(url).unwrap())
    }

    #[test]
    fn only_the_catalogue_apis_are_reachable() {
        assert_eq!(class("https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/albums.json").unwrap().0, Service::Charts);
        assert_eq!(class("https://rss.marketingtools.apple.com/api/v2/gb/music/most-played/50/songs.json").unwrap().0, Service::Charts);
        assert_eq!(class("https://itunes.apple.com/search?term=ok+computer&entity=album").unwrap().0, Service::Store);
        assert_eq!(class("https://itunes.apple.com/lookup?id=1097861387&entity=song").unwrap().0, Service::Store);
        for bad in [
            "http://itunes.apple.com/search?term=x",
            "https://itunes.apple.com:8443/search?term=x",
            "https://user@itunes.apple.com/search?term=x",
            "https://itunes.apple.com/us/rss/topalbums/limit=10/json",
            "https://itunes.apple.com/WebObjects/MZStore.woa",
            "https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/playlists.json",
            "https://rss.marketingtools.apple.com/api/v2/USA/music/most-played/100/albums.json",
            "https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/100/apps.json",
            "https://itunes.apple.com.evil.example/search?term=x",
            "https://musicbrainz.org/ws/2/release/abc",
            "file:///etc/passwd",
        ] {
            assert!(class(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn charts_refresh_sooner_than_lookups() {
        let chart = class("https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/albums.json").unwrap().1;
        let lookup = class("https://itunes.apple.com/lookup?id=1").unwrap().1;
        assert!(chart < lookup);
    }

    #[test]
    fn artist_photos_come_from_the_page_head() {
        let page = r#"<head><meta property="og:title" content="Radiohead"><meta property="og:image" content="https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages211/v4/8a/x.png/1200x630cw.png"></head>"#;
        assert_eq!(photo_in(page).as_deref(), Some("https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages211/v4/8a/x.png/1200x630cw.png"));
        // Album art or a generic image isn't an artist photo; nor is a link elsewhere.
        assert_eq!(photo_in(r#"<meta property="og:image" content="https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/a.jpg/1200x630bf.jpg">"#), None);
        assert_eq!(photo_in(r#"<meta property="og:image" content="https://evil.example/ArtistImages/a.png">"#), None);
        assert_eq!(photo_in("<head></head>"), None);
    }
}
