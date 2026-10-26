//! Automatic subtitle sync: lines subtitle timing up with the dialogue in the audio.
//!
//! 1. Decode the soundtrack (mono, 8 kHz) with a headless mpv core and mark 10 ms frames that
//!    look like speech (speech-band energy above an adaptive threshold).
//! 2. Mark the frames where the subtitle file shows text.
//! 3. Cross-correlate the two (FFT) for every plausible frame-rate mismatch and keep the best
//!    offset; only confident matches are applied.
//! 4. Rewrite the timestamps in place (byte-level, so the file's encoding is untouched), keeping
//!    a backup for undo.

use crate::media::{fft, Core};
use crate::player::mpv;
use serde::Serialize;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const RATE: usize = 8000;
/// Activity is compared in 10 ms steps.
const STEP: usize = RATE / 100;
const STEPS_PER_SEC: f64 = 100.0;
/// Largest shift considered (subtitles from a release with a different intro, etc.).
const MAX_OFFSET_S: f64 = 600.0;
/// Common frame-rate mixups: subtitles timed for 25 fps (PAL) on a 23.976 fps video and so on.
const RATIOS: &[f64] = &[1.0, 25.0 / 23.976, 23.976 / 25.0, 25.0 / 24.0, 24.0 / 25.0, 24.0 / 23.976, 23.976 / 24.0];
/// How far the best peak must stand out from the rest of the correlation (in standard deviations).
const MIN_CONFIDENCE: f64 = 6.0;

// ---------------------------------------------------------------------------
// Subtitle files
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    Srt,
    Vtt,
    Ass,
}

fn format_of(path: &Path) -> Option<Format> {
    match path.extension()?.to_string_lossy().to_lowercase().as_str() {
        "srt" => Some(Format::Srt),
        "vtt" => Some(Format::Vtt),
        "ass" | "ssa" => Some(Format::Ass),
        _ => None,
    }
}

/// Parses "HH:MM:SS,mmm", "HH:MM:SS.mmm", "MM:SS.mmm" (VTT) or "H:MM:SS.cc" (ASS) into seconds.
fn parse_time(s: &str) -> Option<f64> {
    let s = s.trim();
    let (hms, frac) = match s.rfind([',', '.']) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let parts: Vec<&str> = hms.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [h, m, s] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        [m, s] => (0.0, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        _ => return None,
    };
    let frac = if frac.is_empty() { 0.0 } else { frac.parse::<f64>().ok()? / 10f64.powi(frac.len() as i32) };
    Some(h * 3600.0 + m * 60.0 + sec + frac)
}

fn format_time(t: f64, format: Format, template: &str) -> String {
    let t = t.max(0.0);
    match format {
        Format::Ass => {
            let cs = (t * 100.0).round() as u64;
            format!("{}:{:02}:{:02}.{:02}", cs / 360_000, (cs / 6000) % 60, (cs / 100) % 60, cs % 100)
        }
        _ => {
            let ms = (t * 1000.0).round() as u64;
            let sep = if format == Format::Srt { ',' } else { '.' };
            // VTT allows "MM:SS.mmm"; keep the short form when the original used it and it fits.
            if format == Format::Vtt && template.trim().matches(':').count() == 1 && ms < 3_600_000 {
                format!("{:02}:{:02}.{:03}", ms / 60_000, (ms / 1000) % 60, ms % 1000)
            } else {
                format!("{:02}:{:02}:{:02}{sep}{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
            }
        }
    }
}

/// Byte range of the start and end times on one line, if it's a cue timing line.
fn timing_ranges(line: &[u8], format: Format) -> Option<[(usize, usize); 2]> {
    match format {
        Format::Srt | Format::Vtt => {
            let arrow = line.windows(3).position(|w| w == b"-->")?;
            let start_begin = line[..arrow].iter().position(|b| !b.is_ascii_whitespace())?;
            let start_end = arrow - line[..arrow].iter().rev().take_while(|b| b.is_ascii_whitespace()).count();
            let after = arrow + 3;
            let end_begin = after + line[after..].iter().position(|b| !b.is_ascii_whitespace())?;
            let end_end = end_begin + line[end_begin..].iter().position(|b| b.is_ascii_whitespace()).unwrap_or(line.len() - end_begin);
            Some([(start_begin, start_end), (end_begin, end_end)])
        }
        Format::Ass => {
            if !line.starts_with(b"Dialogue:") {
                return None;
            }
            // Dialogue: Layer,Start,End,...
            let commas: Vec<usize> = line.iter().enumerate().filter(|(_, b)| **b == b',').map(|(i, _)| i).take(3).collect();
            if commas.len() < 3 {
                return None;
            }
            Some([(commas[0] + 1, commas[1]), (commas[1] + 1, commas[2])])
        }
    }
}

fn split_lines(bytes: &[u8]) -> Vec<&[u8]> {
    bytes.split(|b| *b == b'\n').collect()
}

fn text(bytes: &[u8], (a, b): (usize, usize)) -> String {
    String::from_utf8_lossy(&bytes[a..b]).into_owned()
}

/// Cue (start, end) times in seconds.
fn read_cues(bytes: &[u8], format: Format) -> Vec<(f64, f64)> {
    split_lines(bytes)
        .into_iter()
        .filter_map(|line| {
            let [s, e] = timing_ranges(line, format)?;
            let (start, end) = (parse_time(&text(line, s))?, parse_time(&text(line, e))?);
            (end > start).then_some((start, end))
        })
        .collect()
}

/// Rewrites every cue as `t * ratio + offset`, leaving all other bytes untouched.
fn retime(bytes: &[u8], format: Format, ratio: f64, offset: f64) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 64);
    let lines = split_lines(bytes);
    for (i, line) in lines.iter().enumerate() {
        match timing_ranges(line, format) {
            Some(ranges) => {
                let mut cursor = 0;
                for (a, b) in ranges {
                    out.extend_from_slice(&line[cursor..a]);
                    let original = text(line, (a, b));
                    match parse_time(&original) {
                        Some(t) => out.extend_from_slice(format_time(t * ratio + offset, format, &original).as_bytes()),
                        None => out.extend_from_slice(&line[a..b]),
                    }
                    cursor = b;
                }
                out.extend_from_slice(&line[cursor..]);
            }
            None => out.extend_from_slice(line),
        }
        if i + 1 < lines.len() {
            out.push(b'\n');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Speech activity
// ---------------------------------------------------------------------------

/// Per-10 ms speech likelihood from 8 kHz mono PCM: speech-band (≈200–3400 Hz) energy compared
/// with an adaptive threshold between the quiet and loud parts of the soundtrack.
fn speech_activity(mut pcm: impl Read) -> Vec<f32> {
    let mut energies = Vec::new();
    let mut buf = vec![0u8; STEP * 2 * 100];
    let (mut hp_prev_in, mut hp_prev_out) = (0f32, 0f32);
    let alpha = 0.86f32; // one-pole high-pass ≈ 180 Hz at 8 kHz
    let mut frame_energy = 0f32;
    let mut in_frame = 0usize;
    loop {
        let n = match pcm.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for c in buf[..n - n % 2].chunks_exact(2) {
            let x = i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0;
            let y = alpha * (hp_prev_out + x - hp_prev_in);
            hp_prev_in = x;
            hp_prev_out = y;
            frame_energy += y * y;
            in_frame += 1;
            if in_frame == STEP {
                energies.push((frame_energy / STEP as f32 + 1e-10).log10());
                frame_energy = 0.0;
                in_frame = 0;
            }
        }
    }
    if energies.is_empty() {
        return energies;
    }
    let mut sorted = energies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| sorted[((sorted.len() - 1) as f64 * p) as usize];
    let threshold = pct(0.25) + 0.45 * (pct(0.92) - pct(0.25));
    // Smooth over ~150 ms so short pauses between words don't break up a line.
    let raw: Vec<f32> = energies.iter().map(|e| if *e > threshold { 1.0 } else { 0.0 }).collect();
    let w = 7;
    (0..raw.len())
        .map(|i| {
            let (a, b) = (i.saturating_sub(w), (i + w + 1).min(raw.len()));
            if raw[a..b].iter().sum::<f32>() >= 3.0 { 1.0 } else { 0.0 }
        })
        .collect()
}

fn cue_activity(cues: &[(f64, f64)], ratio: f64, len: usize) -> Vec<f32> {
    let mut v = vec![0f32; len];
    for &(s, e) in cues {
        let (a, b) = ((s * ratio * STEPS_PER_SEC) as usize, ((e * ratio * STEPS_PER_SEC) as usize).min(len));
        for x in v.iter_mut().take(b).skip(a.min(b)) {
            *x = 1.0;
        }
    }
    v
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Alignment {
    /// Seconds to add to every (rescaled) subtitle time.
    pub offset: f64,
    pub ratio: f64,
    /// Peak height in standard deviations above the other candidate shifts.
    pub confidence: f64,
}

/// Best (offset, ratio) to line `cues` up with `speech` (both at 100 steps per second).
pub fn align(speech: &[f32], cues: &[(f64, f64)]) -> Option<Alignment> {
    if speech.len() < 1000 || cues.len() < 5 {
        return None;
    }
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    let a_mean = mean(speech);
    let last_cue = cues.iter().map(|c| c.1).fold(0.0, f64::max);
    let sub_len = ((last_cue * RATIOS.iter().cloned().fold(1.0, f64::max) * STEPS_PER_SEC) as usize + 100).max(speech.len());
    let n = (speech.len() + sub_len).next_power_of_two();
    let max_shift = (MAX_OFFSET_S * STEPS_PER_SEC) as isize;

    let (mut are, mut aim) = (vec![0f32; n], vec![0f32; n]);
    for (i, x) in speech.iter().enumerate() {
        are[i] = x - a_mean;
    }
    fft(&mut are, &mut aim);

    let mut best: Option<Alignment> = None;
    for &ratio in RATIOS {
        let s = cue_activity(cues, ratio, sub_len);
        let s_mean = mean(&s);
        let (mut sre, mut sim) = (vec![0f32; n], vec![0f32; n]);
        for (i, x) in s.iter().enumerate() {
            sre[i] = x - s_mean;
        }
        fft(&mut sre, &mut sim);
        // corr[k] = Σ a[t]·s[t−k]  ⇔  IFFT(A · conj(S)); inverse via conj → FFT → conj.
        let (mut cre, mut cim) = (vec![0f32; n], vec![0f32; n]);
        for i in 0..n {
            let (ar, ai, sr, si) = (are[i], aim[i], sre[i], -sim[i]);
            cre[i] = ar * sr - ai * si;
            cim[i] = -(ar * si + ai * sr);
        }
        fft(&mut cre, &mut cim);
        let corr = |k: isize| cre[k.rem_euclid(n as isize) as usize] / n as f32;
        let values: Vec<(isize, f64)> = (-max_shift..=max_shift).map(|k| (k, corr(k) as f64)).collect();
        let m = values.iter().map(|v| v.1).sum::<f64>() / values.len() as f64;
        let sd = (values.iter().map(|v| (v.1 - m).powi(2)).sum::<f64>() / values.len() as f64).sqrt().max(1e-12);
        let (k, peak) = values.iter().cloned().fold((0, f64::MIN), |acc, v| if v.1 > acc.1 { v } else { acc });
        let candidate = Alignment { offset: k as f64 / STEPS_PER_SEC, ratio, confidence: (peak - m) / sd };
        // Prefer no rescaling: a frame-rate fix must fit clearly better (on short clips the
        // ratios are nearly indistinguishable).
        let score = |a: &Alignment| if a.ratio == 1.0 { a.confidence } else { a.confidence / 1.08 };
        if best.is_none_or(|b| score(&candidate) > score(&b)) {
            best = Some(candidate);
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Audio decode
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct Progress {
    fraction: f64,
}

/// Decodes the whole soundtrack to 8 kHz mono PCM, reporting progress.
fn decode(app: Option<&AppHandle>, video: &str, out: &Path) -> Result<(), String> {
    let file = out.to_string_lossy().into_owned();
    let rate = RATE.to_string();
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
        ("hwdec", "no"),
        ("keep-open", "no"),
    ])?;
    core.api.command(core.h, &["loadfile", video, "replace"])?;
    let started = Instant::now();
    let mut last_report = Instant::now();
    loop {
        let ev = unsafe { &*(core.api.wait_event)(core.h, 0.25) };
        if ev.event_id == mpv::EVENT_END_FILE {
            if !ev.data.is_null() && unsafe { &*(ev.data as *const mpv::EventEndFile) }.reason == mpv::END_FILE_REASON_ERROR {
                return Err("The video’s audio couldn’t be read".into());
            }
            break;
        }
        if ev.event_id == mpv::EVENT_SHUTDOWN || started.elapsed() > Duration::from_secs(30 * 60) {
            return Err("Reading the audio took too long".into());
        }
        if last_report.elapsed() > Duration::from_millis(400) {
            last_report = Instant::now();
            let num = |n: &str| core.get(n).and_then(|v| v.parse::<f64>().ok());
            if let (Some(app), Some(pos), Some(dur)) = (app, num("time-pos"), num("duration")) {
                let _ = app.emit("subsync-progress", Progress { fraction: (pos / dur.max(1.0)).clamp(0.0, 1.0) * 0.9 });
            }
        }
    }
    drop(core); // flushes the PCM file
    Ok(())
}

fn backup_path(sub: &Path) -> PathBuf {
    let mut name = sub.file_name().unwrap_or_default().to_os_string();
    name.push(".tfx-orig");
    sub.with_file_name(name)
}

#[derive(Debug, Serialize)]
pub struct SyncResult {
    offset: f64,
    ratio: f64,
    confidence: f64,
    applied: bool,
    message: String,
}

fn sync_inner(app: Option<&AppHandle>, video: &str, sub: &Path, tmp: &Path) -> Result<SyncResult, String> {
    let format = format_of(sub).ok_or("Only SRT, VTT and ASS subtitle files can be synced")?;
    let bytes = std::fs::read(sub).map_err(|e| e.to_string())?;
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err("UTF-16 subtitle files aren’t supported".into());
    }
    let cues = read_cues(&bytes, format);
    if cues.len() < 5 {
        return Err("The subtitle file has too few lines to sync".into());
    }
    decode(app, video, tmp)?;
    let speech = speech_activity(BufReader::new(std::fs::File::open(tmp).map_err(|e| e.to_string())?));
    let _ = std::fs::remove_file(tmp);
    let best = align(&speech, &cues).ok_or("Not enough dialogue to compare")?;
    let rescaled = (best.ratio - 1.0).abs() > 1e-6;
    let mut result = SyncResult { offset: best.offset, ratio: best.ratio, confidence: best.confidence, applied: false, message: String::new() };
    if best.confidence < MIN_CONFIDENCE {
        result.message = "Couldn’t find a confident match between the subtitles and the dialogue".into();
    } else if best.offset.abs() < 0.08 && !rescaled {
        result.message = "Subtitles are already in sync".into();
    } else {
        let backup = backup_path(sub);
        if !backup.exists() {
            std::fs::copy(sub, &backup).map_err(|e| e.to_string())?;
        }
        std::fs::write(sub, retime(&bytes, format, best.ratio, best.offset)).map_err(|e| e.to_string())?;
        result.applied = true;
        result.message = if rescaled { format!("Retimed for a different frame rate and shifted {:+.1} s", best.offset) } else { format!("Shifted {:+.1} s", best.offset) };
    }
    Ok(result)
}

/// Lines a subtitle file up with the video's dialogue (rewriting it in place, with a backup).
#[tauri::command]
pub async fn sync_subtitle(app: AppHandle, video_path: String, subtitle_path: String) -> Result<SyncResult, String> {
    let tmp = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("subsync.pcm");
    if let Some(dir) = tmp.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let res = sync_inner(Some(&app), &video_path, Path::new(&subtitle_path), &tmp);
        let _ = app.emit("subsync-progress", Progress { fraction: 1.0 });
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restores the subtitle file as it was before the first sync.
#[tauri::command]
pub fn undo_subtitle_sync(subtitle_path: String) -> Result<bool, String> {
    let sub = Path::new(&subtitle_path);
    let backup = backup_path(sub);
    if !backup.exists() {
        return Ok(false);
    }
    std::fs::rename(&backup, sub).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn subtitle_sync_backup_exists(subtitle_path: String) -> bool {
    backup_path(Path::new(&subtitle_path)).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRT: &str = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000 X1:10\r\nWorld\r\n";

    #[test]
    fn parses_and_retimes_srt_vtt_ass_keeping_other_bytes() {
        let cues = read_cues(SRT.as_bytes(), Format::Srt);
        assert_eq!(cues, vec![(1.0, 2.5), (62.25, 64.0)]);
        let out = String::from_utf8(retime(SRT.as_bytes(), Format::Srt, 1.0, 1.5)).unwrap();
        assert_eq!(out, SRT.replace("00:00:01,000 --> 00:00:02,500", "00:00:02,500 --> 00:00:04,000").replace("00:01:02,250 --> 00:01:04,000", "00:01:03,750 --> 00:01:05,500"));

        let vtt = "WEBVTT\n\n01:02.500 --> 01:04.000 align:start\nHi\n";
        assert_eq!(read_cues(vtt.as_bytes(), Format::Vtt), vec![(62.5, 64.0)]);
        let out = String::from_utf8(retime(vtt.as_bytes(), Format::Vtt, 1.0, -2.0)).unwrap();
        assert_eq!(out, "WEBVTT\n\n01:00.500 --> 01:02.000 align:start\nHi\n");

        let ass = "[Events]\nDialogue: 0,0:00:10.50,0:00:12.00,Default,,0,0,0,,Text, with comma\n";
        assert_eq!(read_cues(ass.as_bytes(), Format::Ass), vec![(10.5, 12.0)]);
        let out = String::from_utf8(retime(ass.as_bytes(), Format::Ass, 1.0, 0.25)).unwrap();
        assert_eq!(out, "[Events]\nDialogue: 0,0:00:10.75,0:00:12.25,Default,,0,0,0,,Text, with comma\n");

        // Non-UTF-8 text (Windows-1252 "é") survives untouched.
        let mut latin = b"1\n00:00:01,000 --> 00:00:02,000\nCaf".to_vec();
        latin.push(0xE9);
        let out = retime(&latin, Format::Srt, 1.0, 1.0);
        assert_eq!(*out.last().unwrap(), 0xE9);
    }

    /// Deterministic pseudo-random "dialogue": 1–4 s lines separated by 0.5–6 s gaps.
    fn dialogue(seconds: f64, seed: u64) -> Vec<(f64, f64)> {
        let mut state = seed;
        let mut rnd = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 33) as f64 / (1u64 << 31) as f64
        };
        let (mut t, mut out) = (5.0, Vec::new());
        while t < seconds - 10.0 {
            let len = 1.0 + rnd() * 3.0;
            out.push((t, t + len));
            t += len + 0.5 + rnd() * 5.5;
        }
        out
    }

    #[test]
    fn finds_offsets_and_frame_rate_mismatches() {
        let truth = dialogue(1500.0, 3);
        let mut speech = cue_activity(&truth, 1.0, 150_000);
        // Noise: miss some speech and add false detections (music, effects).
        for (i, x) in speech.iter_mut().enumerate() {
            if i % 97 < 9 {
                *x = 1.0 - *x;
            }
        }
        // Subtitles 4.3 s late.
        let late: Vec<(f64, f64)> = truth.iter().map(|(s, e)| (s + 4.3, e + 4.3)).collect();
        let a = align(&speech, &late).unwrap();
        assert!((a.offset + 4.3).abs() < 0.05 && a.ratio == 1.0, "{a:?}");
        assert!(a.confidence > MIN_CONFIDENCE, "{a:?}");
        // Timed for 25 fps on a 23.976 fps video, plus 2 s early.
        let pal: Vec<(f64, f64)> = truth.iter().map(|(s, e)| (s * 23.976 / 25.0 - 2.0, e * 23.976 / 25.0 - 2.0)).collect();
        let a = align(&speech, &pal).unwrap();
        assert!((a.ratio - 25.0 / 23.976).abs() < 1e-9, "{a:?}");
        assert!((a.offset - 2.0 * 25.0 / 23.976).abs() < 0.1, "{a:?}");
        // Unrelated subtitles: low confidence.
        let other = dialogue(1500.0, 99);
        let a = align(&speech, &other).unwrap();
        assert!(a.confidence < MIN_CONFIDENCE, "{a:?}");
    }

    /// Real pipeline: `TRUONGFLIX_SUBSYNC_TEST="video.mkv|subs.srt" cargo test -- --ignored real_subsync --nocapture`
    #[test]
    #[ignore]
    fn real_subsync() {
        let spec = std::env::var("TRUONGFLIX_SUBSYNC_TEST").expect("set TRUONGFLIX_SUBSYNC_TEST");
        let (video, sub) = spec.split_once('|').unwrap();
        let tmp = std::env::temp_dir().join("truongflix-subsync.pcm");
        let copy = std::env::temp_dir().join(format!("truongflix-subsync-test.{}", Path::new(sub).extension().unwrap().to_string_lossy()));
        std::fs::copy(sub, &copy).unwrap();
        let t = Instant::now();
        let res = sync_inner(None, video, &copy, &tmp).unwrap();
        println!("{res:?} in {:?}", t.elapsed());
        let _ = std::fs::remove_file(backup_path(&copy));
    }
}
