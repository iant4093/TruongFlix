//! IMDb ratings from IMDb's official non-commercial datasets (https://developer.imdb.com/non-commercial-datasets/).
//! The files are cached in the app cache dir and stream-filtered down to titles in the library.

use flate2::read::GzDecoder;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

const BASE_URL: &str = "https://datasets.imdbws.com";
const RATINGS_FILE: &str = "title.ratings.tsv.gz";
const EPISODES_FILE: &str = "title.episode.tsv.gz";
/// Ratings change daily; the episode → show mapping only matters for newly aired episodes.
const RATINGS_MAX_AGE: Duration = Duration::from_secs(20 * 3600);
const EPISODES_MAX_AGE: Duration = Duration::from_secs(6 * 24 * 3600);

#[derive(Clone, Serialize)]
struct Progress {
    message: String,
}

fn emit(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("imdb-progress", Progress { message: message.into() });
}

fn age(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

async fn download(app: &AppHandle, name: &str, label: &str, dest: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("TruongFlix v", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client
        .get(format!("{BASE_URL}/{name}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("IMDb download failed: {e}"))?;
    let total = res.content_length().unwrap_or(0);
    let part = dest.with_extension("part");
    let mut file = File::create(&part).map_err(|e| e.to_string())?;
    let (mut done, mut last_pct) = (0u64, u64::MAX);
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("IMDb download failed: {e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        let pct = if total > 0 { done * 100 / total } else { 0 };
        if pct != last_pct {
            last_pct = pct;
            emit(app, format!("Downloading IMDb {label}… {pct}%"));
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// Returns a cached dataset, refreshing it when stale. Falls back to the stale copy when offline.
async fn ensure_dataset(app: &AppHandle, name: &str, label: &str, max_age: Duration, force: bool) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("imdb");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    let fresh = age(&path).is_some_and(|a| a < max_age);
    if fresh && !force {
        return Ok(path);
    }
    match download(app, name, label, &path).await {
        Ok(()) => Ok(path),
        Err(e) if path.exists() => {
            eprintln!("[imdb] {e}; using cached {name}");
            Ok(path)
        }
        Err(e) => Err(e),
    }
}

fn open_tsv(path: &Path) -> Result<BufReader<GzDecoder<File>>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    Ok(BufReader::with_capacity(1 << 20, GzDecoder::new(file)))
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Rating {
    rating: f32,
    votes: u32,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Episode {
    tconst: String,
    parent: String,
    season: u32,
    episode: u32,
}

#[derive(Debug, Serialize)]
pub struct Lookup {
    ratings: HashMap<String, Rating>,
    /// Every episode of the requested shows (not only the ones in the library), for season averages.
    episodes: Vec<Episode>,
    /// Unix seconds when the ratings file was published/downloaded.
    updated: u64,
}

/// tconst, parentTconst, seasonNumber, episodeNumber — keeps rows whose parent is a requested show.
fn read_episodes(reader: impl BufRead, shows: &HashSet<String>) -> Vec<Episode> {
    let mut out = Vec::new();
    for line in reader.lines().skip(1).map_while(Result::ok) {
        let mut cols = line.split('\t');
        let (Some(tconst), Some(parent), Some(season), Some(episode)) = (cols.next(), cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        if !shows.contains(parent) {
            continue;
        }
        if let (Ok(season), Ok(episode)) = (season.parse(), episode.parse()) {
            out.push(Episode { tconst: tconst.to_owned(), parent: parent.to_owned(), season, episode });
        }
    }
    out
}

/// tconst, averageRating, numVotes — keeps rows for wanted ids.
fn read_ratings(reader: impl BufRead, wanted: &HashSet<&str>) -> HashMap<String, Rating> {
    let mut out = HashMap::new();
    for line in reader.lines().skip(1).map_while(Result::ok) {
        let mut cols = line.split('\t');
        let (Some(tconst), Some(rating), Some(votes)) = (cols.next(), cols.next(), cols.next()) else { continue };
        if !wanted.contains(tconst) {
            continue;
        }
        if let (Ok(rating), Ok(votes)) = (rating.parse(), votes.parse()) {
            out.insert(tconst.to_owned(), Rating { rating, votes });
        }
    }
    out
}

/// Looks up IMDb ratings for movies/shows (`title_ids`) and every episode of `show_ids`.
#[tauri::command]
pub async fn imdb_lookup(app: AppHandle, title_ids: Vec<String>, show_ids: Vec<String>, force: bool) -> Result<Lookup, String> {
    let ratings_path = ensure_dataset(&app, RATINGS_FILE, "ratings", RATINGS_MAX_AGE, force).await?;
    let episodes_path = if show_ids.is_empty() {
        None
    } else {
        Some(ensure_dataset(&app, EPISODES_FILE, "episode list", EPISODES_MAX_AGE, force).await?)
    };
    emit(&app, "Reading IMDb ratings…");
    tauri::async_runtime::spawn_blocking(move || {
        let shows: HashSet<String> = show_ids.into_iter().collect();
        let episodes = match &episodes_path {
            Some(p) => read_episodes(open_tsv(p)?, &shows),
            None => Vec::new(),
        };
        let wanted: HashSet<&str> = title_ids.iter().map(String::as_str).chain(episodes.iter().map(|e| e.tconst.as_str())).collect();
        let ratings = read_ratings(open_tsv(&ratings_path)?, &wanted);
        let updated = std::fs::metadata(&ratings_path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(Lookup { ratings, episodes, updated })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_episodes_and_ratings() {
        let episodes_tsv = "tconst\tparentTconst\tseasonNumber\tepisodeNumber\n\
            tt1\ttt11280740\t1\t1\n\
            tt2\ttt11280740\t1\t2\n\
            tt3\ttt0903747\t1\t1\n\
            tt4\ttt11280740\t\\N\t\\N\n";
        let shows: HashSet<String> = ["tt11280740".to_owned()].into();
        let eps = read_episodes(episodes_tsv.as_bytes(), &shows);
        assert_eq!(eps.iter().map(|e| (e.tconst.as_str(), e.season, e.episode)).collect::<Vec<_>>(), [("tt1", 1, 1), ("tt2", 1, 2)]);

        let ratings_tsv = "tconst\taverageRating\tnumVotes\ntt1\t8.6\t20000\ntt3\t9.0\t50000\ntt0133093\t8.7\t2100000\n";
        let wanted: HashSet<&str> = ["tt1", "tt0133093"].into();
        let r = read_ratings(ratings_tsv.as_bytes(), &wanted);
        assert_eq!(r.len(), 2);
        assert_eq!(r["tt0133093"], Rating { rating: 8.7, votes: 2_100_000 });
    }

    /// Network + real dataset: `cargo test --release -- --ignored real_imdb_dataset --nocapture`
    #[test]
    #[ignore]
    fn real_imdb_dataset() {
        let dir = std::env::temp_dir().join("truongflix-imdb-test");
        std::fs::create_dir_all(&dir).unwrap();
        let get = |name: &str| {
            let path = dir.join(name);
            if !path.exists() {
                let status = std::process::Command::new("curl").args(["-sSfo"]).arg(&path).arg(format!("{BASE_URL}/{name}")).status().unwrap();
                assert!(status.success());
            }
            path
        };
        let t = std::time::Instant::now();
        // Severance (tt11280740), The Matrix (tt0133093)
        let shows: HashSet<String> = ["tt11280740".to_owned()].into();
        let eps = read_episodes(open_tsv(&get(EPISODES_FILE)).unwrap(), &shows);
        let wanted: HashSet<&str> = eps.iter().map(|e| e.tconst.as_str()).chain(["tt0133093", "tt11280740"]).collect();
        let ratings = read_ratings(open_tsv(&get(RATINGS_FILE)).unwrap(), &wanted);
        println!("{} Severance episodes, {} ratings in {:?}", eps.len(), ratings.len(), t.elapsed());
        println!("Matrix: {:?}  Severance: {:?}", ratings.get("tt0133093"), ratings.get("tt11280740"));
        let s1e1 = eps.iter().find(|e| e.season == 1 && e.episode == 1).unwrap();
        println!("Severance S1E1 {} -> {:?}", s1e1.tconst, ratings.get(&s1e1.tconst));
        assert!(eps.len() >= 19 && ratings.contains_key("tt0133093"));
    }
}
