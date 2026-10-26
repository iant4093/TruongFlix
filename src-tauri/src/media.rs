//! Background media analysis with hidden libmpv cores (no window, no audio output):
//! - `media_probe`: real stream info (resolution, codecs, HDR/Dolby Vision, audio, chapters)
//! - `extract_frames`: JPEG stills for scrub-bar thumbnails and hover cards
//! - `detect_intros`: finds the opening shared by a season's episodes from their audio

use crate::player::mpv::{self, Handle};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Options that keep a background core silent and script-free.
const BASE: &[(&str, &str)] = &[
    ("config", "no"),
    ("terminal", "no"),
    ("msg-level", "all=no"),
    ("idle", "yes"),
    ("osc", "no"),
    ("load-scripts", "no"),
    ("ytdl", "no"),
    ("load-auto-profiles", "no"),
    ("load-commands", "no"),
    ("load-console", "no"),
    ("load-osd-console", "no"),
    ("load-context-menu", "no"),
    ("load-positioning", "no"),
    ("load-select", "no"),
    ("load-stats-overlay", "no"),
    ("input-default-bindings", "no"),
    ("sub-auto", "no"),
    ("audio-file-auto", "no"),
];

/// A headless mpv core, destroyed on drop.
pub(crate) struct Core {
    pub(crate) api: &'static mpv::Api,
    pub(crate) h: *mut Handle,
}

impl Core {
    pub(crate) fn new(options: &[(&str, &str)]) -> Result<Self, String> {
        let api = mpv::api()?;
        let h = unsafe { (api.create)() };
        if h.is_null() {
            return Err("libmpv could not be initialized".into());
        }
        for (k, v) in BASE.iter().chain(options) {
            let _ = api.set_option(h, k, v);
        }
        if let Err(e) = api.check(unsafe { (api.initialize)(h) }, "mpv initialize") {
            unsafe { (api.terminate_destroy)(h) };
            return Err(e);
        }
        Ok(Core { api, h })
    }

    pub(crate) fn get(&self, name: &str) -> Option<String> {
        self.api.get_property(self.h, name)
    }

    /// Waits for one of `ids`; returns the matching event id, or None on timeout / file error.
    pub(crate) fn wait_for(&self, ids: &[i32], timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let ev = unsafe { &*(self.api.wait_event)(self.h, 0.2) };
            if ids.contains(&ev.event_id) {
                return Some(ev.event_id);
            }
            if ev.event_id == mpv::EVENT_END_FILE && !ev.data.is_null() {
                let end = unsafe { &*(ev.data as *const mpv::EventEndFile) };
                if end.reason == mpv::END_FILE_REASON_ERROR && !ids.contains(&mpv::EVENT_END_FILE) {
                    return None;
                }
            }
            if ev.event_id == mpv::EVENT_SHUTDOWN {
                return None;
            }
        }
        None
    }

    /// Stops the current file and waits until the core is idle again.
    fn reset(&self) {
        let _ = self.api.command(self.h, &["stop"]);
        self.wait_for(&[mpv::EVENT_IDLE], Duration::from_secs(5));
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        unsafe { (self.api.terminate_destroy)(self.h) };
    }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Default)]
pub struct AudioTrack {
    lang: Option<String>,
    title: Option<String>,
    codec: Option<String>,
    profile: Option<String>,
    channels: Option<i64>,
    default: bool,
}

#[derive(Debug, Serialize, Default)]
pub struct SubTrack {
    lang: Option<String>,
    title: Option<String>,
    codec: Option<String>,
    forced: bool,
}

#[derive(Debug, Serialize)]
pub struct Chapter {
    title: String,
    time: f64,
}

#[derive(Debug, Serialize, Default)]
pub struct MediaInfo {
    duration: f64,
    width: i64,
    height: i64,
    video_codec: Option<String>,
    video_profile: Option<String>,
    /// Transfer function: "pq" (HDR10 / Dolby Vision), "hlg", "bt.1886" (SDR), …
    gamma: Option<String>,
    primaries: Option<String>,
    dv_profile: Option<i64>,
    /// File size in bytes.
    size: Option<u64>,
    /// Whether the end of the file could be decoded (false = truncated / incomplete download).
    tail_ok: Option<bool>,
    /// Set when the file exists but can't be opened or decoded at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    audio: Vec<AudioTrack>,
    subs: Vec<SubTrack>,
    chapters: Vec<Chapter>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_owned)
}

fn probe_one(core: &Core, path: &str) -> Option<MediaInfo> {
    core.api.command(core.h, &["loadfile", path, "replace"]).ok()?;
    // Paused playback still decodes the first audio/video frames (needed for codec profiles
    // and HDR parameters), then fires PLAYBACK_RESTART.
    let ok = core.wait_for(&[mpv::EVENT_PLAYBACK_RESTART], Duration::from_secs(20)).is_some();
    let info = ok.then(|| {
        let tracks: Vec<Value> = core.get("track-list").and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        let chapters: Vec<Value> = core.get("chapter-list").and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        let video = tracks.iter().find(|t| s(t, "type").as_deref() == Some("video") && !t["albumart"].as_bool().unwrap_or(false));
        let num = |name: &str| core.get(name).and_then(|v| v.parse::<f64>().ok());
        let mut info = MediaInfo {
            duration: num("duration").unwrap_or(0.0),
            width: num("video-params/w").map(|v| v as i64).or_else(|| video.and_then(|v| v["demux-w"].as_i64())).unwrap_or(0),
            height: num("video-params/h").map(|v| v as i64).or_else(|| video.and_then(|v| v["demux-h"].as_i64())).unwrap_or(0),
            video_codec: video.and_then(|v| s(v, "codec")),
            video_profile: video.and_then(|v| s(v, "codec-profile")),
            gamma: core.get("video-params/gamma"),
            primaries: core.get("video-params/primaries"),
            dv_profile: video.and_then(|v| v["dolby-vision-profile"].as_i64()),
            ..Default::default()
        };
        for t in &tracks {
            match s(t, "type").as_deref() {
                Some("audio") => info.audio.push(AudioTrack {
                    lang: s(t, "lang"),
                    title: s(t, "title"),
                    codec: s(t, "codec"),
                    profile: s(t, "codec-profile").or_else(|| s(t, "codec-desc")),
                    channels: t["demux-channel-count"].as_i64().or_else(|| t["audio-channels"].as_i64()),
                    default: t["default"].as_bool().unwrap_or(false) || t["selected"].as_bool().unwrap_or(false),
                }),
                Some("sub") => info.subs.push(SubTrack {
                    lang: s(t, "lang"),
                    title: s(t, "title"),
                    codec: s(t, "codec"),
                    forced: t["forced"].as_bool().unwrap_or(false),
                }),
                _ => {}
            }
        }
        info.chapters = chapters
            .iter()
            .map(|c| Chapter { title: s(c, "title").unwrap_or_default(), time: c["time"].as_f64().unwrap_or(0.0) })
            .collect();
        info
    });
    let info = info.map(|mut info| {
        info.tail_ok = tail_decodes(core, info.duration);
        info
    });
    core.reset();
    info
}

/// Seeks near the end: a truncated file (interrupted download) runs out of data and ends instead
/// of decoding a frame there. None when it can't be told (very short file, timeout).
fn tail_decodes(core: &Core, duration: f64) -> Option<bool> {
    if duration < 30.0 {
        return None;
    }
    let target = format!("{:.3}", duration - 10.0);
    core.api.command(core.h, &["seek", &target, "absolute"]).ok()?;
    match core.wait_for(&[mpv::EVENT_PLAYBACK_RESTART, mpv::EVENT_END_FILE], Duration::from_secs(15))? {
        id if id == mpv::EVENT_PLAYBACK_RESTART => {
            // Some demuxers "restart" at the last packet they have; make sure we really got there.
            let pos = core.get("time-pos").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            Some(pos >= duration - 60.0)
        }
        _ => Some(false),
    }
}

/// Reads real stream info for each file (None when a file can't be opened).
#[tauri::command]
pub async fn media_probe(paths: Vec<String>) -> Result<Vec<Option<MediaInfo>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let core = Core::new(&[("vo", "null"), ("ao", "null"), ("pause", "yes"), ("hwdec", "no"), ("sid", "no")])?;
        Ok(paths
            .iter()
            .map(|p| {
                // Missing files (offline drive) are None; unreadable ones carry an error.
                let size = std::fs::metadata(p).ok().filter(|m| m.is_file())?.len();
                let mut info = probe_one(&core, p).unwrap_or_else(|| MediaInfo {
                    error: Some(if size == 0 { "empty file".into() } else { "couldn’t be opened or decoded".into() }),
                    ..Default::default()
                });
                info.size = Some(size);
                Some(info)
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/// Monotonic job counter per lane ("scrub", "stills"): starting a new job cancels the previous one.
static LANES: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn bump_lane(lane: &str) -> u64 {
    let mut map = LANES.lock().unwrap();
    let entry = map.get_or_insert_with(HashMap::new).entry(lane.to_owned()).or_insert(0);
    *entry += 1;
    *entry
}

fn lane_is(lane: &str, generation: u64) -> bool {
    LANES.lock().unwrap().as_ref().and_then(|m| m.get(lane)).copied() == Some(generation)
}

#[derive(Clone, Serialize)]
struct FrameReady {
    lane: String,
    key: String,
    index: usize,
    time: f64,
    path: String,
}

fn grab_frame(core: &Core, video: &str, time: f64, tmp: &Path, dest: &Path) -> bool {
    let _ = std::fs::remove_dir_all(tmp);
    if std::fs::create_dir_all(tmp).is_err() {
        return false;
    }
    let _ = core.api.set_property(core.h, "vo-image-outdir", &tmp.to_string_lossy());
    let _ = core.api.set_property(core.h, "start", &format!("{time:.3}"));
    if core.api.command(core.h, &["loadfile", video, "replace"]).is_err() {
        return false;
    }
    core.wait_for(&[mpv::EVENT_END_FILE], Duration::from_secs(20));
    let written = std::fs::read_dir(tmp)
        .ok()
        .and_then(|mut d| d.find_map(|e| e.ok().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jpg"))));
    match written {
        Some(file) => std::fs::rename(&file, dest).or_else(|_| std::fs::copy(&file, dest).map(|_| ())).is_ok(),
        None => false,
    }
}

/// Extracts JPEG frames at `times` into the app cache (`frames/<key>/<width>_<ms>.jpg`), emitting
/// `frame-ready` for each one as it lands. Cached frames are returned immediately.
#[tauri::command]
pub async fn extract_frames(
    app: AppHandle,
    path: String,
    key: String,
    times: Vec<f64>,
    width: u32,
    lane: String,
) -> Result<Vec<Option<String>>, String> {
    let generation = bump_lane(&lane);
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("frames").join(sanitize(&key));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dests: Vec<PathBuf> = times.iter().map(|t| dir.join(format!("{width}_{}.jpg", (t * 1000.0).round() as i64))).collect();
        let mut out: Vec<Option<String>> = dests.iter().map(|d| d.is_file().then(|| d.to_string_lossy().into_owned())).collect();
        let missing: Vec<usize> = (0..dests.len()).filter(|&i| out[i].is_none()).collect();
        for (i, p) in out.iter().enumerate() {
            if let Some(p) = p {
                let _ = app.emit("frame-ready", FrameReady { lane: lane.clone(), key: key.clone(), index: i, time: times[i], path: p.clone() });
            }
        }
        if missing.is_empty() || !Path::new(&path).is_file() {
            return Ok(out);
        }
        let scale = format!("scale={width}:-2");
        let core = Core::new(&[
            ("vo", "image"),
            ("vo-image-format", "jpg"),
            ("vo-image-jpeg-quality", "72"),
            ("audio", "no"),
            ("sid", "no"),
            ("frames", "1"),
            ("hr-seek", "no"),
            ("hwdec", "auto-copy-safe"),
            ("vf", &scale),
        ])?;
        let tmp = dir.join(format!(".tmp-{lane}"));
        for i in missing {
            if !lane_is(&lane, generation) {
                break; // superseded by a newer request
            }
            if grab_frame(&core, &path, times[i], &tmp, &dests[i]) {
                let p = dests[i].to_string_lossy().into_owned();
                let _ = app.emit("frame-ready", FrameReady { lane: lane.clone(), key: key.clone(), index: i, time: times[i], path: p.clone() });
                out[i] = Some(p);
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sanitize(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(80).collect()
}

// ---------------------------------------------------------------------------
// Intro detection (audio fingerprints)
// ---------------------------------------------------------------------------

pub const SAMPLE_RATE: usize = 5512;
const FRAME: usize = 2048;
const HOP: usize = 256;
pub const FPS: f64 = SAMPLE_RATE as f64 / HOP as f64; // ≈ 21.5 fingerprints per second
const BANDS: usize = 33;
const MAX_BIT_ERRORS: u32 = 10;
/// Frames too quiet to fingerprint (silence would "match" across any two episodes).
const SILENT: u32 = u32::MAX;
const MIN_INTRO_S: f64 = 15.0;
const MAX_INTRO_S: f64 = 150.0;

pub(crate) fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
        len <<= 1;
    }
}

/// 32-bit sub-fingerprint per hop from energy differences across 33 log-spaced bands (300–2000 Hz).
pub fn fingerprint(samples: &[i16]) -> Vec<u32> {
    if samples.len() < FRAME * 2 {
        return Vec::new();
    }
    let edges: Vec<usize> = (0..=BANDS)
        .map(|b| {
            let f = 300.0 * (2000.0f64 / 300.0).powf(b as f64 / BANDS as f64);
            (f * FRAME as f64 / SAMPLE_RATE as f64).round() as usize
        })
        .collect();
    let window: Vec<f32> =
        (0..FRAME).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FRAME - 1) as f32).cos()).collect();
    let (mut re, mut im) = (vec![0f32; FRAME], vec![0f32; FRAME]);
    let mut prev: Option<[f32; BANDS]> = None;
    let mut out = Vec::with_capacity(samples.len() / HOP);
    let mut pos = 0;
    while pos + FRAME <= samples.len() {
        let mut energy_total = 0.0f32;
        for i in 0..FRAME {
            let x = samples[pos + i] as f32 / 32768.0;
            energy_total += x * x;
            re[i] = x * window[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        let mut bands = [0f32; BANDS];
        for (b, band) in bands.iter_mut().enumerate() {
            *band = (edges[b]..edges[b + 1].max(edges[b] + 1)).map(|k| re[k] * re[k] + im[k] * im[k]).sum::<f32>();
        }
        let rms = (energy_total / FRAME as f32).sqrt();
        let fp = match prev {
            Some(p) if rms > 0.003 => {
                let mut bits = 0u32;
                for m in 0..BANDS - 1 {
                    if (bands[m] - bands[m + 1]) - (p[m] - p[m + 1]) > 0.0 {
                        bits |= 1 << m;
                    }
                }
                bits
            }
            _ => SILENT,
        };
        if prev.is_some() {
            out.push(fp);
        }
        prev = Some(bands);
        pos += HOP;
    }
    out
}

/// Chance matches (≈2.5% of frames) can extend a run past the real shared audio. Trims hits from
/// both ends until each edge sits in a dense neighbourhood (≥ 30% matches within ±1 s).
/// Returns (first, last, hit count).
fn trim_run(hits: &[isize]) -> Option<(isize, isize, isize)> {
    let window = FPS as isize;
    let need = (window * 2 * 3 / 10) as usize; // 30% of a 2 s window
    let dense = |idx: usize| {
        let c = hits[idx];
        let lo = hits.partition_point(|&h| h < c - window);
        let hi = hits.partition_point(|&h| h <= c + window);
        hi - lo >= need
    };
    let first = (0..hits.len()).find(|&i| dense(i))?;
    let last = (first..hits.len()).rev().find(|&i| dense(i))?;
    Some((hits[first], hits[last], (last - first + 1) as isize))
}

/// Longest stretch of audio shared by two fingerprints: (a_start, a_end, b_start, b_end) seconds.
pub fn shared_segment(a: &[u32], b: &[u32]) -> Option<(f64, f64, f64, f64)> {
    let gap_allowed = (FPS * 1.5) as isize;
    let min_len = (FPS * MIN_INTRO_S) as isize;
    let max_len = (FPS * MAX_INTRO_S) as isize;
    let (na, nb) = (a.len() as isize, b.len() as isize);
    let mut best: Option<(isize, isize, isize)> = None; // (start_a, end_a, shift)
    for shift in -(nb - 1)..na {
        let (lo, hi) = (shift.max(0), na.min(nb + shift));
        if hi - lo < min_len {
            continue;
        }
        let hits: Vec<isize> = (lo..hi)
            .filter(|&i| {
                let (x, y) = (a[i as usize], b[(i - shift) as usize]);
                x != SILENT && y != SILENT && (x ^ y).count_ones() <= MAX_BIT_ERRORS
            })
            .collect();
        if (hits.len() as isize) < min_len * 4 / 10 {
            continue; // can't possibly contain a long-enough dense run
        }
        // Split into runs at gaps, then evaluate each.
        let mut start = 0;
        for k in 1..=hits.len() {
            if k == hits.len() || hits[k] - hits[k - 1] > gap_allowed {
                if let Some((s, e, n)) = trim_run(&hits[start..k]) {
                    let len = e - s + 1;
                    if len >= min_len && len <= max_len && n * 10 >= len * 4 && best.is_none_or(|(bs, be, _)| len > be - bs + 1) {
                        best = Some((s, e, shift));
                    }
                }
                start = k;
            }
        }
    }
    best.map(|(s, e, shift)| {
        let t = |f: isize| f as f64 / FPS;
        (t(s), t(e + 1), t(s - shift), t(e + 1 - shift))
    })
}

/// Decodes the first `seconds` of audio to mono 16-bit PCM at `SAMPLE_RATE`.
fn decode_audio(path: &str, seconds: f64, tmp: &Path) -> Option<Vec<i16>> {
    let file = tmp.to_string_lossy().into_owned();
    let end = format!("{seconds:.0}");
    let rate = SAMPLE_RATE.to_string();
    let core = Core::new(&[
        ("vo", "null"),
        ("vid", "no"),
        ("sid", "no"),
        ("ao", "pcm"),
        ("ao-pcm-file", &file),
        ("ao-pcm-waveheader", "no"),
        ("audio-format", "s16"),
        ("audio-channels", "mono"),
        ("audio-samplerate", &rate),
        ("untimed", "yes"),
        ("end", &end),
        ("hwdec", "no"),
        ("keep-open", "no"),
    ])
    .ok()?;
    core.api.command(core.h, &["loadfile", path, "replace"]).ok()?;
    core.wait_for(&[mpv::EVENT_END_FILE], Duration::from_secs(300))?;
    drop(core); // flushes and closes the PCM file
    let bytes = std::fs::read(tmp).ok()?;
    let _ = std::fs::remove_file(tmp);
    Some(bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect())
}

#[derive(Clone, Serialize)]
struct IntroProgress {
    done: usize,
    total: usize,
}

/// For a season's episodes (in order), returns each episode's intro as [start, end] seconds.
/// Each episode is compared with its neighbours; the longest shared segment wins.
#[tauri::command]
pub async fn detect_intros(app: AppHandle, paths: Vec<String>, window_seconds: f64) -> Result<Vec<Option<[f64; 2]>>, String> {
    let tmp_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("intro-analysis");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let prints: Vec<Vec<u32>> = paths
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let fp = decode_audio(p, window_seconds, &tmp_dir.join(format!("{i}.pcm"))).map(|s| fingerprint(&s)).unwrap_or_default();
                let _ = app.emit("intro-progress", IntroProgress { done: i + 1, total });
                fp
            })
            .collect();
        let mut result: Vec<Option<[f64; 2]>> = vec![None; total];
        for i in 0..total.saturating_sub(1) {
            if let Some((a0, a1, b0, b1)) = shared_segment(&prints[i], &prints[i + 1]) {
                for (idx, seg) in [(i, [a0, a1]), (i + 1, [b0, b1])] {
                    if result[idx].is_none_or(|r| seg[1] - seg[0] > r[1] - r[0]) {
                        result[idx] = Some(seg);
                    }
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random "audio": a sequence of short notes with varying pitch.
    fn melody(seconds: f64, seed: u64) -> Vec<i16> {
        let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut next = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 33) as f64 / (1u64 << 31) as f64
        };
        let n = (seconds * SAMPLE_RATE as f64) as usize;
        let mut out = Vec::with_capacity(n);
        let (mut f1, mut f2, mut left) = (440.0, 660.0, 0usize);
        for i in 0..n {
            if left == 0 {
                f1 = 250.0 + next() * 1500.0;
                f2 = 300.0 + next() * 1400.0;
                left = (SAMPLE_RATE as f64 * (0.12 + next() * 0.3)) as usize;
            }
            left -= 1;
            let t = i as f64 / SAMPLE_RATE as f64;
            let v = 0.3 * (2.0 * std::f64::consts::PI * f1 * t).sin() + 0.2 * (2.0 * std::f64::consts::PI * f2 * t).sin() + 0.05 * (next() - 0.5);
            out.push((v * 20000.0) as i16);
        }
        out
    }

    fn episode(cold_open: f64, intro: &[i16], after: f64, seed: u64) -> Vec<i16> {
        let mut v = melody(cold_open, seed);
        v.extend_from_slice(intro);
        v.extend(melody(after, seed + 100));
        v
    }

    #[test]
    fn finds_shared_intro_at_different_offsets() {
        let intro = melody(40.0, 7);
        let a = fingerprint(&episode(25.0, &intro, 60.0, 1));
        let b = fingerprint(&episode(70.0, &intro, 40.0, 2));
        let (a0, a1, b0, b1) = shared_segment(&a, &b).expect("intro not found");
        assert!((a0 - 25.0).abs() < 1.5 && (a1 - 65.0).abs() < 1.5, "a: {a0:.1}–{a1:.1}");
        assert!((b0 - 70.0).abs() < 1.5 && (b1 - 110.0).abs() < 1.5, "b: {b0:.1}–{b1:.1}");
    }

    #[test]
    fn unrelated_audio_and_silence_do_not_match() {
        let a = fingerprint(&melody(120.0, 11));
        let b = fingerprint(&melody(120.0, 12));
        assert_eq!(shared_segment(&a, &b), None);
        let silence = vec![0i16; SAMPLE_RATE * 60];
        assert_eq!(shared_segment(&fingerprint(&silence), &fingerprint(&silence)), None);
    }

    /// `TRUONGFLIX_PROBE_TEST=file.mkv cargo test -- --ignored real_probe --nocapture`
    #[test]
    #[ignore]
    fn real_probe_and_frames() {
        let path = std::env::var("TRUONGFLIX_PROBE_TEST").expect("set TRUONGFLIX_PROBE_TEST");
        let core = Core::new(&[("vo", "null"), ("ao", "null"), ("pause", "yes"), ("hwdec", "no"), ("sid", "no")]).unwrap();
        let t = Instant::now();
        let info = probe_one(&core, &path).expect("probe failed");
        println!("probe {:?}: {}", t.elapsed(), serde_json::to_string(&info).unwrap());
        let again = probe_one(&core, &path).expect("second probe on the same core failed");
        assert_eq!(again.width, info.width);

        let frames = Core::new(&[
            ("vo", "image"), ("vo-image-format", "jpg"), ("audio", "no"), ("sid", "no"),
            ("frames", "1"), ("hr-seek", "no"), ("vf", "scale=320:-2"),
        ])
        .unwrap();
        let dir = std::env::temp_dir().join("truongflix-frames-test");
        std::fs::create_dir_all(&dir).unwrap();
        let t = Instant::now();
        for (i, at) in [2.0, 8.0, 15.0].iter().enumerate() {
            let dest = dir.join(format!("{i}.jpg"));
            assert!(grab_frame(&frames, &path, *at, &dir.join("tmp"), &dest), "frame {i} failed");
            assert!(std::fs::metadata(&dest).unwrap().len() > 1000);
        }
        println!("3 frames in {:?} → {}", t.elapsed(), dir.display());
    }

    /// Full pipeline through libmpv on real files:
    /// `TRUONGFLIX_INTRO_TEST="a.mkv|b.mkv" cargo test --release -- --ignored real_intro --nocapture`
    #[test]
    #[ignore]
    fn real_intro_detection() {
        let files = std::env::var("TRUONGFLIX_INTRO_TEST").expect("set TRUONGFLIX_INTRO_TEST");
        let paths: Vec<&str> = files.split('|').collect();
        let tmp = std::env::temp_dir().join("truongflix-intro-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let t = Instant::now();
        let prints: Vec<Vec<u32>> =
            paths.iter().enumerate().map(|(i, p)| fingerprint(&decode_audio(p, 420.0, &tmp.join(format!("{i}.pcm"))).unwrap())).collect();
        println!("decoded + fingerprinted {} files in {:?}", paths.len(), t.elapsed());
        for w in prints.windows(2) {
            println!("shared: {:?}", shared_segment(&w[0], &w[1]).map(|(a, b, c, d)| format!("{a:.1}–{b:.1} / {c:.1}–{d:.1}")));
        }
    }
}
