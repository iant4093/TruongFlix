//! Resolves public trailer video/audio streams and relays only those URLs over loopback.
//! The banner uses plain HTML media elements: no third-party player UI or caption modules.

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{OnceCell, Semaphore},
};

const MAX_MEDIA: u64 = 256 * 1024 * 1024;
const FORMAT: &str = "bv[ext=mp4][vcodec^=avc1][height<=1080][protocol=https]+ba[ext=m4a][protocol=https]/b[ext=mp4][height<=1080][protocol=https]";
static PORT: OnceCell<u16> = OnceCell::const_new();
static CACHE: Mutex<Vec<Cached>> = Mutex::new(Vec::new());
static RESOLVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CLIENT: OnceLock<Client> = OnceLock::new();
static REQUESTS: Semaphore = Semaphore::const_new(12);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailerSource {
    video_url: String,
    audio_url: Option<String>,
    width: u64,
    height: u64,
}
#[derive(Clone)]
struct Track {
    url: String,
    mime: &'static str,
    user_agent: String,
    referrer: String,
}
struct Cached {
    key: String,
    token: String,
    source: TrailerSource,
    video: Track,
    audio: Option<Track>,
    expires: Instant,
}

fn valid_key(key: &str) -> bool {
    key.len() == 11
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn allowed_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none_or(|p| p == 443)
            && u.host_str()
                .is_some_and(|h| h.ends_with(".googlevideo.com"))
    })
}
fn client() -> Result<Client, String> {
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() >= 4 || !allowed_url(a.url().as_str()) {
                a.stop()
            } else {
                a.follow()
            }
        }))
        .build()
        .map_err(|_| "Could not create trailer relay")?;
    let _ = CLIENT.set(c.clone());
    Ok(c)
}
fn helper(name: &str) -> Result<PathBuf, String> {
    let executable = format!("{name}{}", if cfg!(windows) { ".exe" } else { "" });
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    {
        let path = dir.join(&executable);
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(debug_assertions)]
    {
        let target = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "aarch64-apple-darwin"
        } else if cfg!(target_os = "macos") {
            "x86_64-apple-darwin"
        } else {
            "x86_64-pc-windows-msvc"
        };
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(format!(
                "{name}-{target}{}",
                if cfg!(windows) { ".exe" } else { "" }
            ));
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("The trailer helpers are missing. Reinstall TruongFlix to restore them.".into())
}
fn track(value: &Value, mime: &'static str) -> Result<Track, String> {
    let url = value["url"]
        .as_str()
        .filter(|u| allowed_url(u))
        .ok_or("No supported trailer stream was available")?;
    let header = |name: &str| {
        value["http_headers"][name]
            .as_str()
            .filter(|s| s.len() <= 1024 && !s.chars().any(char::is_control))
            .unwrap_or("")
            .to_string()
    };
    Ok(Track {
        url: url.into(),
        mime,
        user_agent: header("User-Agent"),
        referrer: header("Referer"),
    })
}
fn parse_source(data: &[u8]) -> Result<(Track, Option<Track>, u64, u64), String> {
    if data.len() > 8 * 1024 * 1024 {
        return Err("Trailer metadata exceeded its size limit".into());
    }
    let info: Value = serde_json::from_slice(data).map_err(|_| "Invalid trailer metadata")?;
    if info["is_live"].as_bool() == Some(true)
        || info["duration"]
            .as_f64()
            .is_none_or(|d| !(1.0..=900.0).contains(&d))
    {
        return Err("This source is not a short trailer".into());
    }
    let formats = info["requested_formats"].as_array();
    let video = formats
        .and_then(|f| {
            f.iter()
                .find(|v| v["vcodec"].as_str().is_some_and(|c| c.starts_with("avc1")))
        })
        .unwrap_or(&info);
    if !video["vcodec"]
        .as_str()
        .is_some_and(|c| c.starts_with("avc1"))
        || video["ext"] != "mp4"
    {
        return Err("No compatible HD trailer video was available".into());
    }
    let width = video["width"].as_u64().unwrap_or(0);
    let height = video["height"].as_u64().unwrap_or(0);
    if width == 0 || height == 0 || height > 1080 {
        return Err("Invalid trailer dimensions".into());
    }
    let audio = formats
        .and_then(|f| {
            f.iter()
                .find(|v| v["vcodec"] == "none" && v["ext"] == "m4a")
        })
        .map(|v| track(v, "audio/mp4"))
        .transpose()?;
    if audio.is_none() && video["acodec"].as_str().is_none_or(|c| c == "none") {
        return Err("No trailer audio was available".into());
    }
    Ok((track(video, "video/mp4")?, audio, width, height))
}
async fn extract(key: &str) -> Result<(Track, Option<Track>, u64, u64), String> {
    let mut command = Command::new(helper("yt-dlp")?);
    command.kill_on_drop(true).args([
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--no-cache-dir",
        "--socket-timeout",
        "10",
        "--retries",
        "1",
        "--extractor-retries",
        "1",
        "--skip-download",
        "--check-formats",
        "--dump-single-json",
        "--no-js-runtimes",
        "--js-runtimes",
        &format!("deno:{}", helper("deno")?.display()),
        "--extractor-args",
        "youtube-ejs:jitless=true",
        "--format",
        FORMAT,
        &format!("https://www.youtube.com/watch?v={key}"),
    ]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(35), command.output())
        .await
        .map_err(|_| "The trailer provider took too long to respond")?
        .map_err(|_| "Could not start the trailer resolver")?;
    if !output.status.success() {
        return Err("This trailer is unavailable from the video provider".into());
    }
    parse_source(&output.stdout)
}
fn cached(key: &str) -> Option<TrailerSource> {
    CACHE
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|c| c.key == key && c.expires > Instant::now())
        .map(|c| c.source.clone())
}
#[tauri::command]
pub async fn trailer_resolve(key: String, refresh: Option<bool>) -> Result<TrailerSource, String> {
    if !valid_key(&key) {
        return Err("Invalid trailer video ID".into());
    }
    if !refresh.unwrap_or(false) {
        if let Some(s) = cached(&key) {
            return Ok(s);
        }
    }
    let _guard = tokio::time::timeout(Duration::from_secs(40), RESOLVE.lock())
        .await
        .map_err(|_| "Trailer resolver is busy")?;
    if !refresh.unwrap_or(false) {
        if let Some(s) = cached(&key) {
            return Ok(s);
        }
    }
    let (video, audio, width, height) = extract(&key).await?;
    // Metadata can resolve before a CDN endpoint responds reliably. Verify the actual media,
    // not just extraction success, before handing a fresh source to WebKit/WebView2.
    let verify = |track: Track| async move {
        let mut response = fetch_track(&track, Some("bytes=0-31"), false)
            .await
            .map_err(|_| "Trailer media could not be reached")?;
        let mut prefix: Vec<u8> = Vec::with_capacity(32);
        while prefix.len() < 32 {
            let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "Trailer media could not be read")?
            else {
                break;
            };
            prefix.extend(chunk.iter().take(32 - prefix.len()).copied());
        }
        if !prefix.windows(4).any(|w| w == b"ftyp") {
            return Err("Invalid trailer media");
        }
        Ok::<(), &str>(())
    };
    if let Some(ref audio) = audio {
        tokio::try_join!(verify(video.clone()), verify(audio.clone()))?;
    } else {
        verify(video.clone()).await?;
    }
    let port = PORT.get_or_try_init(start_server).await?;
    let mut random = [0u8; 24];
    getrandom::getrandom(&mut random).map_err(|_| "Could not create trailer session")?;
    let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let base = format!("http://127.0.0.1:{port}/media/{token}");
    let source = TrailerSource {
        video_url: format!("{base}/video"),
        audio_url: audio.as_ref().map(|_| format!("{base}/audio")),
        width,
        height,
    };
    let mut cache = CACHE.lock().unwrap();
    cache.retain(|c| c.expires > Instant::now());
    if cache.len() >= 24 {
        cache.remove(0);
    }
    cache.push(Cached {
        key,
        token,
        source: source.clone(),
        video,
        audio,
        expires: Instant::now() + Duration::from_secs(1800),
    });
    Ok(source)
}
async fn start_server() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Could not start the trailer relay")?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        while let Ok((mut conn, _)) = listener.accept().await {
            tokio::spawn(async move {
                let Ok(_permit) = REQUESTS.try_acquire() else {
                    let _ = reply(&mut conn, 503).await;
                    return;
                };
                let _ = serve(&mut conn).await;
            });
        }
    });
    Ok(port)
}
const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length\r\n";
async fn reply(conn: &mut TcpStream, status: u16) -> std::io::Result<()> {
    conn.write_all(
        format!("HTTP/1.1 {status} Error\r\n{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .await
}
fn valid_range(range: &str) -> bool {
    range
        .strip_prefix("bytes=")
        .and_then(|s| s.split_once('-'))
        .is_some_and(|(a, b)| {
            (!a.is_empty() || !b.is_empty())
                && a.bytes().chain(b.bytes()).all(|b| b.is_ascii_digit())
                && a.len() <= 20
                && b.len() <= 20
        })
}
async fn relay(
    conn: &mut TcpStream,
    track: Track,
    range: Option<&str>,
    head: bool,
) -> std::io::Result<()> {
    let mut response = match fetch_track(&track, range, head).await {
        Ok(r) => r,
        Err(status) => return reply(conn, status).await,
    };
    let status = response.status().as_u16();
    if status != 200 && status != 206 {
        return reply(conn, if status == 416 { 416 } else { 502 }).await;
    }
    if response.content_length().is_some_and(|len| len > MAX_MEDIA) {
        return reply(conn, 413).await;
    }
    let mut header = format!("HTTP/1.1 {status} OK\r\nContent-Type: {}\r\nCache-Control: no-store\r\nAccept-Ranges: bytes\r\n{CORS}Connection: close\r\n", track.mime);
    for name in ["content-length", "content-range"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            header.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    header.push_str("\r\n");
    conn.write_all(header.as_bytes()).await?;
    if head {
        return Ok(());
    }
    let mut sent = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(std::io::Error::other)? {
        sent += chunk.len() as u64;
        if sent > MAX_MEDIA {
            return Ok(());
        }
        conn.write_all(&chunk).await?;
    }
    Ok(())
}
async fn fetch_track(
    track: &Track,
    range: Option<&str>,
    head: bool,
) -> Result<reqwest::Response, u16> {
    let client = client().map_err(|_| 502u16)?;
    for attempt in 0..4 {
        let mut request = if head {
            client.head(&track.url)
        } else {
            client.get(&track.url)
        };
        request = request
            .header("Accept", "*/*")
            .header("Accept-Language", "en-us,en;q=0.5")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Accept-Encoding", "identity");
        if !track.user_agent.is_empty() {
            request = request.header("User-Agent", &track.user_agent);
        }
        if !track.referrer.is_empty() {
            request = request.header("Referer", &track.referrer);
        }
        if let Some(r) = range {
            request = request.header("Range", r);
        }
        match tokio::time::timeout(Duration::from_secs(8), request.send()).await {
            Ok(Ok(response)) => {
                let status = response.status().as_u16();
                if status == 200 || status == 206 || status == 416 {
                    return Ok(response);
                }
                if status != 403 && status < 500 {
                    return Err(502);
                }
            }
            _ => {}
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_millis([250, 750, 1500][attempt])).await;
        }
    }
    Err(502)
}
async fn serve(conn: &mut TcpStream) -> std::io::Result<()> {
    let mut request = Vec::new();
    let mut buf = [0; 1024];
    loop {
        let n = match tokio::time::timeout(Duration::from_secs(5), conn.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => return Ok(()),
        };
        request.extend_from_slice(&buf[..n]);
        if request.len() > 8192 {
            return reply(conn, 431).await;
        }
        if request.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&request);
    let mut first = text.lines().next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default();
    let path = first.next().unwrap_or_default();
    if method == "OPTIONS" {
        return reply(conn, 204).await;
    }
    if method != "GET" && method != "HEAD" {
        return reply(conn, 405).await;
    }
    let mut parts = path.strip_prefix("/media/").unwrap_or_default().split('/');
    let token = parts.next().unwrap_or_default();
    let kind = parts.next().unwrap_or_default();
    if token.len() != 48 || parts.next().is_some() {
        return reply(conn, 404).await;
    }
    let track = CACHE
        .lock()
        .unwrap()
        .iter()
        .find(|c| c.token == token && c.expires > Instant::now())
        .and_then(|c| match kind {
            "video" => Some(c.video.clone()),
            "audio" => c.audio.clone(),
            _ => None,
        });
    let Some(track) = track else {
        return reply(conn, 404).await;
    };
    let range = text
        .lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("range"))
        .map(|(_, v)| v.trim());
    if range.is_some_and(|r| !valid_range(r)) {
        return reply(conn, 416).await;
    }
    relay(conn, track, range, method == "HEAD").await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_video_keys_urls_and_ranges() {
        assert!(valid_key("84o1Q6fB20k"));
        for key in ["../settings", "abcdefghijk/more", "https://example.org"] {
            assert!(!valid_key(key));
        }
        assert!(allowed_url(
            "https://rr1.googlevideo.com/videoplayback?expire=123"
        ));
        for url in [
            "http://rr1.googlevideo.com/video",
            "https://googlevideo.com.evil.org/video",
            "https://127.0.0.1/video",
            "https://rr1.googlevideo.com:1234/video",
            "https://user@rr1.googlevideo.com/video",
        ] {
            assert!(!allowed_url(url));
        }
        for r in ["bytes=0-100", "bytes=100-", "bytes=-100"] {
            assert!(valid_range(r));
        }
        for r in ["bytes=-", "bytes=0-1,5-6", "bytes=0-1\r\nX: x", "bytes=a-b"] {
            assert!(!valid_range(r));
        }
    }
    #[test]
    fn requires_compatible_short_video_with_audio() {
        let info = serde_json::json!({"duration":120,"requested_formats":[
            {"url":"https://rr1.googlevideo.com/video","width":1920,"height":1080,"vcodec":"avc1.640028","acodec":"none","ext":"mp4"},
            {"url":"https://rr1.googlevideo.com/audio","vcodec":"none","acodec":"mp4a.40.2","ext":"m4a"}
        ]});
        let (_, audio, w, h) = parse_source(info.to_string().as_bytes()).unwrap();
        assert!(audio.is_some());
        assert_eq!((w, h), (1920, 1080));
        let mut bad = info.clone();
        bad["duration"] = serde_json::json!(7200);
        assert!(parse_source(bad.to_string().as_bytes()).is_err());
        let mut bad = info.clone();
        bad["requested_formats"][0]["url"] = serde_json::json!("https://localhost/secret");
        assert!(parse_source(bad.to_string().as_bytes()).is_err());
        let mut bad = info.clone();
        bad["requested_formats"].as_array_mut().unwrap().pop();
        assert!(parse_source(bad.to_string().as_bytes()).is_err());
    }
    #[tokio::test]
    async fn relay_server_requires_an_active_token() {
        assert!(trailer_resolve("../settings".into(), None).await.is_err());
        let port = start_server().await.unwrap();
        let client = Client::new();
        for path in [
            "/",
            "/api/library",
            "/media/invalid/video",
            "/media/000000000000000000000000000000000000000000000000/video",
        ] {
            assert_eq!(
                client
                    .get(format!("http://127.0.0.1:{port}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
        }
        assert_eq!(
            client
                .post(format!("http://127.0.0.1:{port}/"))
                .send()
                .await
                .unwrap()
                .status(),
            405
        );
    }
    #[tokio::test]
    async fn relay_preserves_byte_ranges_and_does_not_expose_source_urls() {
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = origin.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (mut conn, _) = origin.accept().await.unwrap();
            let mut buf = [0; 4096];
            let n = conn.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
            assert!(request.contains("range: bytes=2-4\r\n"));
            conn.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/5\r\nConnection: close\r\n\r\ndeo").await.unwrap();
        });
        let token = "ffffffffffffffffffffffffffffffffffffffffffffffff";
        CACHE.lock().unwrap().push(Cached {
            key: "fixture".into(),
            token: token.into(),
            expires: Instant::now() + Duration::from_secs(30),
            source: TrailerSource {
                video_url: String::new(),
                audio_url: None,
                width: 1920,
                height: 1080,
            },
            video: Track {
                url: format!("http://{addr}/private-source"),
                mime: "video/mp4",
                user_agent: String::new(),
                referrer: String::new(),
            },
            audio: None,
        });
        let port = start_server().await.unwrap();
        let url = format!("http://127.0.0.1:{port}/media/{token}/video");
        let response = Client::new()
            .get(&url)
            .header("Range", "bytes=2-4")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-4/5");
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert!(response.headers().get("location").is_none());
        assert_eq!(response.text().await.unwrap(), "deo");
        upstream.await.unwrap();
        CACHE.lock().unwrap().retain(|c| c.token != token);
        assert_eq!(Client::new().get(url).send().await.unwrap().status(), 404);
    }
    #[tokio::test]
    async fn retries_a_temporary_provider_failure_before_failing_the_video() {
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = origin.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            for status in [503, 206] {
                let (mut conn, _) = origin.accept().await.unwrap();
                let mut request = [0; 1024];
                let _ = conn.read(&mut request).await.unwrap();
                conn.write_all(
                    format!(
                        "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            }
        });
        let track = Track {
            url: format!("http://{addr}/video"),
            mime: "video/mp4",
            user_agent: String::new(),
            referrer: String::new(),
        };
        assert_eq!(
            fetch_track(&track, Some("bytes=0-31"), false)
                .await
                .unwrap()
                .status(),
            206
        );
        upstream.await.unwrap();
    }
}
