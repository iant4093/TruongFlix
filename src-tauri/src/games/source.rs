//! Fetches pages from the user's game source and caches its artwork locally, so the app's content
//! security policy never needs to list the source's hosts.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_PAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResponse {
    pub status: u16,
    pub body: String,
    pub total_pages: Option<u32>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())
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
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_PAGE_BYTES {
        return Err("The game source sent an unexpectedly large page.".into());
    }
    Ok(SourceResponse { status, body: String::from_utf8_lossy(&bytes).into_owned(), total_pages })
}

fn image_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw.trim()).map_err(|_| "Invalid image address".to_string())?;
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
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image is too large".into());
    }
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
    fn cache_names_are_stable_and_keep_image_extensions() {
        let a = cache_name("https://img.example/a.jpg?resize=1");
        assert_eq!(a, cache_name("https://img.example/a.jpg?resize=1"));
        assert!(a.ends_with(".jpg"));
        assert!(cache_name("https://img.example/a").ends_with(".img"));
    }
}
