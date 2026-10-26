# TruongFlix

A lightweight local media center for macOS and Windows with a Netflix-style UI. TruongFlix scans your
movie and TV folders (scene-style filenames welcome), matches them against TMDB, caches everything in
SQLite, and plays files in your installed **VLC**, syncing watch progress back in real time.

## Requirements

- Node 20+ and Rust (stable), plus the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
- VLC Media Player (the app can auto-install it with Homebrew or winget)
- A free [TMDB API key](https://www.themoviedb.org/settings/api) (v3 key or v4 Read Access Token)

## Development

```bash
npm install
npm run app:dev      # Tauri desktop app with hot reload
npm run dev          # UI-only preview in a browser, with mocked backend + fixture data
npm run app:build    # Production bundle (.app / .dmg / .msi)
```

Tests:

```bash
cd src-tauri && cargo test                       # scanner filters, base64 auth
TRUONGFLIX_TEST_VIDEO=/path/to/clip.mp4 \
  cargo test -- --ignored                        # live VLC HTTP status polling
```

## How it works

| Stage | Where | Notes |
| --- | --- | --- |
| Directory walk | `src-tauri/src/scanner.rs` | `walkdir`; skips hidden files, `._*` forks, and samples/trailers under 60 MB |
| Incremental diff | `src/services/scanner.ts` | Skips unchanged `file_path` + `file_mtime`; prunes deleted files but never files on offline drives |
| Filename parsing | `src/services/parser.ts` | `@ctrl/video-filename-parser` plus parent/grandparent folder fallbacks and badge regexes |
| Metadata | `src/services/tmdb.ts` | Rate-limited queue; `append_to_response=credits,images` for the poster, backdrop and ClearLogo |
| Playback | `src-tauri/src/vlc.rs` | Spawns VLC with `--extraintf=http`, polls `/requests/status.json` every 3 s, emits `vlc-progress` / `vlc-exited` |
| Watch state | `src/services/db.ts` | >30 s = resume point; ≥90% = watched; TV "Next Up" advances to the next episode |
| Subtitles (optional) | `src-tauri/src/subtitles.rs`, `src/services/subtitles.ts` | OpenSubtitles search by file hash + TMDB id; the selected file is passed to VLC with `--sub-file` |

### Built-in player (macOS)

Playback happens inside the TruongFlix window using **libmpv** (`src-tauri/src/player/`). VLC is optional and
is used as a fallback.

- **Rendering:** a layer-hosting `NSView` is inserted *below* the WKWebView inside wry's content view. Its
  `CAOpenGLLayer` subclass renders through libmpv's render API with our own OpenGL 3.2 context, and a dedicated render
  thread (IINA's approach) draws whenever mpv has a frame. The page turns transparent in player mode (`html.player-mode`),
  so the React controls are composited over the video.
- **Threading:** libmpv client calls run on async/event threads only. Open and close are serialized, and the render
  context is freed before the core is destroyed.
- **UI:** `src/components/player/PlayerScreen.tsx` has the Netflix-style controls (auto-hide, scrubber, volume, audio
  and subtitle tracks with timing offsets, playback speed, next-episode countdown with auto-advance, the paused
  "You're watching" screen, fullscreen, keyboard shortcuts, and "Open in VLC").
- **Engine lookup:** libmpv is loaded at runtime from `$TRUONGFLIX_LIBMPV`, the app bundle (`Contents/Frameworks/libmpv.2.dylib`),
  or Homebrew (`brew install mpv`). If it isn't found, playback falls back to VLC. You can choose the engine in Settings › Playback.
- **Bundled engine:** `npm run bundle:libmpv` copies libmpv and its 50 dependencies (about 64 MB, mostly FFmpeg) into
  `src-tauri/libmpv/`, rewrites their load paths to `@loader_path`, re-signs them, and generates
  `tauri.macos.conf.json` so they ship in `Contents/Frameworks`. `npm run app:build` runs this step automatically.
  The app needs no Homebrew, mpv, or VLC.
- **Hardened runtime:** `Entitlements.plist` disables library validation so the bundled dylibs can load. All of mpv's
  built-in Lua scripts are turned off: we draw our own UI, and LuaJIT's JIT code is killed under the hardened runtime.
- **Smoke test** (real window, reports frames rendered plus a pixel probe):
  `cd src-tauri && TRUONGFLIX_PLAYER_PROBE=1 cargo run --example player_smoke -- /path/to/video`
- **Debug logging in the app:** `TRUONGFLIX_PLAYER_DEBUG=1 npm run app:dev`

Not done yet: the Windows renderer. Trimming the bundled FFmpeg (removing encoders such as x264, x265 and SVT-AV1)
would cut the app size further.

### Releases & auto-update

Updates use Tauri's updater. Every update is signed, and the app checks it against the public key embedded in
`tauri.conf.json` (`plugins.updater.pubkey`). The player engine ships inside the app, so it updates along with it.

1. One-time setup: `npx tauri signer generate -w ~/.tauri/truongflix.key`. This has already been done. Keep the
   private key safe; losing it means existing installs can't verify future updates.
2. Bump `version` in `src-tauri/tauri.conf.json` (and `package.json`).
3. Run `npm run app:build -- --notes "What changed"`. This bundles libmpv, builds the `.app` and `.dmg`, signs
   `TruongFlix.app.tar.gz`, and writes `src-tauri/target/release/bundle/latest.json`.
4. Create the GitHub release `v<version>` and upload the `.dmg`, `TruongFlix.app.tar.gz`, and `latest.json`.

Installed apps check `https://github.com/iantruong/truongflix/releases/latest/download/latest.json` once a day (and
on demand from Settings › About & Updates). Change `plugins.updater.endpoints` if the repository lives elsewhere.
Builds are ad-hoc signed by default. For distribution without Gatekeeper warnings, set `APPLE_SIGNING_IDENTITY` and
the notarization variables (see the Tauri docs) before building.

### IMDb ratings

Movie, show, season and episode ratings come from IMDb's official
[non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) (`title.ratings` + `title.episode`,
about 65 MB). No API key is needed. IMDb ids come from TMDB. The Rust side (`src-tauri/src/imdb.rs`) caches the files in
the app cache folder, re-downloading ratings at most daily and the episode list weekly, and filters them down to your
library. Season ratings are the average of all rated episodes in that season. Ratings are refreshed during scans (daily,
or right away when titles are added) and can be turned off in Settings. The datasets are licensed for personal,
non-commercial use.

### File management

- **Organize loose files** (on by default; toggle in Settings › Library): before each scan, any video sitting
  directly in a media folder is moved into a folder named after the file. Its subtitles, `.nfo` and artwork go with
  it. Library paths are updated in place, so watch progress and matches are kept.
- **Delete** (movie, show, or a single episode, from its page): files go to a hidden `.truongflix-trash` folder inside
  the same media folder, which is an instant move rather than a copy. If a folder holds only that title (a movie's
  folder, a whole show), the folder goes too. Otherwise only the video and its sidecar files are moved.
- **Settings › Recently Deleted** lists deleted items with **Restore** (brings back files *and* watch progress,
  My List, matches and subtitles) or **Delete forever**. Entries are permanently removed after 30 days.
- **Show in Finder / File Explorer** on every movie, show and episode page.

### Subtitles

Subtitle search is turned off unless an OpenSubtitles API key is set (setup step 3, or Settings). With a key, movie and
episode pages get a **Subtitles** section:

- **Find Subtitles** searches OpenSubtitles using the file's hash, so results made for that exact release are marked
  "Perfect sync". It also searches by the TMDB id (show id plus season and episode for TV).
- **Use** downloads the file next to the video as `<video name>.<lang>.srt`. If that folder is read-only, it goes in
  the app data folder instead. The file is then selected and passed to VLC on every play with `--sub-file`.
- Subtitle files that already sit next to the video (or in a `Subs`/`Subtitles` folder) are listed and can be selected.
- Without an account, OpenSubtitles allows 5 downloads per day. Adding a free account's username and password in
  Settings raises the limit. The credentials are stored in the local SQLite database.

The SQLite database (`truongflix.db`) lives in the OS app-config directory
(`~/Library/Application Support/com.iantruong.truongflix` on macOS, `%APPDATA%\com.iantruong.truongflix` on Windows).

### Notes / deviations from the original spec

- `movies.tmdb_id` is indexed rather than `UNIQUE`, so several versions of one film (for example 1080p and 4K)
  can coexist. The UI shows one card and prefers the version you're watching, then the highest quality.
- Episodes are resolved with one `/tv/{id}/season/{n}` request per season (cached per scan) instead of one
  request per episode. The fields are identical; `getEpisodeDetails` is still available.
- Unmatched TV shows get a synthetic negative `tmdb_id` so they still appear (with an "Unmatched" tag) and can be fixed.
- A manual **Fix Match** is remembered: "Refresh all metadata" reuses the chosen TMDB id instead of re-guessing.
