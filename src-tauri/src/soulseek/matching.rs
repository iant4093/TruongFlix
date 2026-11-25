//! Picks the shared folder that really is the album asked for. Search results are grouped by user
//! and folder; a folder only counts when every track of the MusicBrainz tracklist can be paired
//! with one of its audio files (by title, track number and length), and only audio in the chosen
//! format is ever taken from it. Candidates are then ranked by quality and by how soon the person
//! sharing them is likely to send the files.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// What can be downloaded. Nothing outside these extensions is ever fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    /// FLAC only.
    Lossless,
    /// MP3 at 256 kbps or better.
    Mp3,
    /// FLAC, MP3, M4A (AAC/ALAC), Ogg Vorbis or Opus, best first.
    Any,
}

pub const AUDIO: &[&str] = &["flac", "mp3", "m4a", "ogg", "opus"];

/// A track of the release, from MusicBrainz.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WantTrack {
    pub title: String,
    /// Position on its disc (1-based).
    pub position: u32,
    /// Disc number (1-based).
    pub disc: u32,
    pub length_ms: Option<u32>,
}

/// One shared file from a search result.
#[derive(Debug, Clone)]
pub struct Offer {
    pub user: String,
    pub path: String,
    pub size: u64,
    pub bitrate: Option<u32>,
    pub duration: Option<u32>,
    pub bit_depth: Option<u32>,
    pub free_slot: bool,
    pub speed: u32,
}

/// A folder that holds the whole album: which file plays each track, in tracklist order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub user: String,
    pub folder: String,
    pub format: String,
    pub score: f64,
    #[serde(skip)]
    pub files: Vec<Offer>,
}

pub fn extension(path: &str) -> String {
    basename(path).rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

pub fn basename(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rfind(['\\', '/']).map(|i| &path[..i]).unwrap_or("")
}

/// The disc number of a "CD1" / "Disc 2" folder name.
fn disc_folder(name: &str) -> Option<u32> {
    let name = name.trim().to_ascii_lowercase();
    ["cd", "disc", "disk"].iter().find_map(|p| {
        let rest = name.strip_prefix(p)?.trim_start_matches([' ', '_', '-', '.']);
        (!rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())).then(|| rest.parse().ok()).flatten()
    })
}

/// The album's folder: a "CD1"/"Disc 2" subfolder belongs to the folder above it.
fn album_folder(path: &str) -> &str {
    let dir = parent(path);
    if disc_folder(basename(dir)).is_some() { parent(dir) } else { dir }
}

fn format_allowed(ext: &str, offer: &Offer, quality: Quality) -> bool {
    match quality {
        Quality::Lossless => ext == "flac",
        Quality::Mp3 => ext == "mp3" && offer.bitrate.is_none_or(|b| b >= 256),
        Quality::Any => AUDIO.contains(&ext),
    }
}

/// Lowercase words with accents, punctuation and "feat." credits dropped.
pub fn words(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    for word in lower.split(|c: char| !c.is_alphanumeric()) {
        if word.is_empty() {
            continue;
        }
        if matches!(word, "feat" | "ft" | "featuring") {
            break;
        }
        out.push(word.chars().map(fold).collect());
    }
    out
}

fn fold(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        'ý' | 'ÿ' => 'y',
        _ => c,
    }
}

/// The track number a file name starts with: "03 - x", "1-03 x", "103 x" (disc 1, track 3), "A3".
fn leading_number(name: &str) -> Option<(Option<u32>, u32)> {
    let name = name.trim_start();
    let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &name[digits.len()..];
    // "1-03" / "1.03": disc then track.
    if let Some(after) = rest.strip_prefix(['-', '.']) {
        let track: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !track.is_empty() && digits.len() <= 2 {
            return Some((digits.parse().ok(), track.parse().ok()?));
        }
    }
    let n: u32 = digits.parse().ok()?;
    if digits.len() == 3 && n >= 100 {
        return Some((Some(n / 100), n % 100));
    }
    (digits.len() <= 3).then_some((None, n))
}

/// How well a file plays `track` (0 = not at all). Needs the title in the name, or the track
/// number with a matching length.
fn pair_score(track: &WantTrack, offer: &Offer, multi_disc: bool) -> f64 {
    let stem = basename(&offer.path).rsplit_once('.').map(|(s, _)| s).unwrap_or(basename(&offer.path));
    // A clearly different length is never the same recording.
    let length_gap = match (track.length_ms, offer.duration) {
        (Some(ms), Some(s)) => Some((ms as f64 / 1000.0 - s as f64).abs()),
        _ => None,
    };
    if length_gap.is_some_and(|gap| gap > 12.0) {
        return 0.0;
    }
    let title = words(&track.title);
    let name = words(stem);
    let title_hit = if title.is_empty() {
        0.0
    } else {
        title.iter().filter(|w| name.contains(w)).count() as f64 / title.len() as f64
    };
    let number = leading_number(stem);
    let folder_disc = disc_folder(basename(parent(&offer.path)));
    let number_hit = number.is_some_and(|(disc, n)| {
        n == track.position && (!multi_disc || disc.or(folder_disc).is_none_or(|d| d == track.disc))
    });
    let length_hit = length_gap.map(|gap| if gap <= 3.0 { 1.0 } else if gap <= 7.0 { 0.5 } else { 0.0 });
    let title_ok = title_hit >= 0.99 || (title.len() >= 3 && title_hit >= 0.75);
    let number_ok = number_hit && length_hit.unwrap_or(0.0) >= 0.5;
    if !title_ok && !number_ok {
        return 0.0;
    }
    title_hit + if number_hit { 0.5 } else { 0.0 } + length_hit.unwrap_or(0.25)
}

/// Pairs each track with its own file (best pairs first). None unless every track has one.
fn assign(tracks: &[WantTrack], files: &[Offer]) -> Option<(Vec<usize>, f64)> {
    let multi_disc = tracks.iter().any(|t| t.disc > 1);
    let mut pairs = Vec::new();
    for (t, track) in tracks.iter().enumerate() {
        for (f, file) in files.iter().enumerate() {
            let score = pair_score(track, file, multi_disc);
            if score > 0.0 {
                pairs.push((score, t, f));
            }
        }
    }
    pairs.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut chosen = vec![usize::MAX; tracks.len()];
    let mut taken = vec![false; files.len()];
    let mut total = 0.0;
    for (score, t, f) in pairs {
        if chosen[t] == usize::MAX && !taken[f] {
            chosen[t] = f;
            taken[f] = true;
            total += score;
        }
    }
    chosen.iter().all(|&f| f != usize::MAX).then_some((chosen, total / tracks.len().max(1) as f64))
}

/// Every folder that holds the whole album in an allowed format, best first.
pub fn rank(tracks: &[WantTrack], album: &str, offers: &[Offer], quality: Quality) -> Vec<Candidate> {
    if tracks.is_empty() {
        return Vec::new();
    }
    // (user, folder, extension) → files. Formats are never mixed within one album.
    let mut groups: HashMap<(String, String, String), Vec<Offer>> = HashMap::new();
    for offer in offers {
        let ext = extension(&offer.path);
        if !format_allowed(&ext, offer, quality) || offer.size == 0 {
            continue;
        }
        groups.entry((offer.user.clone(), album_folder(&offer.path).to_string(), ext)).or_default().push(offer.clone());
    }
    let album_words = words(album);
    let mut out = Vec::new();
    for ((user, folder, ext), mut files) in groups {
        // A folder of hundreds of songs is a dump, not this album.
        if files.len() > tracks.len() * 2 + 4 {
            continue;
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let Some((chosen, fit)) = assign(tracks, &files) else { continue };
        let sample = &files[chosen[0]];
        let mut score = fit * 40.0;
        score += match ext.as_str() {
            "flac" => 30.0 + if sample.bit_depth.is_some_and(|d| d >= 24) { 3.0 } else { 0.0 },
            "mp3" => match sample.bitrate {
                Some(b) if b >= 320 => 22.0,
                Some(b) if b >= 256 => 15.0,
                Some(_) => 5.0,
                None => 12.0,
            },
            _ => 10.0,
        };
        if sample.free_slot {
            score += 20.0;
        }
        score += (sample.speed as f64 / 1_000_000.0).clamp(0.0, 1.0) * 12.0;
        let folder_words = words(basename(&folder));
        if !album_words.is_empty() && album_words.iter().all(|w| folder_words.contains(w)) {
            score += 8.0;
        }
        // Extra songs (bonus tracks, another edition) are left behind, but fewer is better.
        score -= (files.len() - tracks.len()) as f64 * 1.5;
        out.push(Candidate {
            user,
            folder,
            format: ext,
            score,
            files: chosen.into_iter().map(|f| files[f].clone()).collect(),
        });
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.user.cmp(&b.user)));
    out
}

/// What to type into Soulseek's search: artist and album words, most specific first.
pub fn queries(artist: &str, album: &str) -> Vec<String> {
    let artist_words = words(artist);
    // "(Deluxe Edition)" and the like rarely appear in shared folder names.
    let base = album.split(['(', '[']).next().unwrap_or(album);
    let album_words = words(base);
    let mut out = Vec::new();
    let both: Vec<&str> = artist_words.iter().chain(album_words.iter()).map(String::as_str).collect();
    if !both.is_empty() {
        out.push(both.join(" "));
    }
    // Short or common album names need the artist; long ones can stand alone as a fallback.
    if album_words.len() >= 2 {
        out.push(album_words.join(" "));
    }
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, position: u32, secs: u32) -> WantTrack {
        WantTrack { title: title.into(), position, disc: 1, length_ms: Some(secs * 1000) }
    }

    fn offer(user: &str, path: &str, secs: Option<u32>, bitrate: Option<u32>) -> Offer {
        Offer { user: user.into(), path: path.into(), size: 30_000_000, bitrate, duration: secs, bit_depth: None, free_slot: true, speed: 500_000 }
    }

    fn album() -> Vec<WantTrack> {
        vec![track("Airbag", 1, 284), track("Paranoid Android", 2, 387), track("Subterranean Homesick Alien", 3, 267)]
    }

    #[test]
    fn whole_album_in_one_folder_is_found() {
        let offers = vec![
            offer("a", r"music\Radiohead\OK Computer\01 - Airbag.flac", Some(284), None),
            offer("a", r"music\Radiohead\OK Computer\02 - Paranoid Android.flac", Some(386), None),
            offer("a", r"music\Radiohead\OK Computer\03 - Subterranean Homesick Alien.flac", Some(267), None),
            offer("a", r"music\Radiohead\OK Computer\cover.jpg", None, None),
            offer("a", r"music\Radiohead\OK Computer\setup.exe", None, None),
        ];
        let found = rank(&album(), "OK Computer", &offers, Quality::Any);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].format, "flac");
        // Only the three songs, in tracklist order: never the image or the program.
        let names: Vec<&str> = found[0].files.iter().map(|f| basename(&f.path)).collect();
        assert_eq!(names, ["01 - Airbag.flac", "02 - Paranoid Android.flac", "03 - Subterranean Homesick Alien.flac"]);
    }

    #[test]
    fn a_missing_track_or_wrong_lengths_rule_a_folder_out() {
        let missing = vec![
            offer("a", r"x\OK Computer\01 Airbag.mp3", Some(284), Some(320)),
            offer("a", r"x\OK Computer\02 Paranoid Android.mp3", Some(387), Some(320)),
        ];
        assert!(rank(&album(), "OK Computer", &missing, Quality::Any).is_empty());
        // Same names, different recordings (a live album): lengths far off.
        let live = vec![
            offer("b", r"x\Live\01 Airbag.mp3", Some(320), Some(320)),
            offer("b", r"x\Live\02 Paranoid Android.mp3", Some(450), Some(320)),
            offer("b", r"x\Live\03 Subterranean Homesick Alien.mp3", Some(300), Some(320)),
        ];
        assert!(rank(&album(), "OK Computer", &live, Quality::Any).is_empty());
    }

    #[test]
    fn numbered_files_match_by_number_and_length() {
        let offers = vec![
            offer("a", r"x\Album\track01.flac", Some(285), None),
            offer("a", r"x\Album\track02.flac", Some(388), None),
            offer("a", r"x\Album\track03.flac", Some(266), None),
        ];
        let found = rank(&album(), "OK Computer", &offers, Quality::Lossless);
        // "track01" doesn't start with its number, so these aren't trusted.
        assert!(found.is_empty());
        let offers = vec![
            offer("a", r"x\Album\01.flac", Some(285), None),
            offer("a", r"x\Album\02.flac", Some(388), None),
            offer("a", r"x\Album\03.flac", Some(266), None),
        ];
        assert_eq!(rank(&album(), "OK Computer", &offers, Quality::Lossless).len(), 1);
    }

    #[test]
    fn quality_choice_filters_formats_and_ranks_the_rest() {
        let mut offers = Vec::new();
        for (user, ext, kbps) in [("flac", "flac", None), ("mp3hi", "mp3", Some(320)), ("mp3lo", "mp3", Some(128))] {
            offers.push(offer(user, &format!(r"m\OK Computer\01 - Airbag.{ext}"), Some(284), kbps));
            offers.push(offer(user, &format!(r"m\OK Computer\02 - Paranoid Android.{ext}"), Some(387), kbps));
            offers.push(offer(user, &format!(r"m\OK Computer\03 - Subterranean Homesick Alien.{ext}"), Some(267), kbps));
        }
        let users = |q| rank(&album(), "OK Computer", &offers, q).into_iter().map(|c| c.user).collect::<Vec<_>>();
        assert_eq!(users(Quality::Lossless), ["flac"]);
        assert_eq!(users(Quality::Mp3), ["mp3hi"]);
        assert_eq!(users(Quality::Any), ["flac", "mp3hi", "mp3lo"]);
    }

    #[test]
    fn disc_folders_join_their_album() {
        let tracks = vec![
            WantTrack { title: "One".into(), position: 1, disc: 1, length_ms: Some(200_000) },
            WantTrack { title: "One".into(), position: 1, disc: 2, length_ms: Some(210_000) },
        ];
        let offers = vec![
            offer("a", r"m\Box Set\CD1\01 One.flac", Some(200), None),
            offer("a", r"m\Box Set\CD 2\01 One.flac", Some(210), None),
        ];
        let found = rank(&tracks, "Box Set", &offers, Quality::Any);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].folder, r"m\Box Set");
        assert!(found[0].files[1].path.contains("CD 2"));
    }

    #[test]
    fn free_slots_win_between_equal_copies() {
        let mut offers = Vec::new();
        for (user, slot) in [("busy", false), ("free", true)] {
            for (i, (t, s)) in [("Airbag", 284), ("Paranoid Android", 387), ("Subterranean Homesick Alien", 267)].iter().enumerate() {
                let mut o = offer(user, &format!(r"m\OK Computer\0{} {t}.flac", i + 1), Some(*s), None);
                o.free_slot = slot;
                offers.push(o);
            }
        }
        assert_eq!(rank(&album(), "OK Computer", &offers, Quality::Any)[0].user, "free");
    }

    #[test]
    fn track_numbers_in_names() {
        assert_eq!(leading_number("03 - Song"), Some((None, 3)));
        assert_eq!(leading_number("1-03 Song"), Some((Some(1), 3)));
        assert_eq!(leading_number("203 Song"), Some((Some(2), 3)));
        assert_eq!(leading_number("Song 3"), None);
        assert_eq!(leading_number("2019 Song"), None);
    }

    #[test]
    fn search_words() {
        assert_eq!(queries("Beyoncé", "Lemonade"), ["beyonce lemonade"]);
        assert_eq!(queries("Radiohead", "OK Computer (Collector's Edition)"), ["radiohead ok computer", "ok computer"]);
        assert_eq!(words("Song (feat. Someone)"), ["song"]);
    }
}
