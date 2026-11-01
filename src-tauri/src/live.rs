//! Bounded IPTV import, sports metadata and independent stream checks. Never touches the player.
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::{watch, Semaphore};

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transport {
    pub url: String,
    #[serde(default)]
    pub referrer: String,
    #[serde(default)]
    pub user_agent: String,
}

impl Transport {
    pub fn validate(&self) -> Result<Url, String> {
        let url = http_url(&self.url)?;
        for value in [&self.referrer, &self.user_agent] {
            if value.len() > 4096 || value.contains(['\r', '\n', '\0']) {
                return Err("Invalid stream headers".into());
            }
        }
        Ok(url)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    id: String,
    tvg_id: String,
    name: String,
    logo: String,
    group: String,
    transport: Transport,
}

fn http_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid HTTP or HTTPS URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS streams are supported".into());
    }
    Ok(url)
}

fn hash(value: &str) -> String {
    let h = value.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    });
    format!("{h:016x}")
}

fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .user_agent("TruongFlix/LiveTV")
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| "Could not create the network client".to_string())?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

async fn bytes(mut response: Response, limit: usize, partial: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the response")?
    {
        let take = chunk.len().min(limit.saturating_sub(out.len()));
        out.extend_from_slice(&chunk[..take]);
        if out.len() >= limit {
            if partial {
                break;
            }
            return Err("This source exceeds the import size limit".into());
        }
    }
    Ok(out)
}

// Attribute values may contain commas (notably User-Agent), and commas delimit the display name.
fn extinf(line: &str) -> (HashMap<String, String>, String) {
    let mut quoted = false;
    let split = line
        .char_indices()
        .find_map(|(i, c)| {
            if c == '"' {
                quoted = !quoted;
            }
            (c == ',' && !quoted).then_some(i)
        })
        .unwrap_or(line.len());
    let mut attrs = HashMap::new();
    let mut rest = &line[..split];
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq]
            .split_whitespace()
            .last()
            .unwrap_or("")
            .to_ascii_lowercase();
        rest = rest[eq + 1..].trim_start();
        let value;
        if let Some(s) = rest.strip_prefix('"') {
            let end = s.find('"').unwrap_or(s.len());
            value = &s[..end];
            rest = s.get(end + 1..).unwrap_or("");
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            value = &rest[..end];
            rest = &rest[end..];
        }
        attrs.insert(key, value.to_owned());
    }
    (attrs, line.get(split + 1..).unwrap_or("").trim().to_owned())
}

fn parse_playlist(text: &str, base: Option<&Url>) -> Result<Vec<Channel>, String> {
    if text.lines().any(|l| l.trim_start().starts_with("#EXT-X-")) {
        let url = base.ok_or("Paste a channel playlist, or enter the URL of this HLS stream")?;
        return Ok(vec![Channel {
            id: hash(url.as_str()),
            tvg_id: String::new(),
            name: url.host_str().unwrap_or("Live stream").into(),
            logo: String::new(),
            group: "Live".into(),
            transport: Transport {
                url: url.to_string(),
                ..Default::default()
            },
        }]);
    }
    let mut channels = Vec::new();
    let mut attrs = HashMap::<String, String>::new();
    let mut name = String::new();
    for line in text.trim_start_matches('\u{feff}').lines().map(str::trim) {
        if line.starts_with("#EXTINF:") {
            (attrs, name) = extinf(line);
        } else if let Some(option) = line.strip_prefix("#EXTVLCOPT:") {
            if let Some((key, value)) = option.split_once('=') {
                if matches!(key, "http-referrer" | "http-user-agent") {
                    attrs.insert(key.into(), value.into());
                }
            }
        } else if let Some(json) = line.strip_prefix("#EXTHTTP:") {
            if let Ok(serde_json::Value::Object(headers)) =
                serde_json::from_str::<serde_json::Value>(json)
            {
                for (name, value) in headers {
                    let key = match name.to_ascii_lowercase().as_str() {
                        "referer" | "referrer" => "http-referrer",
                        "user-agent" => "http-user-agent",
                        _ => continue,
                    };
                    if let Some(value) = value.as_str() {
                        attrs.insert(key.into(), value.into());
                    }
                }
            }
        } else if !line.is_empty() && !line.starts_with('#') {
            let raw = line.split('|').next().unwrap_or(line);
            if let Some((_, headers)) = line.split_once('|') {
                if let Ok(header_url) = Url::parse(&format!("https://headers.invalid/?{headers}")) {
                    for (key, value) in header_url.query_pairs() {
                        let name = match key.to_ascii_lowercase().as_str() {
                            "referer" | "referrer" => "http-referrer",
                            "user-agent" => "http-user-agent",
                            _ => continue,
                        };
                        attrs.insert(name.into(), value.into_owned());
                    }
                }
            }
            let url =
                Url::parse(raw).or_else(|error| base.map(|b| b.join(raw)).unwrap_or(Err(error)));
            let Ok(url) = url else {
                attrs.clear();
                name.clear();
                continue;
            };
            if !matches!(url.scheme(), "http" | "https") {
                attrs.clear();
                name.clear();
                continue;
            }
            let transport = Transport {
                url: url.to_string(),
                referrer: attrs.remove("http-referrer").unwrap_or_default(),
                user_agent: attrs.remove("http-user-agent").unwrap_or_default(),
            };
            transport.validate()?;
            let label = if name.is_empty() {
                attrs
                    .remove("tvg-name")
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| url.host_str().unwrap_or("Live stream").to_owned())
            } else {
                name.clone()
            };
            channels.push(Channel {
                id: String::new(),
                tvg_id: attrs.remove("tvg-id").unwrap_or_default(),
                name: label,
                logo: attrs
                    .remove("tvg-logo")
                    .filter(|u| http_url(u).is_ok())
                    .unwrap_or_default(),
                group: attrs
                    .remove("group-title")
                    .unwrap_or_else(|| "Other".into()),
                transport,
            });
            attrs.clear();
            name.clear();
            if channels.len() > 20_000 {
                return Err("A playlist can contain at most 20,000 streams".into());
            }
        }
    }
    if channels.is_empty() {
        return Err("No HTTP or HTTPS channels were found in this playlist".into());
    }
    let mut counts = HashMap::new();
    for c in &channels {
        *counts
            .entry(if c.tvg_id.is_empty() {
                c.name.clone()
            } else {
                c.tvg_id.clone()
            })
            .or_insert(0) += 1;
    }
    for c in &mut channels {
        let key = if c.tvg_id.is_empty() {
            &c.name
        } else {
            &c.tvg_id
        };
        let mut endpoint = Url::parse(&c.transport.url).unwrap();
        let mut identity_query: Vec<_> = endpoint
            .query_pairs()
            .filter(|(key, _)| {
                !matches!(
                    key.to_ascii_lowercase().as_str(),
                    "token"
                        | "expires"
                        | "signature"
                        | "auth"
                        | "password"
                        | "username"
                        | "key"
                        | "api_key"
                )
            })
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        identity_query.sort();
        endpoint.set_query(None);
        if !identity_query.is_empty() {
            endpoint.query_pairs_mut().extend_pairs(identity_query);
        }
        endpoint.set_fragment(None);
        let duplicate_key = format!("{}|{}", c.name, endpoint.as_str());
        c.id = hash(&format!(
            "{key}|{}",
            if counts.get(key).copied().unwrap_or(0) > 1 {
                duplicate_key.as_str()
            } else {
                ""
            }
        ));
    }
    let mut seen = std::collections::HashSet::new();
    channels.retain(|channel| seen.insert(channel.id.clone()));
    Ok(channels)
}

#[tauri::command]
pub async fn live_import(input: String) -> Result<Vec<Channel>, String> {
    if input.len() > 8 * 1024 * 1024 {
        return Err("Playlist text must be smaller than 8 MB".into());
    }
    let input = input.trim();
    if input.starts_with('#') || input.starts_with('\u{feff}') {
        return parse_playlist(input, None);
    }
    let url = http_url(input)?;
    let response = client()?
        .get(url.clone())
        .send()
        .await
        .map_err(|_| "Could not download this source. Check your connection and source URL.")?;
    if !response.status().is_success() {
        return Err(format!(
            "Source returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let final_url = response.url().clone();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if content_type.starts_with("video/") || content_type.contains("dash+xml") {
        return Ok(vec![Channel {
            id: hash(url.as_str()),
            tvg_id: String::new(),
            name: url.host_str().unwrap_or("Live stream").into(),
            logo: String::new(),
            group: "Live".into(),
            transport: Transport {
                url: url.to_string(),
                ..Default::default()
            },
        }]);
    }
    let body = bytes(response, 8 * 1024 * 1024, false).await?;
    let text = String::from_utf8(body).map_err(|_| "Playlist must use UTF-8 text")?;
    if !text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("#EXTM3U")
    {
        return Err("This URL did not return an M3U playlist or supported stream".into());
    }
    parse_playlist(&text, Some(&final_url))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    state: &'static str,
    reason: String,
    retry_after: u64,
}
fn result(state: &'static str, reason: &str) -> Check {
    Check {
        state,
        reason: reason.into(),
        retry_after: 0,
    }
}
struct Checks {
    generation: watch::Sender<u64>,
    slots: Semaphore,
    hosts: Mutex<HashMap<String, Arc<Semaphore>>>,
    cooldowns: Mutex<HashMap<String, Instant>>,
}
fn checks() -> &'static Checks {
    static CHECKS: OnceLock<Checks> = OnceLock::new();
    CHECKS.get_or_init(|| Checks {
        generation: watch::channel(0).0,
        slots: Semaphore::new(4),
        hosts: Mutex::new(HashMap::new()),
        cooldowns: Mutex::new(HashMap::new()),
    })
}
#[tauri::command]
pub fn live_check_begin() -> u64 {
    let mut next = 0;
    checks().generation.send_modify(|g| {
        *g += 1;
        next = *g;
    });
    next
}

async fn get(client: &Client, url: &Url, transport: &Transport) -> Result<Response, Check> {
    let mut request = client.get(url.clone());
    if !transport.referrer.is_empty() {
        request = request.header("Referer", &transport.referrer);
    }
    if !transport.user_agent.is_empty() {
        request = request.header("User-Agent", &transport.user_agent);
    }
    let response = request
        .send()
        .await
        .map_err(|_| result("unknown", "Connection failed or timed out"))?;
    let status = response.status().as_u16();
    if status == 429 {
        let seconds = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.parse::<u64>().ok().or_else(|| {
                    httpdate::parse_http_date(v).ok().map(|date| {
                        date.duration_since(std::time::SystemTime::now())
                            .unwrap_or_default()
                            .as_secs()
                    })
                })
            })
            .unwrap_or(300)
            .clamp(1, 86_400);
        return Err(Check {
            state: "rate_limited",
            reason: "Provider asked us to slow down".into(),
            retry_after: seconds,
        });
    }
    if !response.status().is_success() {
        return Err(result(
            "failed",
            &format!(
                "HTTP {status}{}",
                if status == 401 || status == 403 {
                    " — access denied"
                } else {
                    ""
                }
            ),
        ));
    }
    Ok(response)
}

fn media_bytes(data: &[u8]) -> bool {
    (data.len() >= 564 && [0, 188, 376].iter().all(|i| data[*i] == 0x47))
        || data.starts_with(b"FLV")
        || data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        || data
            .windows(4)
            .take(256)
            .any(|s| matches!(s, b"ftyp" | b"styp" | b"moof" | b"moov"))
}

async fn probe(transport: &Transport) -> Result<Check, Check> {
    let mut url = transport.validate().map_err(|e| result("failed", &e))?;
    let client = client().map_err(|e| result("unknown", &e))?;
    for _ in 0..3 {
        let response = get(&client, &url, transport).await?;
        let base = response.url().clone();
        let body = bytes(response, 128 * 1024, true)
            .await
            .map_err(|e| result("unknown", &e))?;
        if media_bytes(&body) {
            return Ok(result("reachable", "Media responded"));
        }
        let text = String::from_utf8_lossy(&body);
        let lower = text.trim_start().to_ascii_lowercase();
        if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
            return Err(result(
                "failed",
                "Server returned a web page instead of video",
            ));
        }
        if !text.trim_start().starts_with("#EXTM3U") {
            return Err(result("unknown", "Could not verify this stream format"));
        }
        let lines: Vec<_> = text.lines().map(str::trim).collect();
        if lines
            .iter()
            .any(|l| l.starts_with("#EXT-X-KEY:") && !l.contains("METHOD=NONE"))
        {
            return Err(result("unknown", "Encrypted stream — verify by playing"));
        }
        let master = lines.iter().any(|l| l.starts_with("#EXT-X-STREAM-INF:"));
        let targets: Vec<_> = lines
            .iter()
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect();
        let target = if master {
            targets.first()
        } else {
            targets.iter().rev().nth(1).or_else(|| targets.last())
        };
        let Some(target) = target else {
            return Err(result("failed", "Stream currently has no media"));
        };
        url = base
            .join(target)
            .map_err(|_| result("failed", "Invalid media URL"))?;
        http_url(url.as_str()).map_err(|e| result("failed", &e))?;
    }
    Err(result("unknown", "Play this channel to verify it"))
}

#[tauri::command]
pub async fn live_check(transport: Transport, generation: u64) -> Check {
    let state = checks();
    let mut cancel = state.generation.subscribe();
    if *cancel.borrow() != generation {
        return result("cancelled", "");
    }
    let host = match transport.validate() {
        Ok(u) => u.host_str().unwrap_or("").to_owned(),
        Err(e) => return result("failed", &e),
    };
    let host_slot = state
        .hosts
        .lock()
        .unwrap()
        .entry(host.clone())
        .or_insert_with(|| Arc::new(Semaphore::new(1)))
        .clone();
    tokio::select! {
        _ = cancel.changed() => result("cancelled", ""),
        check = async {
            let _host = host_slot.acquire().await.unwrap(); let _slot = state.slots.acquire().await.unwrap();
            if let Some(until) = state.cooldowns.lock().unwrap().get(&host) {
                if *until > Instant::now() { return Check { state: "rate_limited", reason: "Provider asked us to slow down".into(), retry_after: until.saturating_duration_since(Instant::now()).as_secs().max(1) }; }
            }
            let check = match tokio::time::timeout(Duration::from_secs(12), probe(&transport)).await {
                Ok(Ok(c) | Err(c)) => c,
                Err(_) => result("unknown", "Connection timed out"),
            };
            if check.state == "rate_limited" { state.cooldowns.lock().unwrap().insert(host, Instant::now() + Duration::from_secs(check.retry_after.min(86_400))); }
            check
        } => check,
    }
}

const LEAGUES: &[(&str, &str)] = &[
    ("football/nfl", "NFL"),
    ("football/college-football", "College football"),
    ("basketball/nba", "NBA"),
    ("basketball/wnba", "WNBA"),
    ("basketball/mens-college-basketball", "College basketball"),
    ("baseball/mlb", "MLB"),
    ("hockey/nhl", "NHL"),
    ("soccer/usa.1", "MLS"),
    ("soccer/eng.1", "Premier League"),
    ("soccer/uefa.champions", "Champions League"),
];

#[tauri::command]
pub async fn live_sports(league: String, date: String) -> Result<serde_json::Value, String> {
    if !LEAGUES.iter().any(|(path, _)| *path == league)
        || date.len() != 8
        || !date.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("Invalid league or date".into());
    }
    let url = format!(
        "https://site.api.espn.com/apis/site/v2/sports/{league}/scoreboard?dates={date}&limit=200"
    );
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|_| "Sports schedules are temporarily unavailable")?;
    if !response.status().is_success() {
        return Err(format!(
            "Sports schedules returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let data = bytes(response, 8 * 1024 * 1024, false).await?;
    serde_json::from_slice(&data).map_err(|_| "Invalid sports schedule response".into())
}

#[tauri::command]
pub async fn live_artwork(app: tauri::AppHandle, url: String) -> Result<String, String> {
    static SLOTS: Semaphore = Semaphore::const_new(6);
    static WRITES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    http_url(&url)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "No cache directory")?
        .join("live-artwork");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "Could not create artwork cache")?;
    let path = dir.join(format!("{}.img", hash(&url)));
    if path.is_file() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let _slot = SLOTS.acquire().await.map_err(|_| "Artwork unavailable")?;
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|_| "Artwork unavailable")?;
    if !response.status().is_success() {
        return Err("Artwork unavailable".into());
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !matches!(
        content_type.split(';').next().unwrap_or(""),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err("Unsupported artwork format".into());
    }
    let body = bytes(response, 512 * 1024, false).await?;
    tokio::fs::write(&path, body)
        .await
        .map_err(|_| "Could not cache artwork")?;
    if WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 32 == 0 {
        tokio::task::spawn_blocking(move || {
            let mut files: Vec<_> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| {
                    let meta = entry.metadata().ok()?;
                    meta.is_file()
                        .then_some((entry.path(), meta.len(), meta.modified().ok()))
                })
                .collect();
            files.sort_by_key(|(_, _, modified)| *modified);
            let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
            for (path, size, _) in files {
                if total <= 32 * 1024 * 1024 {
                    break;
                }
                if std::fs::remove_file(path).is_ok() {
                    total = total.saturating_sub(size);
                }
            }
        });
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn import_preserves_quoted_commas_directives_unicode_and_relative_urls() {
        let text = "\u{feff}#EXTM3U\r\n#EXTINF:-1 tvg-id=\"ESPN.us@HD\" http-user-agent=\"Agent (test, comma)\" tvg-logo=\"https://example.org/logo.png\" group-title=\"Sports;General\",ESPN 高清\r\n#EXTVLCOPT:http-referrer=https://example.org/\r\nlive/index.m3u8?token=secret\r\n";
        let channels = parse_playlist(
            text,
            Some(&Url::parse("https://example.org/lineup/us.m3u").unwrap()),
        )
        .unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].name, "ESPN 高清");
        assert_eq!(channels[0].transport.user_agent, "Agent (test, comma)");
        assert_eq!(channels[0].transport.referrer, "https://example.org/");
        assert_eq!(
            channels[0].transport.url,
            "https://example.org/lineup/live/index.m3u8?token=secret"
        );
        assert_eq!(channels[0].group, "Sports;General");
    }

    #[test]
    fn stream_identity_survives_refresh_but_preserves_feed_variants() {
        let one = |url: &str| {
            parse_playlist(
                &format!("#EXTM3U\n#EXTINF:-1 tvg-id=\"Fox.us@KTVU\",Fox\n{url}\n"),
                None,
            )
            .unwrap()
        };
        assert_eq!(
            one("https://a.example/a?token=1")[0].id,
            one("https://b.example/b?token=2")[0].id
        );
        let rows = parse_playlist("#EXTM3U\n#EXTINF:-1 tvg-id=\"ESPN.us@HD\",ESPN\nhttps://a.example/a\n#EXTINF:-1 tvg-id=\"ESPN.us@HD\",ESPN\nhttps://b.example/b\n", None).unwrap();
        assert_eq!(rows.len(), 2);
        assert_ne!(rows[0].id, rows[1].id);
        let query_variants = "#EXTM3U\n#EXTINF:-1 tvg-id=\"Same.us\",Same\nhttps://example.org/play?id=1&token=old\n#EXTINF:-1 tvg-id=\"Same.us\",Same\nhttps://example.org/play?id=2&token=old\n";
        let old = parse_playlist(query_variants, None).unwrap();
        let new = parse_playlist(&query_variants.replace("token=old", "token=new"), None).unwrap();
        assert_eq!(old.len(), 2);
        assert_ne!(old[0].id, old[1].id);
        assert_eq!(old[0].id, new[0].id);
    }

    #[test]
    fn unsupported_protocols_and_injected_headers_are_rejected() {
        assert!(parse_playlist("#EXTM3U\n#EXTINF:-1,Unsafe\nfile:///etc/passwd", None).is_err());
        assert!(Transport {
            url: "https://example.org/".into(),
            referrer: "ok\r\nAuthorization: secret".into(),
            user_agent: String::new()
        }
        .validate()
        .is_err());
        assert!(http_url("javascript:alert(1)").is_err());
        assert!(http_url("rtsp://example.org/live").is_err());
        assert!(parse_playlist("#EXTM3U\n#EXTINF:-1,Unsafe\nhttps://example.org/live|User-Agent=Agent%0D%0AInjected", None).is_err());
    }

    #[test]
    fn alternate_header_conventions_are_scoped_to_one_channel() {
        let text = "#EXTM3U\n#EXTINF:-1 tvg-name=\"Fallback name\",\n#EXTHTTP:{\"User-Agent\":\"First\",\"Referer\":\"https://example.org/\"}\nhttps://example.org/live|User-Agent=Override%20Agent\n#EXTINF:-1,Next\nhttps://example.org/next\n";
        let channels = parse_playlist(text, None).unwrap();
        assert_eq!(channels[0].name, "Fallback name");
        assert_eq!(channels[0].transport.user_agent, "Override Agent");
        assert_eq!(channels[0].transport.referrer, "https://example.org/");
        assert!(channels[1].transport.user_agent.is_empty());
        assert!(channels[1].transport.referrer.is_empty());
    }

    #[test]
    fn hls_manifests_are_one_stream_not_a_channel_list() {
        let hls = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n";
        assert!(parse_playlist(hls, None).is_err());
        let url = Url::parse("https://example.org/live.m3u8").unwrap();
        let rows = parse_playlist(hls, Some(&url)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].transport.url, url.as_str());
    }

    async fn server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut connection, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut data = [0; 8192];
                    let n = connection.read(&mut data).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&data[..n]);
                    let path = request.split_whitespace().nth(1).unwrap_or("");
                    let (status, content, extra) = match path {
                        "/master.m3u8" => (200, b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n".to_vec(), ""),
                        "/media.m3u8" => (200, b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXTINF:6,\nsegment.ts\n".to_vec(), ""),
                        "/broken.m3u8" => (200, b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nmissing.ts\n".to_vec(), ""),
                        "/encrypted.m3u8" => (200, b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:6,\nsegment.ts\n".to_vec(), ""),
                        "/segment.ts" => (200, vec![0x47; 564], ""),
                        "/limited" => (429, b"Slow down".to_vec(), "Retry-After: 600\r\n"),
                        "/login" => (200, b"<html>Sign in</html>".to_vec(), ""),
                        "/protected" if request.to_lowercase().contains("referer: https://example.org/") && request.contains("TestAgent") => (200, vec![0x47; 564], ""),
                        "/slow" => { tokio::time::sleep(Duration::from_secs(3)).await; (200, vec![0x47; 564], "") },
                        _ => (404, b"Missing".to_vec(), ""),
                    };
                    let header = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", content.len());
                    let _ = connection.write_all(header.as_bytes()).await;
                    let _ = connection.write_all(&content).await;
                });
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn probes_media_not_just_playlist_or_http_success() {
        let base = server().await;
        let source = |path: &str| Transport {
            url: format!("{base}{path}"),
            ..Default::default()
        };
        assert_eq!(
            probe(&source("/master.m3u8")).await.unwrap().state,
            "reachable"
        );
        assert_eq!(
            probe(&source("/broken.m3u8")).await.unwrap_err().state,
            "failed"
        );
        assert_eq!(probe(&source("/login")).await.unwrap_err().state, "failed");
        assert_eq!(
            probe(&source("/encrypted.m3u8")).await.unwrap_err().state,
            "unknown"
        );
        let rate = probe(&source("/limited")).await.unwrap_err();
        assert_eq!(rate.state, "rate_limited");
        assert_eq!(rate.retry_after, 600);
        assert_eq!(
            probe(&Transport {
                url: format!("{base}/protected"),
                referrer: "https://example.org/".into(),
                user_agent: "TestAgent".into()
            })
            .await
            .unwrap()
            .state,
            "reachable"
        );
    }

    #[tokio::test]
    async fn playlist_switch_cancels_in_flight_checks() {
        let base = server().await;
        let generation = live_check_begin();
        let task = tokio::spawn(live_check(
            Transport {
                url: format!("{base}/slow"),
                ..Default::default()
            },
            generation,
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        live_check_begin();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(500), task)
                .await
                .unwrap()
                .unwrap()
                .state,
            "cancelled"
        );
    }
}
