//! Picks the shared folder that really is the album asked for. Search results are grouped by user
//! and folder; a folder only counts when every track of the album's tracklist can be paired
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

/// A track of the release, from the catalogue.
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
pub fn album_folder(path: &str) -> &str {
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

/// Pairs each track with its own file (best pairs first): the file for each track, if any.
fn pairs(tracks: &[WantTrack], files: &[Offer]) -> (Vec<Option<usize>>, f64) {
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
    (chosen.into_iter().map(|f| (f != usize::MAX).then_some(f)).collect(), total / tracks.len().max(1) as f64)
}

/// Pairs every track with its own file; None unless every track has one.
fn assign(tracks: &[WantTrack], files: &[Offer]) -> Option<(Vec<usize>, f64)> {
    let (chosen, fit) = pairs(tracks, files);
    chosen.into_iter().collect::<Option<Vec<_>>>().map(|c| (c, fit))
}

/// How many of the tracks a folder's files play (in its most common audio format).
pub fn coverage(tracks: &[WantTrack], files: &[Offer]) -> usize {
    let mut by_ext: HashMap<String, Vec<Offer>> = HashMap::new();
    for f in files {
        let ext = extension(&f.path);
        if AUDIO.contains(&ext.as_str()) {
            by_ext.entry(ext).or_default().push(f.clone());
        }
    }
    by_ext.values().map(|group| pairs(tracks, group).0.iter().flatten().count()).max().unwrap_or(0)
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

/// The album's name as shared folders spell it: no "(Deluxe Edition)", "[Remastered]",
/// " - EP" or " - Single".
fn plain_album(album: &str) -> &str {
    let base = album.split(['(', '[']).next().unwrap_or(album).trim();
    for suffix in [" - EP", " - Single"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            return stripped.trim();
        }
    }
    base
}

/// "Various Artists" and the like: never part of a shared folder's name.
pub fn various(artist: &str) -> bool {
    matches!(words(artist).join(" ").as_str(), "various artists" | "various" | "va" | "verschiedene interpreten" | "artistes divers")
}

/// What to type into Soulseek's search, all run at once: artist and album words, and the
/// album on its own when its name is distinctive enough to stand alone.
pub fn queries(artist: &str, album: &str) -> Vec<String> {
    let mut artist_words = if various(artist) { Vec::new() } else { words(artist) };
    // "The Weeknd" is shared as "Weeknd, The" as often as not.
    if artist_words.len() > 1 && artist_words[0] == "the" {
        artist_words.remove(0);
    }
    let album_words = words(plain_album(album));
    let mut out = Vec::new();
    if !artist_words.is_empty() && !album_words.is_empty() {
        out.push(artist_words.iter().chain(album_words.iter()).map(String::as_str).collect::<Vec<_>>().join(" "));
    }
    // Short or common album names need the artist; distinctive ones can stand alone.
    let letters: usize = album_words.iter().map(|w| w.chars().count()).sum();
    if album_words.len() >= 2 || letters >= 6 || artist_words.is_empty() {
        if !album_words.is_empty() {
            out.push(album_words.join(" "));
        }
    }
    out.dedup();
    out
}

// ---------------------------------------------------------------------------
// Single songs (playlist imports)
// ---------------------------------------------------------------------------

/// One song to find on its own, as a playlist lists it.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WantSong {
    pub title: String,
    /// Credited artists, main artist first.
    pub artists: Vec<String>,
    #[serde(default)]
    pub album: Option<String>,
    /// Unknown (or not trusted, like a music video's) when absent.
    #[serde(default)]
    pub length_ms: Option<u32>,
}

/// Words that make a recording a different version of a song. A file named with one is only
/// taken when the song's own title names it too.
const VERSIONS: &[&str] = &[
    "live", "remix", "remixed", "mix", "instrumental", "instrumentals", "karaoke", "acapella", "cappella", "acoustic", "demo", "cover", "covers", "sped",
    "slowed", "nightcore", "reverb", "8d", "unplugged", "remake", "tribute", "bootleg", "mashup", "rework", "vip", "extended", "orchestral", "piano",
];

/// A song title's own words, and the version words it names: "Song (feat. X) - 2014 Remaster"
/// is "song"; "Song (Live at Wembley)" is "song" and "live".
pub fn song_words(title: &str) -> (Vec<String>, Vec<String>) {
    let cut = title.find(['(', '[']).into_iter().chain(title.find(" - ")).min().unwrap_or(title.len());
    let (core, extras) = title.split_at(cut);
    let mut own = words(core);
    // "(I Can't Get No) Satisfaction": the brackets are the start of the name.
    if own.is_empty() {
        own = words(&title.replace(['(', ')', '[', ']'], " "));
    }
    let extra: Vec<String> = extras.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.chars().map(fold).collect()).collect();
    let versions = VERSIONS.iter().filter(|v| extra.iter().any(|w| w == *v)).map(|v| v.to_string()).collect();
    (own, versions)
}

/// An artist's words, without a leading "The".
fn artist_words(artist: &str) -> Vec<String> {
    let mut w = words(artist);
    if w.len() > 1 && w[0] == "the" {
        w.remove(0);
    }
    w
}

/// Whether a shared file is this song (in any format): the title in its name, an artist of the
/// song somewhere in its path, no version the song doesn't name, and the right length.
pub fn song_matches(want: &WantSong, offer: &Offer) -> bool {
    song_fit(want, offer).is_some()
}

/// How closely a file fits the song, or None when it isn't the song.
fn song_fit(want: &WantSong, offer: &Offer) -> Option<f64> {
    if !AUDIO.contains(&extension(&offer.path).as_str()) || offer.size < 300_000 {
        return None;
    }
    let stem = basename(&offer.path).rsplit_once('.').map(|(s, _)| s).unwrap_or(basename(&offer.path));
    let name = words(&stem.replace(['(', ')', '[', ']'], " "));
    // `words` stops at "feat"; a version can follow it ("Song (feat. X) [Live]").
    let name_all: Vec<String> = stem.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.chars().map(fold).collect()).collect();
    let path: Vec<String> = offer.path.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.chars().map(fold).collect()).collect();
    let (title, versions) = song_words(&want.title);
    if title.is_empty() {
        return None;
    }
    let found = title.iter().filter(|w| name.contains(w)).count();
    if found < title.len() && !(title.len() >= 4 && found + 1 >= title.len()) {
        return None;
    }
    if versions.iter().any(|v| !path.contains(v)) {
        return None;
    }
    let artists: Vec<Vec<String>> = want.artists.iter().map(|a| artist_words(a)).filter(|w| !w.is_empty()).collect();
    let album: Vec<String> = want.album.as_deref().map(|a| words(a.split(['(', '[']).next().unwrap_or(a))).unwrap_or_default();
    // A live take, a remix or a karaoke track is another recording, in the name or the folder
    // (unless the word is the song's, its artist's or its album's: Little Mix, "Live Forever").
    let ours = |v: &str| versions.iter().chain(title.iter()).chain(album.iter()).chain(artists.iter().flatten()).any(|x| x == v);
    if VERSIONS.iter().any(|v| path.iter().any(|w| w == v) && !ours(v)) {
        return None;
    }
    if !artists.is_empty() && !artists.iter().any(|a| a.iter().all(|w| path.contains(w))) {
        return None;
    }
    let gap = match (want.length_ms, offer.duration) {
        (Some(ms), Some(s)) => Some((ms as f64 / 1000.0 - s as f64).abs()),
        _ => None,
    };
    if gap.is_some_and(|g| g > 6.0) {
        return None;
    }
    let mut score = match gap {
        Some(g) if g <= 2.0 => 10.0,
        Some(g) if g <= 4.0 => 6.0,
        Some(_) => 2.0,
        None => 4.0,
    };
    if found == title.len() {
        score += 4.0;
    }
    // Words in the name that are neither the title, an artist nor a track number: likely another
    // edition or a mislabelled file.
    let known = |w: &String| title.contains(w) || artists.iter().any(|a| a.contains(w)) || w.chars().all(|c| c.is_ascii_digit()) || matches!(w.as_str(), "feat" | "ft" | "featuring" | "the" | "and" | "x");
    score -= name_all.iter().filter(|w| !known(w)).count().min(8) as f64;
    if !album.is_empty() && album.iter().all(|w| path.contains(w)) {
        score += 6.0;
    }
    Some(score)
}

/// Every file that is the song in an allowed format, best first.
pub fn rank_song(want: &WantSong, offers: &[Offer], quality: Quality) -> Vec<Offer> {
    let mut scored: Vec<(f64, &Offer)> = offers
        .iter()
        .filter(|o| format_allowed(&extension(&o.path), o, quality))
        .filter_map(|o| {
            let mut score = song_fit(want, o)?;
            score += match extension(&o.path).as_str() {
                "flac" => 30.0 + if o.bit_depth.is_some_and(|d| d >= 24) { 3.0 } else { 0.0 },
                "mp3" => match o.bitrate {
                    Some(b) if b >= 320 => 22.0,
                    Some(b) if b >= 256 => 15.0,
                    Some(_) => 5.0,
                    None => 12.0,
                },
                _ => 10.0,
            };
            if o.free_slot {
                score += 20.0;
            }
            score += (o.speed as f64 / 1_000_000.0).clamp(0.0, 1.0) * 12.0;
            Some((score, o))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.user.cmp(&b.1.user)));
    let mut seen = std::collections::HashSet::new();
    scored.into_iter().filter(|(_, o)| seen.insert((o.user.clone(), o.path.clone()))).map(|(_, o)| o.clone()).collect()
}

/// What to search Soulseek for to find a song: its main artist and title, and the title alone
/// when it's distinctive enough.
pub fn song_queries(want: &WantSong) -> Vec<String> {
    // One-letter words ("Don't" → "don", "t") match almost anything.
    let keep = |w: &Vec<String>| w.iter().filter(|w| w.chars().count() > 1).cloned().collect::<Vec<_>>();
    let (title, versions) = song_words(&want.title);
    let title: Vec<String> = keep(&title).into_iter().chain(versions).collect();
    let artist = keep(&want.artists.first().map(|a| artist_words(a)).unwrap_or_default());
    let mut out = Vec::new();
    if title.is_empty() {
        return out;
    }
    if !artist.is_empty() {
        out.push(artist.iter().chain(title.iter()).cloned().collect::<Vec<_>>().join(" "));
    }
    let letters: usize = title.iter().map(|w| w.chars().count()).sum();
    if title.len() >= 3 || letters >= 10 || artist.is_empty() {
        out.push(title.join(" "));
    }
    out.dedup();
    out
}

/// More to search for when a song's first searches find nothing: its other artists with its
/// title, and its title alone (even a short one; the artist is still checked on every file).
pub fn song_fallback_queries(want: &WantSong) -> Vec<String> {
    let keep = |w: Vec<String>| w.into_iter().filter(|w| w.chars().count() > 1).collect::<Vec<_>>();
    let (title, versions) = song_words(&want.title);
    let title: Vec<String> = keep(title).into_iter().chain(versions).collect();
    if title.is_empty() {
        return Vec::new();
    }
    let first = song_queries(want);
    let mut out: Vec<String> = want
        .artists
        .iter()
        .skip(1)
        .take(2)
        .map(|a| keep(artist_words(a)))
        .filter(|w| !w.is_empty())
        .map(|w| w.iter().chain(title.iter()).cloned().collect::<Vec<_>>().join(" "))
        .collect();
    out.push(title.join(" "));
    out.retain(|q| !first.contains(q));
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
    fn coverage_counts_the_songs_a_folder_has() {
        let offers = vec![
            offer("a", r"x\OK Computer\01 - Airbag.flac", Some(284), None),
            offer("a", r"x\OK Computer\03 - Subterranean Homesick Alien.flac", Some(267), None),
            offer("a", r"x\OK Computer\folder.jpg", None, None),
        ];
        assert_eq!(coverage(&album(), &offers), 2);
        assert_eq!(coverage(&album(), &[]), 0);
    }

    fn song(title: &str, artist: &str, secs: Option<u32>) -> WantSong {
        WantSong { title: title.into(), artists: vec![artist.into()], album: None, length_ms: secs.map(|s| s * 1000) }
    }

    #[test]
    fn song_titles_drop_credits_and_remasters_but_keep_versions() {
        assert_eq!(song_words("Mo Money Mo Problems (feat. Puff Daddy & Mase) - 2014 Remaster"), (vec!["mo".into(), "money".into(), "mo".into(), "problems".into()], vec![]));
        assert_eq!(song_words("Flower In A Hurricane [From GTAVI: Original Score]").0, ["flower", "in", "a", "hurricane"]);
        assert_eq!(song_words("Use Somebody (Live at Wembley)"), (vec!["use".into(), "somebody".into()], vec!["live".into()]));
        assert_eq!(song_words("(I Can't Get No) Satisfaction").0, ["i", "can", "t", "get", "no", "satisfaction"]);
    }

    #[test]
    fn songs_are_searched_by_artist_and_title() {
        assert_eq!(song_queries(&song("Don't Stop Me Now - Remastered 2011", "Queen", None)), ["queen don stop me now", "don stop me now"]);
        assert_eq!(song_queries(&song("Hello", "Adele", None)), ["adele hello"]);
        assert_eq!(song_queries(&song("Blinding Lights", "The Weeknd", None)), ["weeknd blinding lights", "blinding lights"]);
        assert_eq!(song_queries(&song("Shout (Live)", "Tears for Fears", None)), ["tears for fears shout live"]);
    }

    #[test]
    fn songs_not_found_are_searched_more_widely() {
        let want = WantSong { title: "Timeless".into(), artists: vec!["The Weeknd".into(), "Playboi Carti".into()], album: None, length_ms: None };
        assert_eq!(song_queries(&want), ["weeknd timeless"]);
        assert_eq!(song_fallback_queries(&want), ["playboi carti timeless", "timeless"]);
    }

    #[test]
    fn only_the_song_itself_is_taken() {
        let want = song("Blinding Lights", "The Weeknd", Some(200));
        let file = |user: &str, path: &str, secs: u32| Offer { user: user.into(), path: path.into(), size: 25_000_000, bitrate: None, duration: Some(secs), bit_depth: None, free_slot: true, speed: 1 };
        let offers = vec![
            file("good", r"Music\The Weeknd\After Hours\09 - Blinding Lights.flac", 201),
            file("live", r"Music\The Weeknd\Live\Blinding Lights (Live).flac", 203),
            file("karaoke", r"Karaoke Hits\Blinding Lights.flac", 200),
            file("other", r"Music\Someone Else\Blinding Lights.flac", 200),
            file("edit", r"Music\The Weeknd\Blinding Lights (Extended).flac", 260),
            file("long", r"Music\The Weeknd\Blinding Lights.flac", 230),
            file("sped", r"Music\The Weeknd\Blinding Lights (sped up).flac", 200),
        ];
        let found: Vec<String> = rank_song(&want, &offers, Quality::Any).into_iter().map(|o| o.user).collect();
        assert_eq!(found, ["good"]);
        // Asked for by name, a version is fine; and an artist named like one isn't refused.
        assert!(song_matches(&song("Use Somebody (Live)", "Kings of Leon", None), &file("a", r"Kings of Leon\Live\Use Somebody (Live).mp3", 1)));
        assert!(song_matches(&song("Shout Out to My Ex", "Little Mix", Some(246)), &file("a", r"Little Mix\Glory Days\01 Shout Out to My Ex.mp3", 246)));
        // Without a trusted length, the name decides.
        assert!(song_matches(&song("Blinding Lights", "The Weeknd", None), &file("a", r"x\The Weeknd - Blinding Lights.mp3", 999)));
        // Formats follow the chosen quality.
        let mp3 = Offer { path: r"x\The Weeknd - Blinding Lights.mp3".into(), bitrate: Some(320), ..file("m", "", 200) };
        assert!(rank_song(&want, &[mp3.clone()], Quality::Lossless).is_empty());
        assert_eq!(rank_song(&want, &[mp3], Quality::Mp3).len(), 1);
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
        assert_eq!(queries("Beyoncé", "Lemonade"), ["beyonce lemonade", "lemonade"]);
        assert_eq!(queries("Radiohead", "OK Computer (Collector's Edition)"), ["radiohead ok computer", "ok computer"]);
        assert_eq!(queries("The Weeknd", "Starboy"), ["weeknd starboy", "starboy"]);
        assert_eq!(queries("Taylor Swift", "1989"), ["taylor swift 1989"]);
        assert_eq!(queries("Various Artists", "Grand Theft Auto VI: The Album"), ["grand theft auto vi the album"]);
        assert_eq!(queries("SZA", "SOS - EP"), ["sza sos"]);
        assert_eq!(words("Song (feat. Someone)"), ["song"]);
    }
}
