//! Reads a playlist from a streaming service's public page, for Browse → Music → Import playlist.
//!
//! Only three kinds of public page are read, each from the address the app builds itself:
//! Spotify's embeddable playlist page (its first 100 songs), Apple Music's playlist page, and
//! YouTube's playlist page (its first 100 videos; YouTube Music links share the same ids). Each
//! page carries its playlist as JSON; only the songs come back from here (titles, artists,
//! lengths, albums when the page names them, Apple's song ids), never anything else the page
//! holds. Nothing here signs in to anything.

use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// Largest page read (a 100-video YouTube playlist page is ~2.5 MB).
const MAX_PAGE: usize = 10 * 1024 * 1024;
const BROWSER: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    Spotify(String),
    /// Storefront, playlist id.
    Apple(String, String),
    YouTube(String),
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSong {
    pub title: String,
    /// Credited artists, main artist first.
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub length_ms: Option<u32>,
    /// The song's Apple store id (Apple Music playlists).
    pub apple_id: Option<String>,
    pub cover: Option<String>,
    pub explicit: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    /// "spotify" | "apple" | "youtube"
    pub source: String,
    pub id: String,
    pub name: String,
    pub owner: Option<String>,
    pub cover: Option<String>,
    /// How many songs the playlist has, when the page says (it may show fewer).
    pub total: Option<u32>,
    pub songs: Vec<PlaylistSong>,
}

fn id_ok(id: &str, min: usize, max: usize, extra: &[char]) -> bool {
    (min..=max).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

/// Which playlist a pasted link points to.
pub fn recognise(link: &str) -> Option<Source> {
    let url = Url::parse(link.trim()).ok()?;
    if !matches!(url.scheme(), "https" | "http") || url.port().is_some() || !url.username().is_empty() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let parts: Vec<&str> = url.path().split('/').filter(|p| !p.is_empty()).collect();
    match host.as_str() {
        "open.spotify.com" => {
            // `/playlist/<id>`, `/intl-de/playlist/<id>`, `/embed/playlist/<id>`.
            let at = parts.iter().position(|p| *p == "playlist")?;
            let id = parts.get(at + 1)?;
            id_ok(id, 22, 22, &[]).then(|| Source::Spotify(id.to_string()))
        }
        "music.apple.com" | "itunes.apple.com" => {
            // `/<cc>/playlist/<slug>/<pl.id>` (the slug is optional).
            let cc = parts.first()?;
            let id = parts.last()?;
            let ok = cc.len() == 2 && cc.chars().all(|c| c.is_ascii_alphabetic()) && parts.get(1) == Some(&"playlist") && id.starts_with("pl.") && id_ok(&id[3..], 8, 64, &['-', '_']);
            ok.then(|| Source::Apple(cc.to_ascii_lowercase(), id.to_string()))
        }
        "www.youtube.com" | "youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            let list = url.query_pairs().find(|(k, _)| k == "list").map(|(_, v)| v.into_owned())?;
            // Mixes ("RD…") are made up per viewer and have no page of their own.
            (id_ok(&list, 10, 64, &['-', '_']) && !list.starts_with("RD")).then(|| Source::YouTube(list))
        }
        _ => None,
    }
}

fn page_url(source: &Source) -> String {
    match source {
        Source::Spotify(id) => format!("https://open.spotify.com/embed/playlist/{id}"),
        Source::Apple(cc, id) => format!("https://music.apple.com/{cc}/playlist/{id}"),
        Source::YouTube(id) => format!("https://www.youtube.com/playlist?list={id}&hl=en"),
    }
}

/// The JSON value that starts right after `marker` in `html`.
fn json_after(html: &str, marker: &str) -> Option<Value> {
    let start = html.find(marker)? + marker.len();
    let rest = html[start..].trim_start();
    serde_json::Deserializer::from_str(rest).into_iter::<Value>().next()?.ok()
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// "3:55" or "1:02:03" in milliseconds.
fn clock_ms(s: &str) -> Option<u32> {
    let mut total = 0u32;
    for part in s.trim().split(':') {
        total = total.checked_mul(60)?.checked_add(part.parse::<u32>().ok()?)?;
    }
    (!s.trim().is_empty()).then_some(total * 1000)
}

pub fn spotify(id: &str, html: &str) -> Result<Playlist, String> {
    let data = json_after(html, r#"<script id="__NEXT_DATA__" type="application/json">"#).ok_or("Spotify’s page didn’t include the playlist")?;
    let entity = &data["props"]["pageProps"]["state"]["data"]["entity"];
    let list = entity["trackList"].as_array().ok_or("Spotify’s page didn’t include the playlist’s songs (is it private?)")?;
    let songs = list
        .iter()
        .filter(|t| t["entityType"].as_str().is_none_or(|k| k == "track"))
        .filter_map(|t| {
            Some(PlaylistSong {
                title: text(&t["title"])?,
                artists: t["subtitle"].as_str().unwrap_or("").split(',').map(|a| a.replace('\u{a0}', " ").trim().to_string()).filter(|a| !a.is_empty()).collect(),
                length_ms: t["duration"].as_u64().map(|d| d as u32),
                explicit: t["isExplicit"].as_bool().unwrap_or(false),
                ..Default::default()
            })
        })
        .collect();
    Ok(Playlist {
        source: "spotify".into(),
        id: id.into(),
        name: text(&entity["name"]).unwrap_or_else(|| "Spotify playlist".into()),
        owner: text(&entity["subtitle"]),
        cover: entity["coverArt"]["sources"].as_array().and_then(|s| s.iter().filter_map(|i| text(&i["url"])).next()),
        total: None,
        songs,
    })
}

/// Apple's artwork template at a size.
fn artwork(v: &Value, px: u32) -> Option<String> {
    text(&v["dictionary"]["url"]).map(|u| u.replace("{w}", &px.to_string()).replace("{h}", &px.to_string()).replace("{f}", "jpg"))
}

pub fn apple(id: &str, html: &str) -> Result<Playlist, String> {
    let data = json_after(html, r#"<script type="application/json" id="serialized-server-data">"#).ok_or("Apple Music’s page didn’t include the playlist")?;
    let sections = data["data"][0]["data"]["sections"].as_array().ok_or("Apple Music’s page didn’t include the playlist")?;
    let of_kind = |kind: &str| sections.iter().find(|s| s["itemKind"] == kind).and_then(|s| s["items"].as_array());
    let header = of_kind("containerDetailHeaderLockup").and_then(|i| i.first()).cloned().unwrap_or(Value::Null);
    let songs = of_kind("trackLockup")
        .map(|items| {
            items
                .iter()
                .filter_map(|t| {
                    let links = t["subtitleLinks"].as_array();
                    let mut artists: Vec<String> = links.map(|l| l.iter().filter_map(|a| text(&a["title"])).collect()).unwrap_or_default();
                    if artists.is_empty() {
                        artists.extend(text(&t["artistName"]));
                    }
                    Some(PlaylistSong {
                        title: text(&t["title"])?,
                        artists,
                        album: t["tertiaryLinks"].as_array().and_then(|l| l.first()).and_then(|a| text(&a["title"])),
                        length_ms: t["duration"].as_u64().map(|d| d as u32),
                        apple_id: text(&t["contentDescriptor"]["identifiers"]["storeAdamID"]).filter(|i| i.chars().all(|c| c.is_ascii_digit())),
                        cover: artwork(&t["artwork"], 600),
                        explicit: t["showExplicitBadge"].as_bool().unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Playlist {
        source: "apple".into(),
        id: id.into(),
        name: text(&header["title"]).unwrap_or_else(|| "Apple Music playlist".into()),
        owner: header["subtitleLinks"].as_array().and_then(|l| l.first()).and_then(|a| text(&a["title"])),
        cover: artwork(&header["artwork"], 600),
        total: header["trackCount"].as_u64().map(|n| n as u32),
        songs,
    })
}

fn collect<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(map) => {
            if let Some(found) = map.get(key) {
                out.push(found);
                return;
            }
            map.values().for_each(|v| collect(v, key, out));
        }
        Value::Array(items) => items.iter().for_each(|v| collect(v, key, out)),
        _ => {}
    }
}

/// "Artist - Topic" and "ArtistVEVO" channels are named after the artist.
fn channel_artist(channel: &str) -> String {
    let name = channel.trim();
    let name = name.strip_suffix(" - Topic").unwrap_or(name);
    let name = name.strip_suffix("VEVO").or_else(|| name.strip_suffix("Vevo")).unwrap_or(name);
    name.trim().to_string()
}

pub fn youtube(id: &str, html: &str) -> Result<Playlist, String> {
    let data = json_after(html, "var ytInitialData = ").ok_or("YouTube’s page didn’t include the playlist")?;
    let mut lockups = Vec::new();
    collect(&data, "lockupViewModel", &mut lockups);
    let mut songs = Vec::new();
    for item in lockups {
        if item["contentType"] != "LOCKUP_CONTENT_TYPE_VIDEO" {
            continue;
        }
        let meta = &item["metadata"]["lockupMetadataViewModel"];
        let Some(title) = text(&meta["title"]["content"]) else { continue };
        let channel = meta["image"]["decoratedAvatarViewModel"]["a11yLabel"].as_str().and_then(|l| l.strip_prefix("Go to channel ")).map(channel_artist);
        let mut badges = Vec::new();
        collect(&item["contentImage"], "thumbnailBadgeViewModel", &mut badges);
        let length_ms = badges.iter().filter_map(|b| b["text"].as_str()).find_map(clock_ms);
        songs.push(PlaylistSong {
            title,
            artists: channel.into_iter().filter(|c| !c.is_empty()).collect(),
            length_ms,
            cover: text(&item["contentId"]).filter(|v| id_ok(v, 6, 20, &['-', '_'])).map(|v| format!("https://i.ytimg.com/vi/{v}/hqdefault.jpg")),
            ..Default::default()
        });
    }
    if songs.is_empty() {
        return Err("YouTube’s page didn’t include any videos (is the playlist private?)".into());
    }
    let header = &data["metadata"]["playlistMetadataRenderer"];
    let mut owners = Vec::new();
    collect(&data["header"], "metadataRows", &mut owners);
    let owner = owners
        .first()
        .and_then(|rows| rows.as_array())
        .and_then(|rows| rows.first())
        .and_then(|row| row["metadataParts"][0]["avatarStack"]["avatarStackViewModel"]["text"]["content"].as_str().or(row["metadataParts"][0]["text"]["content"].as_str()))
        .map(|s| s.trim_start_matches("by ").trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(Playlist {
        source: "youtube".into(),
        id: id.into(),
        name: text(&header["title"]).unwrap_or_else(|| "YouTube playlist".into()),
        owner,
        cover: songs.first().and_then(|s| s.cover.clone()),
        total: None,
        songs,
    })
}

/// Reads the playlist a pasted Spotify, Apple Music or YouTube link points to.
#[tauri::command]
pub async fn music_playlist(link: String) -> Result<Playlist, String> {
    let source = recognise(&link).ok_or("Paste a link to a Spotify, Apple Music or YouTube playlist.")?;
    let client = reqwest::Client::builder()
        .user_agent(BROWSER)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        // Apple adds the playlist's name to its address; a redirect to another site isn't followed.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same_site = attempt.previous().first().and_then(|first| first.host_str()) == attempt.url().host_str();
            if same_site && attempt.url().scheme() == "https" && attempt.previous().len() < 4 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(page_url(&source))
        .header("Accept", "text/html")
        .header("Accept-Language", "en-US,en;q=0.8")
        .send()
        .await
        .map_err(|_| "The streaming service couldn’t be reached".to_string())?;
    let status = response.status().as_u16();
    if status == 404 {
        return Err("That playlist doesn’t exist, or isn’t public.".into());
    }
    if !(200..300).contains(&status) {
        return Err(format!("The streaming service answered {status}"));
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Couldn’t read the playlist page".to_string())? {
        if body.len() + chunk.len() > MAX_PAGE {
            return Err("The playlist page was too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let html = String::from_utf8_lossy(&body);
    let playlist = match &source {
        Source::Spotify(id) => spotify(id, &html),
        Source::Apple(_, id) => apple(id, &html),
        Source::YouTube(id) => youtube(id, &html),
    }?;
    if playlist.songs.is_empty() {
        return Err("That playlist has no songs, or isn’t public.".into());
    }
    Ok(playlist)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_from_each_service_are_recognised() {
        assert_eq!(recognise("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"), Some(Source::Spotify("37i9dQZF1DXcBWIGoYBM5M".into())));
        assert_eq!(recognise("https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M"), Some(Source::Spotify("37i9dQZF1DXcBWIGoYBM5M".into())));
        assert_eq!(
            recognise("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb"),
            Some(Source::Apple("us".into(), "pl.f4d106fed2bd41149aaacabb233eb5eb".into()))
        );
        assert_eq!(recognise("https://music.apple.com/GB/playlist/pl.u-abc123DEF456"), Some(Source::Apple("gb".into(), "pl.u-abc123DEF456".into())));
        assert_eq!(recognise("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"), Some(Source::YouTube("PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI".into())));
        assert_eq!(recognise("https://music.youtube.com/playlist?list=OLAK5uy_kXyz0123456789"), Some(Source::YouTube("OLAK5uy_kXyz0123456789".into())));
        for bad in [
            "https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M",
            "https://open.spotify.com/playlist/../../etc",
            "https://open.spotify.com.evil.example/playlist/37i9dQZF1DXcBWIGoYBM5M",
            "https://music.apple.com/us/album/x/123",
            "https://www.youtube.com/watch?v=abc&list=RDabcdefghijk",
            "https://www.youtube.com/playlist?list=a/b",
            "https://www.youtube.com:444/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
            "file:///C:/x",
            "not a link",
        ] {
            assert_eq!(recognise(bad), None, "{bad}");
        }
        // Pages are always fetched from addresses built here.
        assert_eq!(page_url(&Source::YouTube("PLx0123456789".into())), "https://www.youtube.com/playlist?list=PLx0123456789&hl=en");
    }

    #[test]
    fn spotify_pages_give_titles_artists_and_lengths() {
        let html = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"settings":{"session":{"accessToken":"secret"}},"data":{"entity":{"name":"Today’s Top Hits","subtitle":"Spotify","coverArt":{"sources":[{"url":"https://i.scdn.co/image/a"}]},"trackList":[{"title":"Flower In A Hurricane (feat. SZA)","subtitle":"Justice,\u00a0Tame Impala,\u00a0SZA","duration":224877,"isExplicit":true,"entityType":"track"},{"title":"An Episode","subtitle":"Pod","entityType":"episode"}]}}}}}}</script></html>"#;
        let p = spotify("x", html).unwrap();
        assert_eq!((p.name.as_str(), p.owner.as_deref(), p.cover.as_deref()), ("Today’s Top Hits", Some("Spotify"), Some("https://i.scdn.co/image/a")));
        assert_eq!(p.songs.len(), 1);
        assert_eq!(p.songs[0].artists, ["Justice", "Tame Impala", "SZA"]);
        assert_eq!((p.songs[0].length_ms, p.songs[0].explicit), (Some(224877), true));
        // Nothing else from the page comes along.
        assert!(!serde_json::to_string(&p).unwrap().contains("secret"));
    }

    #[test]
    fn apple_pages_give_store_ids_and_albums() {
        let html = r#"<script type="application/json" id="serialized-server-data">{"data":[{"data":{"sections":[{"itemKind":"containerDetailHeaderLockup","items":[{"title":"Today’s Hits","trackCount":50,"subtitleLinks":[{"title":"Apple Music Pop"}],"artwork":{"dictionary":{"url":"https://is1-ssl.mzstatic.com/a/{w}x{h}SC.{f}"}}}]},{"itemKind":"trackLockup","items":[{"title":"stupid song","duration":209680,"subtitleLinks":[{"title":"Olivia Rodrigo"}],"tertiaryLinks":[{"title":"you seem pretty sad"}],"contentDescriptor":{"identifiers":{"storeAdamID":"1889992115"}},"artwork":{"dictionary":{"url":"https://is1-ssl.mzstatic.com/b/{w}x{h}bb.{f}"}}}]}]}}]}</script>"#;
        let p = apple("pl.x", html).unwrap();
        assert_eq!((p.name.as_str(), p.total, p.owner.as_deref()), ("Today’s Hits", Some(50), Some("Apple Music Pop")));
        assert_eq!(p.cover.as_deref(), Some("https://is1-ssl.mzstatic.com/a/600x600SC.jpg"));
        let s = &p.songs[0];
        assert_eq!((s.title.as_str(), s.artists.clone(), s.album.as_deref(), s.apple_id.as_deref(), s.length_ms), ("stupid song", vec!["Olivia Rodrigo".to_string()], Some("you seem pretty sad"), Some("1889992115"), Some(209680)));
    }

    #[test]
    fn youtube_pages_give_video_titles_channels_and_lengths() {
        let html = r#"<script>var ytInitialData = {"metadata":{"playlistMetadataRenderer":{"title":"Popular Music Videos"}},"contents":{"x":[{"lockupViewModel":{"contentId":"fOT0BUpITw8","contentType":"LOCKUP_CONTENT_TYPE_VIDEO","contentImage":{"thumbnailViewModel":{"overlays":[{"thumbnailBottomOverlayViewModel":{"badges":[{"thumbnailBadgeViewModel":{"text":"3:55"}}]}}]}},"metadata":{"lockupMetadataViewModel":{"title":{"content":"BELLAKEO (Video Oficial) - Peso Pluma, Anitta"},"image":{"decoratedAvatarViewModel":{"a11yLabel":"Go to channel PesoPlumaVEVO"}}}}}},{"lockupViewModel":{"contentType":"LOCKUP_CONTENT_TYPE_PLAYLIST"}}]}};</script>"#;
        let p = youtube("PLx", html).unwrap();
        assert_eq!(p.name, "Popular Music Videos");
        assert_eq!(p.songs.len(), 1);
        assert_eq!(p.songs[0].artists, ["PesoPluma"]);
        assert_eq!(p.songs[0].length_ms, Some(235_000));
        assert_eq!(p.songs[0].cover.as_deref(), Some("https://i.ytimg.com/vi/fOT0BUpITw8/hqdefault.jpg"));
        assert_eq!(clock_ms("1:02:03"), Some(3_723_000));
        assert_eq!(clock_ms("LIVE"), None);
        assert_eq!(channel_artist("Taylor Swift - Topic"), "Taylor Swift");
    }

    /// Reads real playlists from each service.
    /// `cargo test --lib -- --ignored real_playlists --nocapture`
    #[test]
    #[ignore]
    fn real_playlists() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        for link in [
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
            "https://open.spotify.com/playlist/37i9dQZF1DX4o1oenSJRJd",
            "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
            "https://music.apple.com/us/playlist/top-100-global/pl.d25f5d1181894928af76c85c967f8f31",
            "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
        ] {
            let p = rt.block_on(music_playlist(link.into())).unwrap_or_else(|e| panic!("{link}: {e}"));
            println!("{} · {} · {:?} · {} songs (of {:?})", p.source, p.name, p.owner, p.songs.len(), p.total);
            for s in p.songs.iter().take(3) {
                println!("   {} — {} [{:?}] {:?}", s.title, s.artists.join(", "), s.album, s.length_ms);
            }
            assert!(p.songs.len() >= 20, "{link}");
            assert!(p.songs.iter().all(|s| !s.title.is_empty()), "{link}");
            // Now and then a video has no channel link or length badge.
            let complete = p.songs.iter().filter(|s| !s.artists.is_empty() && s.length_ms.is_some()).count();
            assert!(complete * 10 >= p.songs.len() * 9, "{link}: {complete} of {} complete", p.songs.len());
        }
    }
}
