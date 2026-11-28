//! What happens to a downloaded album before it joins the music library: every file is checked to
//! really be audio of the expected kind, size and length; tags are rewritten from the album's catalogue details (so
//! the library shows exactly the album that was asked for, whatever the files said); the cover is
//! embedded and saved beside them; and the files are named and filed by the app, never by the
//! names other people gave them: `Album Artist/Album (Year)/01 - Title.flac`.

use super::matching::{WantSong, WantTrack};
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::picture::{Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestTrack {
    #[serde(flatten)]
    pub want: WantTrack,
    pub artist: String,
    #[serde(default)]
    pub recording_mbid: Option<String>,
    #[serde(default)]
    pub track_mbid: Option<String>,
}

/// One audio file of a shared folder the user picked in Soulseek search.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub size: u64,
    #[serde(default)]
    pub bitrate: Option<u32>,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub bit_depth: Option<u32>,
}

/// A shared folder the user picked in Soulseek search.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedCopy {
    pub user: String,
    pub folder: String,
    pub files: Vec<PickedFile>,
}

/// The release to fetch, as the catalogue describes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumRequest {
    pub id: String,
    /// The catalogue's id for this release (one download of it at a time).
    pub release_id: String,
    /// Written into the tags when the release is known to MusicBrainz.
    #[serde(default)]
    pub release_mbid: Option<String>,
    /// Where the cover came from, for the downloads list.
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub release_group_mbid: Option<String>,
    pub album: String,
    pub album_artist: String,
    #[serde(default)]
    pub album_artist_mbid: Option<String>,
    pub date: Option<String>,
    pub genre: Option<String>,
    pub tracks: Vec<RequestTrack>,
    pub quality: super::matching::Quality,
    /// The music folder it's filed into.
    pub destination: String,
    /// The cover, already downloaded (JPEG or PNG).
    pub cover_path: Option<String>,
    /// The copy to download, when the user picked one; otherwise the app searches.
    #[serde(default)]
    pub copy: Option<PickedCopy>,
}

/// One song to fetch on its own (from an imported playlist), with the details to tag it with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongRequest {
    pub id: String,
    /// The playlist import it belongs to.
    #[serde(default)]
    pub group: Option<String>,
    #[serde(flatten)]
    pub want: WantSong,
    /// The artist credit as shown ("Justice, Tame Impala & SZA").
    pub artist: String,
    #[serde(default)]
    pub album_artist: Option<String>,
    #[serde(default)]
    pub track: Option<u32>,
    #[serde(default)]
    pub disc: Option<u32>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    pub quality: super::matching::Quality,
    pub destination: String,
    #[serde(default)]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    /// The file to download, when the user picked one; otherwise the app searches.
    #[serde(default)]
    pub copy: Option<PickedSong>,
}

/// Several songs of one album (from an imported playlist) to fetch together: one search for the
/// album, and the songs from one person's folder of it. Each song is still its own job, tagged
/// and filed the way a song fetched on its own is.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSongsRequest {
    /// This download's own id (its staging folder).
    pub id: String,
    /// The playlist import the songs belong to.
    #[serde(default)]
    pub group: Option<String>,
    pub album: String,
    pub album_artist: String,
    pub quality: super::matching::Quality,
    pub destination: String,
    pub songs: Vec<SongRequest>,
}

/// A shared file the user picked for a song.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedSong {
    pub user: String,
    #[serde(flatten)]
    pub file: PickedFile,
}

fn year_of(date: Option<&str>) -> Option<u16> {
    date.and_then(|d| d.get(..4)).and_then(|y| y.parse().ok())
}

impl SongRequest {
    pub fn year(&self) -> Option<u16> {
        year_of(self.date.as_deref())
    }

    /// Who the song is filed under: the album's artist, else its main artist.
    pub fn filed_artist(&self) -> String {
        self.album_artist.clone().filter(|a| !a.trim().is_empty()).or_else(|| self.want.artists.first().cloned()).filter(|a| !a.trim().is_empty()).unwrap_or_else(|| "Unknown Artist".into())
    }

    /// Where the song goes: `Artist/Album (Year)/01 - Title.flac`, or `Artist/Singles/Title.flac`
    /// when its album isn't known.
    pub fn target(&self, ext: &str) -> PathBuf {
        let base = Path::new(&self.destination).join(safe_name(&self.filed_artist()));
        let dir = match self.want.album.as_deref().filter(|a| !a.trim().is_empty()) {
            Some(album) => base.join(safe_name(&match self.year() {
                Some(year) => format!("{album} ({year})"),
                None => album.to_string(),
            })),
            None => base.join("Singles"),
        };
        let name = match (self.track, self.disc) {
            (Some(n), Some(d)) if d > 1 => format!("{d}-{n:02} - {}", self.want.title),
            (Some(n), _) => format!("{n:02} - {}", self.want.title),
            _ => self.want.title.clone(),
        };
        dir.join(file_name(&name, ext))
    }
}

/// Reads an audio file by what's in it, not its name (an .ogg file can hold Opus or Vorbis).
fn open_audio(path: &Path) -> Result<lofty::file::TaggedFile, lofty::error::FileParseError> {
    lofty::probe::Probe::open(path)?.guess_file_type()?.read()
}

/// Writes `tag` as the file's only tag: every other kind it had (an old ID3v1 or APE tag on an
/// MP3, say) is taken off the file too, so players can't disagree about the song.
fn replace_tags(path: &Path, mut file: lofty::file::TaggedFile, tag: Tag) -> Result<(), String> {
    let kind = tag.tag_type();
    let others: Vec<lofty::tag::TagType> = file.tags().iter().map(|t| t.tag_type()).filter(|t| *t != kind).collect();
    file.clear();
    file.insert_tag(tag);
    file.save_to_path(path, WriteOptions::default()).map_err(|e| format!("Couldn’t write the tags: {e}"))?;
    for other in others {
        let _ = other.remove_from_path(path, WriteOptions::default());
    }
    Ok(())
}

/// Replaces a song's tags with the playlist's (and the store's) details and its cover.
pub fn tag_song(path: &Path, req: &SongRequest, cover: Option<&[u8]>) -> Result<(), String> {
    let file = open_audio(path).map_err(|e| format!("Couldn’t open the file to tag it: {e}"))?;
    let mut tag = Tag::new(file.primary_tag_type());
    tag.set_title(req.want.title.clone());
    tag.set_artist(req.artist.clone());
    if let Some(album) = req.want.album.as_ref().filter(|a| !a.trim().is_empty()) {
        tag.set_album(album.clone());
        tag.insert_text(ItemKey::AlbumArtist, req.filed_artist());
    }
    if let Some(n) = req.track {
        tag.set_track(n);
    }
    if let Some(d) = req.disc {
        tag.set_disk(d);
    }
    if let Some(year) = req.year() {
        let mut parts = req.date.as_deref().unwrap_or("").split('-').skip(1).filter_map(|p| p.parse::<u8>().ok());
        tag.set_date(lofty::tag::items::Timestamp { year, month: parts.next(), day: parts.next(), ..Default::default() });
    }
    if let Some(genre) = req.genre.as_ref().filter(|g| !g.is_empty()) {
        tag.set_genre(genre.clone());
    }
    if let Some(data) = cover {
        if let Ok(mut picture) = Picture::from_reader(&mut &data[..]) {
            picture.set_pic_type(PictureType::CoverFront);
            tag.push_picture(picture);
        }
    }
    replace_tags(path, file, tag)
}

impl AlbumRequest {
    pub fn year(&self) -> Option<u16> {
        year_of(self.date.as_deref())
    }
}

/// The kind of file each extension must really be.
fn expected_type(ext: &str) -> Option<&'static [FileType]> {
    Some(match ext {
        "flac" => &[FileType::Flac],
        "mp3" => &[FileType::Mpeg],
        "m4a" => &[FileType::Mp4],
        "ogg" => &[FileType::Vorbis, FileType::Opus],
        "opus" => &[FileType::Opus],
        _ => return None,
    })
}

/// Checks a finished download: whole, really audio of the kind its name says, and as long as the
/// track. Anything else (a renamed program, a broken or truncated file, another recording) fails.
pub fn verify(path: &Path, ext: &str, size: u64, length_ms: Option<u32>) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let actual = std::fs::metadata(path).map_err(|_| format!("{name} is missing"))?.len();
    if actual != size {
        return Err(format!("{name} arrived incomplete ({actual} of {size} bytes)"));
    }
    let kinds = expected_type(ext).ok_or_else(|| format!("{name} isn't an audio format TruongFlix downloads"))?;
    let file = open_audio(path).map_err(|_| format!("{name} isn't a readable audio file"))?;
    if !kinds.contains(&file.file_type()) {
        return Err(format!("{name} isn't really a .{ext} file"));
    }
    let secs = file.properties().duration().as_secs_f64();
    if secs < 1.0 {
        return Err(format!("{name} has no audio"));
    }
    if let Some(ms) = length_ms {
        let want = ms as f64 / 1000.0;
        if (secs - want).abs() > (want * 0.03).max(7.0) {
            return Err(format!("{name} is {secs:.0}s long, but the track is {want:.0}s"));
        }
    }
    Ok(())
}

/// Replaces the file's tags with the release's own details and its cover.
pub fn tag(path: &Path, req: &AlbumRequest, index: usize, cover: Option<&[u8]>) -> Result<(), String> {
    let track = &req.tracks[index];
    let file = open_audio(path).map_err(|e| format!("Couldn’t open the file to tag it: {e}"))?;
    let mut tag = Tag::new(file.primary_tag_type());
    tag.set_title(track.want.title.clone());
    tag.set_artist(track.artist.clone());
    tag.set_album(req.album.clone());
    tag.insert_text(ItemKey::AlbumArtist, req.album_artist.clone());
    tag.set_track(track.want.position);
    tag.set_track_total(req.tracks.iter().filter(|t| t.want.disc == track.want.disc).count() as u32);
    let discs = req.tracks.iter().map(|t| t.want.disc).max().unwrap_or(1);
    tag.set_disk(track.want.disc);
    tag.set_disk_total(discs);
    if let Some(year) = req.year() {
        let mut parts = req.date.as_deref().unwrap_or("").split('-').skip(1).filter_map(|p| p.parse::<u8>().ok());
        tag.set_date(lofty::tag::items::Timestamp { year, month: parts.next(), day: parts.next(), ..Default::default() });
    }
    if let Some(genre) = req.genre.as_ref().filter(|g| !g.is_empty()) {
        tag.set_genre(genre.clone());
    }
    if let Some(id) = &req.release_mbid {
        tag.insert_text(ItemKey::MusicBrainzReleaseId, id.clone());
    }
    if let Some(id) = &req.release_group_mbid {
        tag.insert_text(ItemKey::MusicBrainzReleaseGroupId, id.clone());
    }
    if let Some(id) = &req.album_artist_mbid {
        tag.insert_text(ItemKey::MusicBrainzReleaseArtistId, id.clone());
    }
    if let Some(id) = &track.recording_mbid {
        tag.insert_text(ItemKey::MusicBrainzRecordingId, id.clone());
    }
    if let Some(id) = &track.track_mbid {
        tag.insert_text(ItemKey::MusicBrainzTrackId, id.clone());
    }
    if let Some(data) = cover {
        if let Ok(mut picture) = Picture::from_reader(&mut &data[..]) {
            picture.set_pic_type(PictureType::CoverFront);
            tag.push_picture(picture);
        }
    }
    replace_tags(path, file, tag)
}

/// A file or folder name that's valid on Windows and macOS.
pub fn safe_name(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let mut name = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if name.chars().count() > 120 {
        name = name.chars().take(120).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    }
    // Windows refuses these names, with or without an extension ("CON", "nul.txt", "COM1").
    let first = name.split('.').next().unwrap_or("").trim_end().to_ascii_lowercase();
    let port = |prefix: &str| {
        let mut rest = first.strip_prefix(prefix).unwrap_or("x!").chars();
        matches!((rest.next(), rest.next()), (Some(d), None) if d.is_ascii_digit() || "¹²³".contains(d))
    };
    let reserved = matches!(first.as_str(), "con" | "prn" | "aux" | "nul" | "conin$" | "conout$") || port("com") || port("lpt");
    if name.is_empty() || name.chars().all(|c| c == '.') || reserved {
        name = format!("_{name}");
    }
    name
}

/// The album's folder in the music folder: a new one when that name is already taken.
pub fn album_dir(req: &AlbumRequest, format: &str) -> PathBuf {
    let artist = safe_name(&req.album_artist);
    let title = match req.year() {
        Some(year) => format!("{} ({year})", req.album),
        None => req.album.clone(),
    };
    let base = Path::new(&req.destination).join(artist);
    let first = base.join(safe_name(&title));
    if !first.exists() {
        return first;
    }
    let with_format = base.join(safe_name(&format!("{title} [{}]", format.to_ascii_uppercase())));
    if !with_format.exists() {
        return with_format;
    }
    (2..).map(|n| base.join(safe_name(&format!("{title} [{}] ({n})", format.to_ascii_uppercase())))).find(|p| !p.exists()).unwrap()
}

/// "01 - Title.flac", or "2-01 - Title.flac" on multi-disc releases.
pub fn track_file_name(req: &AlbumRequest, index: usize, ext: &str) -> String {
    let track = &req.tracks[index].want;
    let multi = req.tracks.iter().any(|t| t.want.disc > 1);
    let number = if multi { format!("{}-{:02}", track.disc, track.position) } else { format!("{:02}", track.position) };
    file_name(&format!("{number} - {}", track.title), ext)
}

/// A safe file name with its extension (a long title is shortened, never its ".flac").
pub fn file_name(stem: &str, ext: &str) -> String {
    format!("{}.{ext}", safe_name(stem))
}

/// Moves (or copies, across drives) a finished file into place.
pub fn move_into(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Across drives: copied beside the target first, so a copy cut short never looks like a song.
    let mut part = to.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let copied = std::fs::copy(from, &part).and_then(|_| std::fs::rename(&part, to));
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Couldn’t file {}: {e}", to.display()));
    }
    let _ = std::fs::remove_file(from);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::soulseek::matching::Quality;

    fn request(dest: &str, tracks: Vec<(&str, u32, u32)>) -> AlbumRequest {
        AlbumRequest {
            id: "job".into(),
            release_id: "itunes:1".into(),
            release_mbid: Some("rel".into()),
            cover_url: None,
            release_group_mbid: Some("rg".into()),
            album: "OK Computer".into(),
            album_artist: "Radiohead".into(),
            album_artist_mbid: None,
            date: Some("1997-05-21".into()),
            genre: Some("Alternative Rock".into()),
            tracks: tracks
                .into_iter()
                .map(|(title, disc, position)| RequestTrack {
                    want: WantTrack { title: title.into(), position, disc, length_ms: None },
                    artist: "Radiohead".into(),
                    recording_mbid: None,
                    track_mbid: None,
                })
                .collect(),
            quality: Quality::Any,
            destination: dest.into(),
            cover_path: None,
            copy: None,
        }
    }

    #[test]
    fn names_are_safe_everywhere() {
        assert_eq!(safe_name("AC/DC: Live?"), "AC_DC_ Live_");
        assert_eq!(safe_name("CON"), "_CON");
        assert_eq!(safe_name("nul.txt"), "_nul.txt");
        assert_eq!(safe_name("COM9"), "_COM9");
        assert_eq!(safe_name("Console"), "Console");
        let long = file_name(&"x".repeat(300), "flac");
        assert!(long.ends_with(".flac") && long.len() <= 125);
        assert_eq!(safe_name(".."), "_");
        assert_eq!(safe_name("  Trailing. "), "Trailing");
        assert!(safe_name(&"x".repeat(300)).len() <= 120);
    }

    #[test]
    fn files_are_named_by_the_tracklist() {
        let single = request("m", vec![("Airbag", 1, 1), ("Lucky?", 1, 11)]);
        assert_eq!(track_file_name(&single, 1, "flac"), "11 - Lucky_.flac");
        let multi = request("m", vec![("One", 1, 1), ("Two", 2, 3)]);
        assert_eq!(track_file_name(&multi, 1, "mp3"), "2-03 - Two.mp3");
    }

    #[test]
    fn a_taken_album_folder_gets_a_new_name() {
        let dir = std::env::temp_dir().join(format!("tf-album-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let req = request(&dir.to_string_lossy(), vec![("Airbag", 1, 1)]);
        let first = album_dir(&req, "flac");
        assert!(first.ends_with("Radiohead/OK Computer (1997)") || first.ends_with(r"Radiohead\OK Computer (1997)"));
        std::fs::create_dir_all(&first).unwrap();
        assert!(album_dir(&req, "flac").to_string_lossy().ends_with("OK Computer (1997) [FLAC]"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_audio_is_refused() {
        let dir = std::env::temp_dir().join(format!("tf-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("01 - Song.flac");
        std::fs::write(&fake, b"MZ this is really a program").unwrap();
        let err = verify(&fake, "flac", 27, Some(200_000)).unwrap_err();
        assert!(err.contains("isn't a readable audio file"), "{err}");
        assert!(verify(&fake, "flac", 99, None).unwrap_err().contains("incomplete"));
        assert!(verify(&fake, "exe", 27, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
