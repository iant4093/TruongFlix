//! OpenSubtitles.com integration: file hashing, search, download, and sidecar discovery.
//! HTTP runs here (not in the webview) because the API requires an app User-Agent header.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const API: &str = "https://api.opensubtitles.com/api/v1";
const USER_AGENT: &str = concat!("TruongFlix v", env!("CARGO_PKG_VERSION"));
const SUB_EXTENSIONS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub"];
const SUB_FOLDERS: &[&str] = &["Subs", "subs", "Subtitles", "subtitles"];

#[derive(Default)]
pub struct SubtitleState {
    /// (username, JWT token, API base URL) from the last successful login.
    session: Mutex<Option<(String, String, String)>>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// Extracts OpenSubtitles' human-readable `message` from an error body when present.
fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.get("errors").and_then(|e| e.get(0)))
                .and_then(|m| m.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        403 if msg.is_empty() || msg.contains("cannot consume") => "OpenSubtitles rejected this API key.".into(),
        401 if msg.is_empty() => "OpenSubtitles rejected the username or password.".into(),
        _ if msg.is_empty() => format!("OpenSubtitles error ({status})"),
        _ => msg,
    }
}

// ---------------------------------------------------------------------------
// Moviehash: file size + 64-bit sums of the first and last 64 KiB.
// ---------------------------------------------------------------------------

const HASH_CHUNK: u64 = 64 * 1024;

fn moviehash(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    if size < HASH_CHUNK * 2 {
        return Err(std::io::Error::other("file too small to hash"));
    }
    let mut hash = size;
    let mut buf = vec![0u8; HASH_CHUNK as usize];
    for offset in [0, size - HASH_CHUNK] {
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut buf)?;
        for chunk in buf.chunks_exact(8) {
            hash = hash.wrapping_add(u64::from_le_bytes(chunk.try_into().unwrap()));
        }
    }
    Ok(format!("{hash:016x}"))
}

#[tauri::command]
pub async fn subtitle_hash(video_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || moviehash(Path::new(&video_path)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async fn login(api_key: &str, username: &str, password: &str) -> Result<(String, String), String> {
    let res = client()?
        .post(format!("{API}/login"))
        .header("Api-Key", api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(serde_json::json!({ "username": username, "password": password }).to_string())
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenSubtitles: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let token = v["token"].as_str().ok_or("Login response had no token")?.to_owned();
    let base = v["base_url"]
        .as_str()
        .map(|h| format!("https://{}/api/v1", h.trim_start_matches("https://").trim_end_matches('/')))
        .unwrap_or_else(|| API.to_owned());
    Ok((token, base))
}

/// Returns (base_url, optional bearer token), logging in once per session when credentials exist.
async fn session(
    state: &SubtitleState,
    api_key: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let (Some(user), Some(pass)) = (username.filter(|u| !u.is_empty()), password.filter(|p| !p.is_empty())) else {
        return Ok((API.to_owned(), None));
    };
    if let Some((u, token, base)) = state.session.lock().map_err(|e| e.to_string())?.clone() {
        if u == user {
            return Ok((base, Some(token)));
        }
    }
    let (token, base) = login(api_key, user, pass).await?;
    *state.session.lock().map_err(|e| e.to_string())? = Some((user.to_owned(), token.clone(), base.clone()));
    Ok((base, Some(token)))
}

#[derive(Serialize)]
pub struct VerifyResult {
    logged_in: bool,
    allowed_downloads: Option<i64>,
}

/// Validates the API key (and the optional account credentials).
#[tauri::command]
pub async fn opensubtitles_verify(
    state: State<'_, SubtitleState>,
    api_key: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<VerifyResult, String> {
    if let (Some(u), Some(p)) = (username.as_deref().filter(|s| !s.is_empty()), password.as_deref().filter(|s| !s.is_empty())) {
        *state.session.lock().map_err(|e| e.to_string())? = None;
        let (token, base) = login(&api_key, u, p).await?;
        let res = client()?
            .get(format!("{base}/infos/user"))
            .header("Api-Key", &api_key)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let allowed = res
            .text()
            .await
            .ok()
            .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
            .and_then(|v| v["data"]["allowed_downloads"].as_i64());
        *state.session.lock().map_err(|e| e.to_string())? = Some((u.to_owned(), token, base));
        return Ok(VerifyResult { logged_in: true, allowed_downloads: allowed });
    }
    check_api_key(&api_key).await?;
    Ok(VerifyResult { logged_in: false, allowed_downloads: Some(5) })
}

/// `/infos/*` endpoints answer without checking the key, so validate with a tiny (cached) search.
async fn check_api_key(api_key: &str) -> Result<(), String> {
    let res = client()?
        .get(format!("{API}/subtitles?languages=en&tmdb_id=603"))
        .header("Api-Key", api_key)
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenSubtitles: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(api_error(status, &body));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Search & download
// ---------------------------------------------------------------------------

/// Proxies GET /subtitles. Params are sent sorted and lower-cased, as the API recommends
/// (otherwise it answers with a redirect).
#[tauri::command]
pub async fn opensubtitles_search(api_key: String, params: BTreeMap<String, String>) -> Result<serde_json::Value, String> {
    let query: Vec<(String, String)> = params.into_iter().map(|(k, v)| (k.to_lowercase(), v.to_lowercase())).collect();
    let url = reqwest::Url::parse_with_params(&format!("{API}/subtitles"), &query).map_err(|e| e.to_string())?;
    let res = client()?
        .get(url)
        .header("Api-Key", &api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenSubtitles: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct DownloadResult {
    path: String,
    remaining: Option<i64>,
    message: Option<String>,
}

fn sanitize_lang(lang: &str) -> String {
    lang.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(8).collect::<String>().to_lowercase()
}

/// Picks `<video stem>.<lang>.<ext>` beside the video, avoiding overwriting existing files.
fn sidecar_path(video: &Path, lang: &str, ext: &str, file_id: i64) -> Option<PathBuf> {
    let dir = video.parent()?;
    let stem = video.file_stem()?.to_string_lossy();
    let primary = dir.join(format!("{stem}.{lang}.{ext}"));
    if !primary.exists() {
        return Some(primary);
    }
    Some(dir.join(format!("{stem}.{lang}.os{file_id}.{ext}")))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn opensubtitles_download(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    api_key: String,
    username: Option<String>,
    password: Option<String>,
    file_id: i64,
    video_path: String,
    language: String,
) -> Result<DownloadResult, String> {
    let (base, token) = session(&state, &api_key, username.as_deref(), password.as_deref()).await?;
    let mut req = client()?
        .post(format!("{base}/download"))
        .header("Api-Key", &api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(serde_json::json!({ "file_id": file_id }).to_string());
    if let Some(t) = &token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let res = req.send().await.map_err(|e| format!("Could not reach OpenSubtitles: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        if status.as_u16() == 401 {
            if let Ok(mut s) = state.session.lock() {
                *s = None;
            }
        }
        return Err(api_error(status, &body));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let link = v["link"].as_str().ok_or_else(|| api_error(status, &body))?;
    let remote_name = v["file_name"].as_str().unwrap_or("subtitle.srt");
    let ext = Path::new(remote_name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| SUB_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or_else(|| "srt".into());

    let bytes = client()?
        .get(link)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Subtitle download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    let video = PathBuf::from(&video_path);
    let lang = sanitize_lang(&language);
    let mut written = None;
    if let Some(dest) = sidecar_path(&video, &lang, &ext, file_id) {
        if std::fs::write(&dest, &bytes).is_ok() {
            written = Some(dest);
        }
    }
    // Read-only media folder (e.g. a NAS share): keep the file in the app's data directory instead.
    if written.is_none() {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("subtitles");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = video.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "video".into());
        let dest = dir.join(format!("{stem}.{lang}.os{file_id}.{ext}"));
        std::fs::write(&dest, &bytes).map_err(|e| format!("Could not save subtitle: {e}"))?;
        written = Some(dest);
    }

    Ok(DownloadResult {
        path: written.unwrap().to_string_lossy().into_owned(),
        remaining: v["remaining"].as_i64(),
        message: v["message"].as_str().map(str::to_owned),
    })
}

// ---------------------------------------------------------------------------
// Local sidecar files
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct LocalSubtitle {
    path: String,
    file_name: String,
    language: Option<String>,
}

/// Language tag between the video stem and the extension, e.g. `Movie.en.srt` / `Movie.eng.forced.srt`.
fn language_hint(stem_rest: &str) -> Option<String> {
    stem_rest
        .split(['.', '_', '-', ' '])
        .find(|t| (2..=3).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphabetic()))
        .map(str::to_lowercase)
}

fn is_subtitle(path: &Path) -> bool {
    path.extension()
        .map(|e| SUB_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Finds subtitle files next to a video (matching its name) or in a Subs/Subtitles folder beside it.
#[tauri::command]
pub fn list_local_subtitles(video_path: String) -> Vec<LocalSubtitle> {
    let video = Path::new(&video_path);
    let (Some(dir), Some(stem)) = (video.parent(), video.file_stem()) else {
        return Vec::new();
    };
    let stem = stem.to_string_lossy().to_lowercase();
    let mut out = Vec::new();
    let mut push = |p: PathBuf, require_stem: bool| {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let lower = name.to_lowercase();
        if require_stem && !lower.starts_with(&stem) {
            return;
        }
        let rest = lower.strip_prefix(&stem).unwrap_or(&lower);
        let rest = rest.rsplit_once('.').map(|(r, _)| r).unwrap_or(rest);
        out.push(LocalSubtitle { path: p.to_string_lossy().into_owned(), file_name: name, language: language_hint(rest) });
    };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && is_subtitle(&p) {
                push(p, true);
            }
        }
    }
    // "Subs" and "subs" are the same folder on case-insensitive filesystems (macOS, Windows).
    let mut seen_dirs = std::collections::HashSet::new();
    for folder in SUB_FOLDERS {
        let sub_dir = dir.join(folder);
        let Ok(canonical) = std::fs::canonicalize(&sub_dir) else { continue };
        if !seen_dirs.insert(canonical) {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&sub_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() && is_subtitle(&p) {
                    push(p, false);
                }
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// Deletes a subtitle file TruongFlix downloaded. Refuses anything that isn't a subtitle file.
#[tauri::command]
pub fn delete_subtitle_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !is_subtitle(p) {
        return Err("Not a subtitle file".into());
    }
    match std::fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moviehash_matches_reference_algorithm() {
        let dir = std::env::temp_dir().join(format!("truongflix-hash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("v.mkv");
        // 256 KiB of a repeating byte pattern: hash = size + sum of 16384 LE u64 words.
        let data: Vec<u8> = (0..256 * 1024).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        let mut expected = data.len() as u64;
        for range in [0..65536, data.len() - 65536..data.len()] {
            for c in data[range].chunks_exact(8) {
                expected = expected.wrapping_add(u64::from_le_bytes(c.try_into().unwrap()));
            }
        }
        assert_eq!(moviehash(&path).unwrap(), format!("{expected:016x}"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Network test: `cargo test -- --ignored rejects_bad_api_key`
    #[test]
    #[ignore]
    fn rejects_bad_api_key() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let err = rt.block_on(check_api_key("definitely-not-a-key")).unwrap_err();
        assert_eq!(err, "OpenSubtitles rejected this API key.");
    }

    #[test]
    fn finds_sidecars_and_language_tags() {
        let dir = std::env::temp_dir().join(format!("truongflix-subs-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Subs")).unwrap();
        for f in ["Show.S01E01.mkv", "Show.S01E01.en.srt", "Show.S01E01.eng.forced.srt", "Other.S01E02.en.srt", "Subs/English.srt"] {
            std::fs::write(dir.join(f), b"1").unwrap();
        }
        let found = list_local_subtitles(dir.join("Show.S01E01.mkv").to_string_lossy().into_owned());
        let names: Vec<_> = found.iter().map(|s| (s.file_name.as_str(), s.language.as_deref())).collect();
        assert_eq!(
            names,
            [("Show.S01E01.en.srt", Some("en")), ("Show.S01E01.eng.forced.srt", Some("eng")), ("English.srt", None)]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
