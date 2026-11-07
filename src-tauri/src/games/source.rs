//! Fetches pages from the user's game source and caches its artwork locally, so the app's content
//! security policy never needs to list the source's hosts.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tauri::Url;
use tokio::sync::Semaphore;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_PAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static IMAGE_SLOTS: Semaphore = Semaphore::const_new(6);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResponse {
    pub status: u16,
    pub body: String,
    pub total_pages: Option<u32>,
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (b & 0xc0) == 64)
                || (a == 198 && (b & 0xfe) == 18))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xffc0) == 0xfec0
                || (first == 0x2001 && v6.segments()[1] == 0x0db8))
        }
    }
}

/// Resolves host names, dropping private, loopback and link-local addresses so the source can't
/// point TruongFlix at the local network.
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| is_public(a.ip())).collect();
            if addrs.is_empty() {
                return Err(format!("{host} is not a public address").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Redirects may only move to HTTPS on the same host.
fn redirect_allowed(from: &Url, to: &Url) -> bool {
    to.scheme() == "https"
        && to.host_str().is_some()
        && to.host_str() == from.host_str()
        && to.port_or_known_default() == Some(443)
        && to.username().is_empty()
        && to.password().is_none()
}

fn client() -> Result<&'static reqwest::Client, String> {
    CLIENT
        .get_or_init(|| {
            let redirects = reqwest::redirect::Policy::custom(|attempt| {
                let previous = attempt.previous();
                if previous.len() > MAX_REDIRECTS {
                    return attempt.error("Too many redirects");
                }
                match previous.first() {
                    Some(first) if redirect_allowed(first, attempt.url()) => attempt.follow(),
                    _ => attempt.error("Redirected to another site"),
                }
            });
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(Duration::from_secs(25))
                .connect_timeout(Duration::from_secs(10))
                .redirect(redirects)
                .dns_resolver(PublicOnly)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn push_capped(body: &mut Vec<u8>, chunk: &[u8], max: usize) -> bool {
    if body.len() + chunk.len() > max {
        return false;
    }
    body.extend_from_slice(chunk);
    true
}

/// Reads a response body, giving up as soon as it grows past `max` bytes.
async fn read_capped(mut response: reqwest::Response, max: usize, too_large: &str) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(too_large.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if !push_capped(&mut body, &chunk, max) {
            return Err(too_large.into());
        }
    }
    Ok(body)
}

/// `path` must be a path on the source itself (e.g. `/wp-json/wp/v2/posts?page=2`).
pub fn source_url(origin: &str, path: &str) -> Result<String, String> {
    let origin = crate::source_browser::source_origin(origin)?;
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') || path.contains("://") {
        return Err("Invalid source path".into());
    }
    Ok(format!("{origin}{path}"))
}

pub async fn get(origin: &str, path: &str) -> Result<SourceResponse, String> {
    let url = source_url(origin, path)?;
    let response = client()?.get(&url).send().await.map_err(|e| {
        if e.is_timeout() {
            "The game source didn't answer in time.".to_string()
        } else {
            format!("Couldn't reach the game source: {e}")
        }
    })?;
    let status = response.status().as_u16();
    let total_pages = response
        .headers()
        .get("x-wp-totalpages")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let bytes = read_capped(response, MAX_PAGE_BYTES, "The game source sent an unexpectedly large page.").await?;
    Ok(SourceResponse { status, body: String::from_utf8_lossy(&bytes).into_owned(), total_pages })
}

fn image_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Invalid image address".to_string())?;
    let host = url.host_str().unwrap_or_default().trim_end_matches('.');
    let public = host.contains('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && !host.ends_with(".local")
        && !host.ends_with(".localhost")
        && !host.ends_with(".internal");
    if !matches!(url.scheme(), "https" | "http") || !public || !url.username().is_empty() {
        return Err("Invalid image address".into());
    }
    Ok(url)
}

fn cache_name(url: &str) -> String {
    // FNV-1a: a stable file name per image URL.
    let hash = url.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    let ext = url
        .split(['?', '#'])
        .next()
        .and_then(|p| p.rsplit('.').next())
        .map(str::to_ascii_lowercase)
        .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif"))
        .unwrap_or_else(|| "img".into());
    format!("{hash:016x}.{ext}")
}

pub async fn cache_image(cache_dir: PathBuf, raw: &str) -> Result<String, String> {
    let url = image_url(raw)?;
    let path = cache_dir.join(cache_name(url.as_str()));
    if path.is_file() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let _slot = IMAGE_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    if path.is_file() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let response = client()?.get(url.as_str()).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Image request failed: HTTP {}", response.status()));
    }
    let is_image = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("image/"));
    if !is_image {
        return Err("The address is not an image".into());
    }
    let bytes = read_capped(response, MAX_IMAGE_BYTES, "Image is too large").await?;
    tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| e.to_string())?;
    let partial = path.with_extension("part");
    tokio::fs::write(&partial, &bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&partial, &path).await.map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_paths_stay_on_the_source() {
        assert_eq!(
            source_url("https://games.example/", "/wp-json/wp/v2/posts?page=2").unwrap(),
            "https://games.example/wp-json/wp/v2/posts?page=2"
        );
        assert!(source_url("http://games.example", "/").is_err());
        assert!(source_url("https://games.example", "//evil.example/x").is_err());
        assert!(source_url("https://games.example", "https://evil.example").is_err());
        assert!(source_url("https://games.example", "x").is_err());
        assert!(source_url("https://127.0.0.1", "/").is_err());
    }

    #[test]
    fn images_must_be_public_web_addresses() {
        assert!(image_url("https://img.example/a/b.jpg").is_ok());
        assert!(image_url("http://img.example/a.jpg.240p.jpg").is_ok());
        assert!(image_url("file:///C:/x.jpg").is_err());
        assert!(image_url("http://192.168.1.2/x.jpg").is_err());
        assert!(image_url("https://printer.local/x.jpg").is_err());
    }

    #[test]
    fn only_public_addresses_are_reachable() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.2", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn redirects_stay_on_the_same_https_host() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(redirect_allowed(&url("https://games.example/a"), &url("https://games.example/b")));
        assert!(redirect_allowed(&url("http://img.example/a.jpg"), &url("https://img.example/a.jpg")));
        assert!(!redirect_allowed(&url("https://games.example/a"), &url("http://games.example/b")));
        assert!(!redirect_allowed(&url("https://games.example/a"), &url("https://evil.example/b")));
        assert!(!redirect_allowed(&url("https://games.example/a"), &url("https://games.example:8443/b")));
        assert!(!redirect_allowed(&url("https://games.example/a"), &url("https://user@games.example/b")));
    }

    #[test]
    fn bodies_are_capped_while_reading() {
        let mut body = Vec::new();
        assert!(push_capped(&mut body, &[0; 6], 10));
        assert!(push_capped(&mut body, &[0; 4], 10));
        assert!(!push_capped(&mut body, &[0; 1], 10));
        assert_eq!(body.len(), 10);
    }

    #[test]
    fn cache_names_are_stable_and_keep_image_extensions() {
        let a = cache_name("https://img.example/a.jpg?resize=1");
        assert_eq!(a, cache_name("https://img.example/a.jpg?resize=1"));
        assert!(a.ends_with(".jpg"));
        assert!(cache_name("https://img.example/a").ends_with(".img"));
    }
}
