//! The music catalogue behind Browse → Music: the iTunes Store's public top-album charts (what's
//! popular and new), MusicBrainz (search, artists, discographies and exact tracklists) and
//! ListenBrainz (an artist's most played albums). MusicBrainz and ListenBrainz ask every
//! application for at most one request per second and a meaningful User-Agent (which a webview
//! can't set), so every request goes through here: one queue per service, and answers kept on
//! disk for a while so browsing back and forth costs nothing.

use reqwest::{Client, Url};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tokio::time::Instant;

const USER_AGENT: &str = concat!("TruongFlix/", env!("CARGO_PKG_VERSION"), " ( https://github.com/iant4093/TruongFlix )");
/// Largest answer accepted (a 100-album chart is ~300 KB).
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Which service a URL belongs to, how long its answers stay fresh, and the queue it waits in.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Service {
    MusicBrainz,
    ListenBrainz,
    Charts,
}

fn classify(url: &Url) -> Result<(Service, Duration), String> {
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return Err("Not a music catalogue address".into());
    }
    let path = url.path();
    let hour = Duration::from_secs(3600);
    match url.host_str() {
        Some("musicbrainz.org") if path.starts_with("/ws/2/") => {
            // Searches change as people edit the database; a release's tracklist barely does.
            let search = url.query_pairs().any(|(k, _)| k == "query");
            Ok((Service::MusicBrainz, if search { hour * 24 } else { hour * 24 * 7 }))
        }
        Some("api.listenbrainz.org") if path.starts_with("/1/") => Ok((Service::ListenBrainz, hour * 24)),
        // `/<country>/rss/topalbums/limit=N[/genre=G]/json`: the charts move through the day.
        Some("itunes.apple.com") if is_chart_path(path) => Ok((Service::Charts, hour * 3)),
        _ => Err("Not a music catalogue address".into()),
    }
}

fn is_chart_path(path: &str) -> bool {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    matches!(parts.as_slice(), [country, "rss", "topalbums", rest @ .., "json"]
        if country.len() == 2 && country.chars().all(|c| c.is_ascii_lowercase())
            && rest.iter().all(|p| p.strip_prefix("limit=").or_else(|| p.strip_prefix("genre=")).is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))))
}

fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

/// One request per second per service: each waits for the previous one's slot.
async fn wait_turn(service: Service) {
    static MB: Mutex<Option<Instant>> = Mutex::const_new(None);
    static LB: Mutex<Option<Instant>> = Mutex::const_new(None);
    static CHARTS: Mutex<Option<Instant>> = Mutex::const_new(None);
    let gate = match service {
        Service::MusicBrainz => &MB,
        Service::ListenBrainz => &LB,
        Service::Charts => &CHARTS,
    };
    let mut last = gate.lock().await;
    if let Some(at) = *last {
        let next = at + Duration::from_millis(1100);
        if next > Instant::now() {
            tokio::time::sleep_until(next).await;
        }
    }
    *last = Some(Instant::now());
}

fn cache_path(app: &AppHandle, url: &str) -> Option<PathBuf> {
    let h = url.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
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

async fn fetch(url: &Url, service: Service) -> Result<Value, String> {
    let client = client()?;
    let mut attempt = 0;
    loop {
        wait_turn(service).await;
        let response = client
            .get(url.clone())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| "The music catalogue couldn’t be reached".to_string())?;
        let status = response.status();
        // Over the limit (503 at MusicBrainz, 429 at ListenBrainz): wait and try once more.
        if (status.as_u16() == 503 || status.as_u16() == 429) && attempt == 0 {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(2500)).await;
            continue;
        }
        // ListenBrainz answers 204 while a chart is being recalculated.
        if status.as_u16() == 204 {
            return Ok(Value::Null);
        }
        if status.as_u16() == 404 {
            return Err("Not found in the music catalogue".into());
        }
        if !status.is_success() {
            return Err(format!("The music catalogue answered {}", status.as_u16()));
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Could not read the catalogue's answer".to_string())? {
            if body.len() + chunk.len() > MAX_BYTES {
                return Err("The catalogue's answer was too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        return serde_json::from_slice(&body).map_err(|_| "The catalogue sent something unreadable".into());
    }
}

/// GETs a chart, MusicBrainz or ListenBrainz URL and returns its JSON. A fresh cached answer is
/// used as is; an expired one is used when the service can't be reached.
#[tauri::command]
pub async fn music_catalog(app: AppHandle, url: String) -> Result<Value, String> {
    let parsed = Url::parse(&url).map_err(|_| "Not a music catalogue address".to_string())?;
    let (service, ttl) = classify(&parsed)?;
    let path = cache_path(&app, parsed.as_str());
    let cached = path.as_ref().and_then(read_cache);
    if let Some((age, body)) = &cached {
        if *age < ttl {
            return Ok(body.clone());
        }
    }
    match fetch(&parsed, service).await {
        Ok(body) => {
            // An empty chart (still being calculated) isn't kept: the next visit asks again.
            if let (Some(path), false) = (&path, body.is_null()) {
                write_cache(path, &body);
            }
            Ok(body)
        }
        Err(e) => cached.map(|(_, body)| body).ok_or(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class(url: &str) -> Result<(Service, Duration), String> {
        classify(&Url::parse(url).unwrap())
    }

    #[test]
    fn only_the_catalogue_apis_are_reachable() {
        assert_eq!(class("https://musicbrainz.org/ws/2/release/abc?inc=recordings&fmt=json").unwrap().0, Service::MusicBrainz);
        assert_eq!(class("https://api.listenbrainz.org/1/stats/sitewide/release-groups?range=week").unwrap().0, Service::ListenBrainz);
        for bad in [
            "http://musicbrainz.org/ws/2/release/abc",
            "https://musicbrainz.org/login",
            "https://musicbrainz.org:8443/ws/2/release/abc",
            "https://user@musicbrainz.org/ws/2/release/abc",
            "https://evil.example/ws/2/release",
            "https://listenbrainz.org/1/stats",
            "https://api.listenbrainz.org.evil.example/1/stats",
            "file:///etc/passwd",
        ] {
            assert!(class(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_chart_feeds_are_reachable_at_itunes() {
        assert_eq!(class("https://itunes.apple.com/us/rss/topalbums/limit=100/json").unwrap().0, Service::Charts);
        assert_eq!(class("https://itunes.apple.com/gb/rss/topalbums/limit=100/genre=21/json").unwrap().0, Service::Charts);
        for bad in [
            "https://itunes.apple.com/search?term=x",
            "https://itunes.apple.com/us/rss/topalbums/limit=100/xml",
            "https://itunes.apple.com/USA/rss/topalbums/limit=10/json",
            "https://itunes.apple.com/us/rss/topalbums/limit=10/genre=../json",
            "https://itunes.apple.com/us/lookup?id=1",
        ] {
            assert!(class(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn searches_expire_sooner_than_lookups() {
        let search = class("https://musicbrainz.org/ws/2/release-group?query=ok%20computer&fmt=json").unwrap().1;
        let lookup = class("https://musicbrainz.org/ws/2/release/abc?fmt=json").unwrap().1;
        let chart = class("https://itunes.apple.com/us/rss/topalbums/limit=100/json").unwrap().1;
        assert!(search < lookup && chart < search);
    }
}
