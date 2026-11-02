//! Source browser filtering. Remote pages never receive a library capability.
#[cfg(any(target_os = "windows", test))]
use adblock::request::Request;
use adblock::{
    engine::Engine,
    lists::{FilterSet, ParseOptions},
};
use serde::Serialize;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const EASYLIST: &str = include_str!("../resources/source-filters/easylist.txt");
const PRIVACY: &str = include_str!("../resources/source-filters/easyprivacy.txt");
const FIXES: &str =
    "||predictivdisplay.com^\n||net.geo.opera.com^\n@@||challenges.cloudflare.com^\n";
const MAX_BYTES: usize = 6_000_000;
static UPDATING: AtomicBool = AtomicBool::new(false);
static ACTIVE: OnceLock<Arc<Rules>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub rules: usize,
    pub updated: u64,
    pub bundled: bool,
}

pub struct Rules {
    pub engine: Engine,
    pub webkit: String,
    pub status: Status,
}
impl Rules {
    pub fn compile(text: &str, updated: u64, bundled: bool) -> Result<Self, String> {
        let text = format!("{text}\n{FIXES}");
        let mut set = FilterSet::new(true);
        set.add_filter_list(text.clone(), ParseOptions::default());
        let (rules, _) = set
            .into_content_blocking()
            .map_err(|_| "Could not convert browser filters")?;
        if rules.is_empty() || rules.len() > 149_900 {
            return Err("Browser filter count is out of bounds".into());
        }
        let count = rules.len();
        let webkit = serde_json::to_string(&rules).map_err(|e| e.to_string())?;
        Ok(Self {
            engine: Engine::new_with_list_text(text),
            webkit,
            status: Status {
                rules: count,
                updated,
                bundled,
            },
        })
    }
    #[cfg(any(target_os = "windows", test))]
    pub fn blocks(&self, url: &str, source: &str, kind: &str) -> bool {
        Request::new(url, source, kind, "get")
            .is_ok_and(|req| self.engine.check_network_request(&req).should_block())
    }
}

pub fn load(cache: &Path) -> Result<Arc<Rules>, String> {
    if let Some(rules) = ACTIVE.get() {
        return Ok(rules.clone());
    }
    let cached = std::fs::read_to_string(cache.join("source-filters.txt"))
        .ok()
        .filter(|s| s.len() < MAX_BYTES && s.lines().count() > 1000 && s.starts_with("[Adblock"));
    let updated = std::fs::metadata(cache.join("source-filters.txt"))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let bundled = cached.is_none();
    let text = cached.unwrap_or_else(|| format!("{EASYLIST}\n{PRIVACY}"));
    let compiled = Rules::compile(&text, updated, bundled)
        .or_else(|_| Rules::compile(&format!("{EASYLIST}\n{PRIVACY}"), 0, true))?;
    let rules = Arc::new(compiled);
    let _ = ACTIVE.set(rules.clone());
    Ok(ACTIVE.get().cloned().unwrap_or(rules))
}

/// Updates a cache for the next app launch; a failed refresh never replaces the bundled/working set.
pub async fn refresh(cache: &Path) -> Result<(), String> {
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            UPDATING.store(false, Ordering::SeqCst);
        }
    }
    let _reset = Reset;
    let file = cache.join("source-filters.txt");
    if std::fs::metadata(&file)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|d| d < Duration::from_secs(86400))
    {
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    let mut parts = Vec::new();
    for url in [
        "https://easylist.to/easylist/easylist.txt",
        "https://easylist.to/easylist/easyprivacy.txt",
    ] {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_BYTES / 2 {
                return Err("Filter update is too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        if !text.starts_with("[Adblock") || text.lines().count() < 1000 {
            return Err("Filter update is not an ad-blocking list".into());
        }
        parts.push(text);
    }
    let text = parts.join("\n");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let validated = text.clone();
    tauri::async_runtime::spawn_blocking(move || Rules::compile(&validated, now, false))
        .await
        .map_err(|e| e.to_string())??;
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let tmp = cache.join("source-filters.pending");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // Windows rename cannot overwrite an existing file. Keep the previous file until the new one is ready.
    let old = cache.join("source-filters.previous");
    if file.exists() {
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&file, &old).map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&tmp, &file) {
        let _ = std::fs::rename(&old, &file);
        return Err(e.to_string());
    }
    let _ = std::fs::remove_file(old);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_block_ads_allow_exceptions_and_convert_cosmetics() {
        let rules = Rules::compile(
            "||ads.example.com^\n@@||ads.example.com/essential.js$script\nexample.com##.test-ad",
            0,
            true,
        )
        .unwrap();
        assert!(rules.blocks(
            "https://ads.example.com/banner.js",
            "https://example.com",
            "script"
        ));
        assert!(!rules.blocks(
            "https://ads.example.com/essential.js",
            "https://example.com",
            "script"
        ));
        assert!(!rules.blocks(
            "https://challenges.cloudflare.com/widget",
            "https://ext.to",
            "subdocument"
        ));
        assert!(rules.webkit.contains("css-display-none"));
        assert!(rules.webkit.contains(".test-ad"));
    }
    #[test]
    fn bundled_lists_are_convertible_and_keep_site_scripts() {
        let rules = Rules::compile(&format!("{EASYLIST}\n{PRIVACY}"), 0, true).unwrap();
        assert!(rules.status.rules > 1000);
        assert!(rules.blocks(
            "https://www.predictivdisplay.com/jump/next.php",
            "https://ext.to",
            "subdocument"
        ));
        assert!(!rules.blocks(
            "https://ext.to/static/js/advanced-search-list.js",
            "https://ext.to",
            "script"
        ));
    }
}

// Only CSS selectors from maintained filter lists are applied; remote pages supply bounded class/id names.
impl Rules {
    pub fn cosmetic(&self, url: &str, classes: Vec<String>, ids: Vec<String>) -> Vec<String> {
        let resources = self.engine.url_cosmetic_resources(url);
        let generic = if resources.generichide {
            vec![]
        } else {
            self.engine
                .hidden_class_id_selectors(classes, ids, &resources.exceptions)
        };
        resources
            .hide_selectors
            .into_iter()
            .chain(generic)
            .take(5000)
            .collect()
    }
}
