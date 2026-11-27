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

/// The disc number of a "CD1" / "Disc 2" / "CD1 (Remaster)" / "Disc 1 - Early Years" folder.
fn disc_folder(name: &str) -> Option<u32> {
    let name = name.trim().to_ascii_lowercase();
    ["cd", "disc", "disk"].iter().find_map(|p| {
        let rest = name.strip_prefix(p)?.trim_start_matches([' ', '_', '-', '.']);
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let after = rest[digits.len()..].chars().next();
        // "CD12" is disc 12, but "Discography" isn't a disc.
        (!digits.is_empty() && digits.len() <= 2 && after.is_none_or(|c| !c.is_alphanumeric())).then(|| digits.parse().ok()).flatten()
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
        // Good VBR (V0) averages a little under 256 kbps.
        Quality::Mp3 => ext == "mp3" && offer.bitrate.is_none_or(|b| b >= 240),
        Quality::Any => AUDIO.contains(&ext),
    }
}

fn fold(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => 'u',
        'ñ' | 'ń' | 'ň' => 'n',
        'ç' | 'ć' | 'č' => 'c',
        'ý' | 'ÿ' => 'y',
        'ś' | 'š' | 'ş' => 's',
        'ź' | 'ż' | 'ž' => 'z',
        'ř' => 'r',
        'ł' => 'l',
        'ď' => 'd',
        'ť' => 't',
        'ğ' => 'g',
        _ => c,
    }
}

/// Text as compared: lowercase, accents folded (combining marks dropped too, for names written
/// decomposed), apostrophes removed ("Don't" = "Dont"), "&" read as "and", ligatures spelt out.
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        match c {
            '\'' | '’' | 'ʼ' | '`' | '´' => {}
            '&' => out.push_str(" and "),
            'ß' => out.push_str("ss"),
            'æ' => out.push_str("ae"),
            'œ' => out.push_str("oe"),
            '\u{300}'..='\u{36f}' => {}
            c => out.push(fold(c)),
        }
    }
    out
}

/// Every word of a text (for file names and paths).
fn all_words(text: &str) -> Vec<String> {
    clean(text).split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// A catalogue name's words, up to its "feat." credits.
pub fn words(text: &str) -> Vec<String> {
    all_words(text).into_iter().take_while(|w| !matches!(w.as_str(), "feat" | "ft" | "featuring")).collect()
}

/// Words to type into Soulseek's search, split the way people's clients split file names
/// ("Don't" is "don" and "t"; "&" is left out), up to "feat." credits.
fn search_words(text: &str) -> Vec<String> {
    let lower: String = text.chars().flat_map(char::to_lowercase).filter(|c| !('\u{300}'..='\u{36f}').contains(c)).map(fold).collect();
    lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).take_while(|w| !matches!(*w, "feat" | "ft" | "featuring")).map(str::to_string).collect()
}

/// Search words without one-letter ones ("t" from "Don't" matches almost anything), unless the
/// name is nothing but ("7", "U", "爱").
fn query_words(words: Vec<String>) -> Vec<String> {
    let long: Vec<String> = words.iter().filter(|w| w.chars().count() > 1).cloned().collect();
    if long.is_empty() { words } else { long }
}

/// Words that make a recording a different version of a song. A file named with one is only
/// taken when the song's own title names it too.
const VERSIONS: &[&str] = &[
    "live", "remix", "remixed", "mix", "instrumental", "instrumentals", "karaoke", "acapella", "cappella", "acoustic", "demo", "cover", "covers", "sped",
    "slowed", "nightcore", "reverb", "8d", "unplugged", "remake", "tribute", "bootleg", "mashup", "rework", "vip", "extended", "orchestral", "piano",
    "rerecorded",
];

fn is_version(word: &str) -> bool {
    VERSIONS.contains(&word)
}

/// A re-recording ("Taylor's Version", "Re-Recorded") is another recording of the song.
fn re_recorded(words: &[String]) -> bool {
    words.windows(2).any(|w| (w[0] == "taylors" && w[1] == "version") || (w[0] == "re" && w[1] == "recorded")) || words.iter().any(|w| w == "rerecorded")
}

/// The words inside a file name's brackets: "(Live)", "[Instrumental]".
fn bracket_words(stem: &str) -> Vec<String> {
    let mut inside = String::new();
    let mut depth = 0;
    for c in stem.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                inside.push(' ');
            }
            ')' | ']' => depth = (depth - 1).max(0),
            c if depth > 0 => inside.push(c),
            _ => {}
        }
    }
    all_words(&inside)
}

fn stem_of(path: &str) -> &str {
    let name = basename(path);
    name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name)
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

/// What's compared about a track (worked out once, not once per file).
struct TrackInfo<'a> {
    track: &'a WantTrack,
    title: Vec<String>,
    re_recorded: bool,
}

impl<'a> TrackInfo<'a> {
    fn new(track: &'a WantTrack) -> Self {
        let title = words(&track.title);
        TrackInfo { re_recorded: re_recorded(&all_words(&track.title)), track, title }
    }
}

/// What's compared about a shared file (worked out once, not once per track).
struct FileInfo {
    name: Vec<String>,
    brackets: Vec<String>,
    number: Option<(Option<u32>, u32)>,
    folder_disc: Option<u32>,
    duration: Option<u32>,
    re_recorded: bool,
}

impl FileInfo {
    fn new(offer: &Offer) -> Self {
        let stem = stem_of(&offer.path);
        let name = all_words(stem);
        FileInfo {
            re_recorded: re_recorded(&name),
            name,
            brackets: bracket_words(stem),
            number: leading_number(stem),
            folder_disc: disc_folder(basename(parent(&offer.path))),
            duration: offer.duration,
        }
    }
}

/// How well a file plays `track` (0 = not at all). Needs the title in the name, or the track
/// number with a matching length; never another version of it.
fn pair_score(track: &TrackInfo, file: &FileInfo, multi_disc: bool, album: &[String]) -> f64 {
    // A clearly different length is never the same recording.
    let length_gap = match (track.track.length_ms, file.duration) {
        (Some(ms), Some(s)) => Some((ms as f64 / 1000.0 - s as f64).abs()),
        _ => None,
    };
    if length_gap.is_some_and(|gap| gap > 12.0) {
        return 0.0;
    }
    // "(Instrumental)", "(Live)": not this track, unless its own title (or the album) says so.
    if file.brackets.iter().any(|w| is_version(w) && !track.title.contains(w) && !album.contains(w)) || file.re_recorded != track.re_recorded {
        return 0.0;
    }
    let title = &track.title;
    let title_hit = if title.is_empty() {
        0.0
    } else {
        title.iter().filter(|w| file.name.contains(w)).count() as f64 / title.len() as f64
    };
    let number_hit = file.number.is_some_and(|(disc, n)| {
        n == track.track.position && (!multi_disc || disc.or(file.folder_disc).is_none_or(|d| d == track.track.disc))
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
fn pairs(tracks: &[TrackInfo], files: &[FileInfo], album: &[String]) -> (Vec<Option<usize>>, f64) {
    let multi_disc = tracks.iter().any(|t| t.track.disc > 1);
    let mut pairs = Vec::new();
    for (t, track) in tracks.iter().enumerate() {
        for (f, file) in files.iter().enumerate() {
            let score = pair_score(track, file, multi_disc, album);
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
fn assign(tracks: &[TrackInfo], files: &[FileInfo], album: &[String]) -> Option<(Vec<usize>, f64)> {
    let (chosen, fit) = pairs(tracks, files, album);
    chosen.into_iter().collect::<Option<Vec<_>>>().map(|c| (c, fit))
}

/// How many of the tracks a folder's files play (in its most common audio format).
pub fn coverage(tracks: &[WantTrack], files: &[Offer]) -> usize {
    let infos: Vec<TrackInfo> = tracks.iter().map(TrackInfo::new).collect();
    let mut by_ext: HashMap<String, Vec<FileInfo>> = HashMap::new();
    for f in files {
        let ext = extension(&f.path);
        if AUDIO.contains(&ext.as_str()) {
            by_ext.entry(ext).or_default().push(FileInfo::new(f));
        }
    }
    by_ext.values().map(|group| pairs(&infos, group, &[]).0.iter().flatten().count()).max().unwrap_or(0)
}

/// Every folder that holds the whole album in an allowed format, best first.
pub fn rank(tracks: &[WantTrack], album: &str, offers: &[Offer], quality: Quality) -> Vec<Candidate> {
    if tracks.is_empty() {
        return Vec::new();
    }
    // (user, folder, extension) → files. Formats are never mixed within one album.
    let mut groups: HashMap<(&str, &str, String), Vec<&Offer>> = HashMap::new();
    for offer in offers {
        let ext = extension(&offer.path);
        if !format_allowed(&ext, offer, quality) || offer.size == 0 {
            continue;
        }
        groups.entry((offer.user.as_str(), album_folder(&offer.path), ext)).or_default().push(offer);
    }
    let album_words = words(album);
    let all_album_words = all_words(album);
    let track_infos: Vec<TrackInfo> = tracks.iter().map(TrackInfo::new).collect();
    let mut out = Vec::new();
    for ((user, folder, ext), mut files) in groups {
        // A folder of hundreds of songs is a dump, not this album.
        if files.len() > tracks.len() * 2 + 4 {
            continue;
        }
        // "OK Computer (Instrumentals)", "… Live at …": another album, unless this one's name says so.
        let folder_words = all_words(basename(folder));
        if folder_words.iter().any(|w| is_version(w) && !all_album_words.contains(w)) {
            continue;
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let infos: Vec<FileInfo> = files.iter().map(|f| FileInfo::new(f)).collect();
        let Some((chosen, fit)) = assign(&track_infos, &infos, &all_album_words) else { continue };
        let sample = files[chosen[0]];
        let mut score = fit * 40.0;
        score += match ext.as_str() {
            "flac" => 30.0 + if sample.bit_depth.is_some_and(|d| d >= 24) { 3.0 } else { 0.0 },
            "mp3" => match sample.bitrate {
                Some(b) if b >= 320 => 22.0,
                Some(b) if b >= 240 => 15.0,
                Some(_) => 5.0,
                None => 12.0,
            },
            _ => 10.0,
        };
        if sample.free_slot {
            score += 20.0;
        }
        score += (sample.speed as f64 / 1_000_000.0).clamp(0.0, 1.0) * 12.0;
        if !album_words.is_empty() && album_words.iter().all(|w| folder_words.contains(w)) {
            score += 8.0;
        }
        // Extra songs (bonus tracks, another edition) are left behind, but fewer is better.
        score -= (files.len() - tracks.len()) as f64 * 1.5;
        out.push(Candidate {
            user: user.to_string(),
            folder: folder.to_string(),
            format: ext,
            score,
            files: chosen.into_iter().map(|f| files[f].clone()).collect(),
        });
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.user.cmp(&b.user)));
    out
}

/// The album's name as shared folders spell it: no "(Deluxe Edition)", "[Remastered]",
/// " - EP" or " - Single"; a name that starts with brackets keeps them
/// ("(What's the Story) Morning Glory?").
fn plain_album(album: &str) -> String {
    let base = album.split(['(', '[']).next().unwrap_or(album).trim();
    let base = if base.is_empty() { album.replace(['(', ')', '[', ']'], " ") } else { base.to_string() };
    for suffix in [" - EP", " - Single"] {
        if let Some(stripped) = base.trim().strip_suffix(suffix) {
            return stripped.trim().to_string();
        }
    }
    base.trim().to_string()
}

/// "Various Artists" and the like: never part of a shared folder's name.
pub fn various(artist: &str) -> bool {
    matches!(words(artist).join(" ").as_str(), "various artists" | "various" | "va" | "verschiedene interpreten" | "artistes divers")
}

/// What to type into Soulseek's search, all run at once: artist and album words, and the
/// album on its own when its name is distinctive enough to stand alone.
pub fn queries(artist: &str, album: &str) -> Vec<String> {
    let mut artist_words = if various(artist) { Vec::new() } else { query_words(search_words(artist)) };
    // "The Weeknd" is shared as "Weeknd, The" as often as not.
    if artist_words.len() > 1 && artist_words[0] == "the" {
        artist_words.remove(0);
    }
    let album_words = query_words(search_words(&plain_album(album)));
    let mut out = Vec::new();
    if !artist_words.is_empty() && !album_words.is_empty() {
        out.push(artist_words.iter().chain(album_words.iter()).map(String::as_str).collect::<Vec<_>>().join(" "));
    }
    // The album alone too: Soulseek's server silently ignores searches naming some big artists
    // (The Weeknd, Frank Ocean), so "weeknd starboy" gets no answers while "starboy" does. Not a
    // short common name, though ("blonde", "red"): thousands of strangers answer those and crowd
    // out the right folders. Every folder is still checked against the tracklist.
    let letters: usize = album_words.iter().map(|w| w.chars().count()).sum();
    if (album_words.len() >= 2 || letters >= 7 || artist_words.is_empty()) && !album_words.is_empty() {
        out.push(album_words.join(" "));
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

/// Words in a title's brackets or after its dash that don't name the recording ("Remastered",
/// "Radio Edit", "feat. …", years).
const NOT_A_VERSION: &[&str] = &[
    "feat", "ft", "featuring", "remaster", "remastered", "version", "edit", "radio", "original", "single", "album", "explicit", "clean", "mono", "stereo",
    "from", "the", "and", "of", "in", "at", "with", "on", "for", "deluxe", "bonus", "track", "edition", "anniversary", "expanded", "soundtrack", "motion",
    "picture", "ost", "score", "official", "audio", "video", "lyrics",
];

/// A song title's parts: its own words, the version words it names, and the other words naming
/// that version ("Song (Chromatics Remix)" → "song"; "remix"; "chromatics").
fn song_parts(title: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let cut = title.find(['(', '[']).into_iter().chain(title.find(" - ")).min().unwrap_or(title.len());
    let (core, extras) = title.split_at(cut);
    let mut own = words(core);
    // "(I Can't Get No) Satisfaction": the brackets are the start of the name.
    if own.is_empty() {
        own = words(&title.replace(['(', ')', '[', ']'], " "));
    }
    let extra = all_words(extras);
    let versions: Vec<String> = VERSIONS.iter().filter(|v| extra.iter().any(|w| w == *v)).map(|v| v.to_string()).collect();
    // Only a version needs its own words to match ("Live at Wembley": "wembley").
    let naming = if versions.is_empty() {
        Vec::new()
    } else {
        extra
            .into_iter()
            .take_while(|w| !matches!(w.as_str(), "feat" | "ft" | "featuring"))
            .filter(|w| w.chars().count() > 2 && !w.chars().all(|c| c.is_ascii_digit()) && !is_version(w) && !NOT_A_VERSION.contains(&w.as_str()) && !own.contains(w))
            .collect()
    };
    (own, versions, naming)
}

/// A song title's own words, and the version words it names: "Song (feat. X) - 2014 Remaster"
/// is "song"; "Song (Live at Wembley)" is "song" and "live".
pub fn song_words(title: &str) -> (Vec<String>, Vec<String>) {
    let (own, versions, _) = song_parts(title);
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

/// Everything compared about a wanted song, worked out once for all the files checked.
pub struct SongMatcher {
    title: Vec<String>,
    versions: Vec<String>,
    naming: Vec<String>,
    artists: Vec<Vec<String>>,
    /// Artists spelt with punctuation ("AC/DC"), squashed: matched against the squashed path.
    squashed: Vec<String>,
    album: Vec<String>,
    re_recorded: bool,
    length_ms: Option<u32>,
}

impl SongMatcher {
    pub fn new(want: &WantSong) -> Self {
        let (title, versions, naming) = song_parts(&want.title);
        let squashed = want
            .artists
            .iter()
            .filter(|a| a.chars().any(|c| !c.is_alphanumeric() && !c.is_whitespace()))
            .map(|a| clean(a).chars().filter(|c| c.is_alphanumeric()).collect::<String>())
            .filter(|a| a.chars().count() >= 3)
            .collect();
        SongMatcher {
            re_recorded: re_recorded(&all_words(&want.title)),
            artists: want.artists.iter().map(|a| artist_words(a)).filter(|w| !w.is_empty()).collect(),
            album: want.album.as_deref().map(|a| words(a.split(['(', '[']).next().unwrap_or(a))).unwrap_or_default(),
            length_ms: want.length_ms,
            title,
            versions,
            naming,
            squashed,
        }
    }

    pub fn matches(&self, offer: &Offer) -> bool {
        self.fit(offer).is_some()
    }

    /// How closely a file fits the song, or None when it isn't the song.
    fn fit(&self, offer: &Offer) -> Option<f64> {
        if !AUDIO.contains(&extension(&offer.path).as_str()) || offer.size < 300_000 || self.title.is_empty() {
            return None;
        }
        let stem = stem_of(&offer.path);
        let name = all_words(stem);
        let path = all_words(&offer.path);
        let title = &self.title;
        let found = title.iter().filter(|w| name.contains(w)).count();
        if found < title.len() && !(title.len() >= 4 && found + 1 >= title.len()) {
            return None;
        }
        // The version asked for, by name ("Chromatics Remix", not any remix).
        if self.versions.iter().chain(self.naming.iter()).any(|v| !path.contains(v)) {
            return None;
        }
        // A live take, a remix or a karaoke track is another recording, in the folder (unless the
        // word is the song's, its artist's or its album's: Little Mix, "Live Forever")…
        let ours = |v: &str| self.versions.iter().chain(title.iter()).chain(self.album.iter()).chain(self.artists.iter().flatten()).any(|x| x == v);
        if VERSIONS.iter().any(|v| path.iter().any(|w| w == v) && !ours(v)) {
            return None;
        }
        // …or in the file's own brackets, whatever the title ("Live Forever (Live)").
        if bracket_words(stem).iter().any(|w| is_version(w) && !self.versions.contains(w)) || re_recorded(&name) != self.re_recorded {
            return None;
        }
        let artist_ok = self.artists.is_empty()
            || self.artists.iter().any(|a| a.iter().all(|w| path.contains(w)))
            || (!self.squashed.is_empty() && {
                let squashed: String = clean(&offer.path).chars().filter(|c| c.is_alphanumeric()).collect();
                self.squashed.iter().any(|a| squashed.contains(a.as_str()))
            });
        if !artist_ok {
            return None;
        }
        let gap = match (self.length_ms, offer.duration) {
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
        let known = |w: &String| title.contains(w) || self.artists.iter().any(|a| a.contains(w)) || w.chars().all(|c| c.is_ascii_digit()) || matches!(w.as_str(), "feat" | "ft" | "featuring" | "the" | "and" | "x");
        score -= name.iter().filter(|w| !known(w)).count().min(8) as f64;
        if !self.album.is_empty() && self.album.iter().all(|w| path.contains(w)) {
            score += 6.0;
        }
        Some(score)
    }
}

/// Whether a shared file is this song (in any format): the title in its name, an artist of the
/// song somewhere in its path, no version the song doesn't name, and the right length.
#[cfg(test)]
pub fn song_matches(want: &WantSong, offer: &Offer) -> bool {
    SongMatcher::new(want).matches(offer)
}

/// Every file that is the song in an allowed format, best first.
pub fn rank_song(want: &WantSong, offers: &[Offer], quality: Quality) -> Vec<Offer> {
    let matcher = SongMatcher::new(want);
    let mut scored: Vec<(f64, &Offer)> = offers
        .iter()
        .filter(|o| format_allowed(&extension(&o.path), o, quality))
        .filter_map(|o| {
            let mut score = matcher.fit(o)?;
            score += match extension(&o.path).as_str() {
                "flac" => 30.0 + if o.bit_depth.is_some_and(|d| d >= 24) { 3.0 } else { 0.0 },
                "mp3" => match o.bitrate {
                    Some(b) if b >= 320 => 22.0,
                    Some(b) if b >= 240 => 15.0,
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
    scored.into_iter().filter(|(_, o)| seen.insert((o.user.as_str(), o.path.as_str()))).map(|(_, o)| o.clone()).collect()
}

/// A song title's words to search for: its own name and the version it names.
fn song_search_words(title: &str) -> Vec<String> {
    let cut = title.find(['(', '[']).into_iter().chain(title.find(" - ")).min().unwrap_or(title.len());
    let core = &title[..cut];
    let mut own = search_words(core);
    if own.is_empty() {
        own = search_words(&title.replace(['(', ')', '[', ']'], " "));
    }
    let (_, versions) = song_words(title);
    query_words(own).into_iter().chain(versions).collect()
}

fn artist_search_words(artist: &str) -> Vec<String> {
    let mut w = query_words(search_words(artist));
    if w.len() > 1 && w[0] == "the" {
        w.remove(0);
    }
    w
}

/// What to search Soulseek for to find a song: its main artist and title (the title alone when
/// there's no artist).
pub fn song_queries(want: &WantSong) -> Vec<String> {
    let title = song_search_words(&want.title);
    let artist = want.artists.first().map(|a| artist_search_words(a)).unwrap_or_default();
    let mut out = Vec::new();
    if title.is_empty() {
        return out;
    }
    if !artist.is_empty() {
        out.push(artist.iter().chain(title.iter()).cloned().collect::<Vec<_>>().join(" "));
    }
    // The title alone only when there's no artist: "timeless" on its own is answered by thousands.
    if artist.is_empty() {
        out.push(title.join(" "));
    }
    out.dedup();
    out
}

/// Backup searches for a song whose first search finds nothing, in the order they're tried (one
/// at a time, each only if the last found nothing). Soulseek's server silently ignores searches
/// naming some big artists (The Weeknd, Frank Ocean, Lady Gaga, Rihanna), so these leave the
/// main artist out: other credited artists with the title; the title with its album; the album
/// alone (its folder holds the song) when it's two words or more; and, last of all, the title
/// alone. A short title on its own ("lost") is answered by thousands of strangers, so it's only
/// searched once everything else has found nothing ("Novacane", whose artist is ignored and whose
/// album isn't in the store, is found no other way). Every file is still checked for the song's
/// artist, title and length.
pub fn song_fallback_queries(want: &WantSong) -> Vec<String> {
    let title = song_search_words(&want.title);
    if title.is_empty() {
        return Vec::new();
    }
    let first = song_queries(want);
    let mut out: Vec<String> = want
        .artists
        .iter()
        .skip(1)
        .take(2)
        .map(|a| artist_search_words(a))
        .filter(|w| !w.is_empty())
        .map(|w| w.iter().chain(title.iter()).cloned().collect::<Vec<_>>().join(" "))
        .collect();
    if let Some(album) = &want.album {
        let album = query_words(search_words(&plain_album(album)));
        // A single's album is just its title again.
        if !album.is_empty() && album != title {
            out.push(title.iter().chain(album.iter()).cloned().collect::<Vec<_>>().join(" "));
            if album.len() >= 2 {
                out.push(album.join(" "));
            }
        }
    }
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
        assert_eq!(song_words("(I Can't Get No) Satisfaction").0, ["i", "cant", "get", "no", "satisfaction"]);
    }

    #[test]
    fn names_are_compared_whatever_their_spelling() {
        assert_eq!(words("Beyoncé & Jay-Z"), ["beyonce", "and", "jay", "z"]);
        assert_eq!(words("Beyonce\u{301}"), ["beyonce"]);
        assert_eq!(words("Don’t Stop"), ["dont", "stop"]);
        assert_eq!(disc_folder("CD1 (Remaster)"), Some(1));
        assert_eq!(disc_folder("Disc 2 - Live"), Some(2));
        assert_eq!(disc_folder("Discography"), None);
        assert_eq!(queries("Oasis", "(What's the Story) Morning Glory?"), ["oasis what the story morning glory", "what the story morning glory"]);
    }

    #[test]
    fn other_versions_of_a_song_are_never_taken() {
        let want = song("Love Story", "Taylor Swift", Some(235));
        assert!(song_matches(&want, &offer("a", r"m\Taylor Swift\Fearless\03 Love Story.mp3", Some(235), Some(320))));
        assert!(!song_matches(&want, &offer("a", r"m\Taylor Swift\Fearless (Taylor's Version)\03 Love Story (Taylor's Version).mp3", Some(235), Some(320))));
        let tv = song("Love Story (Taylor's Version)", "Taylor Swift", Some(235));
        assert!(!song_matches(&tv, &offer("a", r"m\Taylor Swift\Fearless\03 Love Story.mp3", Some(235), Some(320))));
        assert!(song_matches(&tv, &offer("a", r"m\Taylor Swift\Fearless (Taylor's Version)\03 Love Story (Taylor’s Version).mp3", Some(235), Some(320))));
        // A remix by someone else isn't the one asked for.
        let remix = song("Midnight City (Eric Prydz Remix)", "M83", None);
        assert!(song_matches(&remix, &offer("a", r"m\M83\Midnight City (Eric Prydz Remix).mp3", None, Some(320))));
        assert!(!song_matches(&remix, &offer("a", r"m\M83\Midnight City (Trentemoller Remix).mp3", None, Some(320))));
        // "Live Forever (Live)" isn't the studio song, though "live" is in its title.
        let lf = song("Live Forever", "Oasis", None);
        assert!(song_matches(&lf, &offer("a", r"m\Oasis\Definitely Maybe\05 Live Forever.mp3", None, Some(320))));
        assert!(!song_matches(&lf, &offer("a", r"m\Oasis\Singles\Live Forever (Live).mp3", None, Some(320))));
        // Punctuated artist names are found however a folder spells them.
        let acdc = song("Thunderstruck", "AC/DC", None);
        assert!(song_matches(&acdc, &offer("a", r"m\ACDC\The Razors Edge\01 Thunderstruck.mp3", None, Some(320))));
        assert!(song_matches(&acdc, &offer("a", r"m\AC-DC\01 Thunderstruck.mp3", None, Some(320))));
    }

    #[test]
    fn instrumental_albums_are_not_the_album() {
        let offers: Vec<Offer> = ["01 Airbag.flac", "02 Paranoid Android.flac", "03 Subterranean Homesick Alien.flac"]
            .iter()
            .zip([284, 387, 267])
            .map(|(n, s)| offer("a", &format!(r"x\Radiohead - OK Computer (Instrumentals)\{n}"), Some(s), None))
            .collect();
        assert!(rank(&album(), "OK Computer", &offers, Quality::Any).is_empty());
        let live: Vec<Offer> = ["01 Airbag (Live).flac", "02 Paranoid Android.flac", "03 Subterranean Homesick Alien.flac"]
            .iter()
            .zip([284, 387, 267])
            .map(|(n, s)| offer("b", &format!(r"x\OK Computer\{n}"), Some(s), None))
            .collect();
        assert!(rank(&album(), "OK Computer", &live, Quality::Any).is_empty());
    }

    #[test]
    fn songs_are_searched_by_artist_and_title() {
        assert_eq!(song_queries(&song("Don't Stop Me Now - Remastered 2011", "Queen", None)), ["queen don stop me now"]);
        assert_eq!(song_queries(&song("Hello", "Adele", None)), ["adele hello"]);
        assert_eq!(song_queries(&song("Blinding Lights", "The Weeknd", None)), ["weeknd blinding lights"]);
        assert_eq!(song_queries(&song("Shout (Live)", "Tears for Fears", None)), ["tears for fears shout live"]);
    }

    #[test]
    fn songs_not_found_are_searched_more_widely() {
        let want = WantSong { title: "Timeless".into(), artists: vec!["The Weeknd".into(), "Playboi Carti".into()], album: None, length_ms: None };
        assert_eq!(song_queries(&want), ["weeknd timeless"]);
        assert_eq!(song_fallback_queries(&want), ["playboi carti timeless", "timeless"]);
        let nights = WantSong { title: "Nights".into(), artists: vec!["Frank Ocean".into()], album: Some("Blonde".into()), length_ms: Some(307_000) };
        assert_eq!(song_queries(&nights), ["frank ocean nights"]);
        assert_eq!(song_fallback_queries(&nights), ["nights blonde", "nights"]);
        let gaga = WantSong { title: "Poker Face".into(), artists: vec!["Lady Gaga".into()], album: Some("The Fame Monster (Deluxe)".into()), length_ms: None };
        assert_eq!(song_fallback_queries(&gaga), ["poker face the fame monster", "the fame monster", "poker face"]);
        let long = WantSong { title: "Only Girl (In The World)".into(), artists: vec!["Rihanna".into()], album: Some("Loud".into()), length_ms: None };
        assert_eq!(song_fallback_queries(&long), ["only girl loud", "only girl"]);
        let single = WantSong { title: "We Found Love".into(), artists: vec!["Rihanna".into()], album: Some("We Found Love".into()), length_ms: None };
        assert_eq!(song_fallback_queries(&single), ["we found love"]);
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
        assert_eq!(queries("Frank Ocean", "Blonde"), ["frank ocean blonde"]);
        assert_eq!(queries("Radiohead", "OK Computer (Collector's Edition)"), ["radiohead ok computer", "ok computer"]);
        assert_eq!(queries("The Weeknd", "Starboy"), ["weeknd starboy", "starboy"]);
        assert_eq!(queries("Frank Ocean", "Nostalgia, Ultra"), ["frank ocean nostalgia ultra", "nostalgia ultra"]);
        assert_eq!(queries("Billie Eilish", "HIT ME HARD AND SOFT"), ["billie eilish hit me hard and soft", "hit me hard and soft"]);
        assert_eq!(queries("Taylor Swift", "1989"), ["taylor swift 1989"]);
        assert_eq!(queries("Various Artists", "Grand Theft Auto VI: The Album"), ["grand theft auto vi the album"]);
        assert_eq!(queries("SZA", "SOS - EP"), ["sza sos"]);
        assert_eq!(words("Song (feat. Someone)"), ["song"]);
    }
}
