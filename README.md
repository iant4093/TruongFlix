<div align="center">

<img src="docs/app-icon.png" width="96" alt="TruongFlix app icon">

# TruongFlix

A local media center for macOS and Windows that turns the movies and shows on your drives into a Netflix-style library, with a built-in player.

[Download for macOS](https://github.com/iant4093/TruongFlix/releases/latest/download/TruongFlix-macOS.dmg) · [Download for Windows](https://github.com/iant4093/TruongFlix/releases/latest/download/TruongFlix-Windows-Setup.exe) · [Releases](https://github.com/iant4093/TruongFlix/releases) · [Build status](https://github.com/iant4093/TruongFlix/actions) · [Report an issue](https://github.com/iant4093/TruongFlix/issues)

[![Download for macOS](https://img.shields.io/badge/Download_for_macOS-E50914?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/iant4093/TruongFlix/releases/latest/download/TruongFlix-macOS.dmg)
[![Download for Windows](https://img.shields.io/badge/Download_for_Windows-E50914?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/iant4093/TruongFlix/releases/latest/download/TruongFlix-Windows-Setup.exe)

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)
![Player](https://img.shields.io/badge/player-libmpv-6E3FA3)
![Platforms](https://img.shields.io/badge/platforms-macOS_%7C_Windows-555555)
[![CI](https://github.com/iant4093/TruongFlix/actions/workflows/ci.yml/badge.svg)](https://github.com/iant4093/TruongFlix/actions/workflows/ci.yml)

</div>

---

TruongFlix scans the folders you choose, works out what each file is from its name (even scene-release names like `The.Matrix.1999.2160p.UHD.BluRay.x265.HDR.DV-GROUP.mkv`), and fetches artwork, title logos, cast and episode details from TMDB. Everything is cached locally in SQLite, and playback happens inside the app through an embedded mpv engine, with progress synced to Continue Watching. Nothing is uploaded; the only network requests are metadata and ratings lookups, plus optional subtitle downloads.

## Screenshots

Library screenshots use the development preview with sample metadata and artwork from [TMDB](https://www.themoviedb.org). The player capture is the real macOS app playing [Big Buck Bunny](https://peach.blender.org) (© Blender Foundation, CC BY 3.0).

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/home.webp" width="100%" alt="TruongFlix home screen with a full-bleed Severance billboard, IMDb rating, quality badges, Play and More Info buttons, and a Continue Watching row">
      <p align="center"><sub><b>Home</b> · billboard, ratings and Continue Watching</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/player.webp" width="100%" alt="Built-in player showing a Big Buck Bunny scene with a red scrub bar, playback controls and the title along the bottom">
      <p align="center"><sub><b>Built-in player</b> · native video under the app's controls</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/detail.webp" width="100%" alt="Show page for Severance with title logo, Play S1:E3 button, IMDb rating, quality badges, cast and genres">
      <p align="center"><sub><b>Title page</b> · details, actions and file management</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/episode.webp" width="100%" alt="Episode page for Severance season 1 episode 3 with episode rating, season average, quality badges and the Subtitles section">
      <p align="center"><sub><b>Episode page</b> · per-episode ratings and subtitles</sub></p>
    </td>
  </tr>
</table>

## Features

**Library**

- Recursive scanning of any number of folders, with incremental re-scans that only process new or changed files
- Scene-filename parsing with parent-folder fallbacks for TV seasons, generic file names and obfuscated releases
- TMDB artwork, transparent title logos, cast, genres and episode details; Fix Match for anything misidentified
- Quality badges from file names: 4K, HDR10, Dolby Vision, HEVC/AV1, Atmos and lossless audio
- IMDb ratings for movies, shows, season averages and individual episodes, from IMDb's public datasets
- Home, TV Shows, Movies, My List and search; Continue Watching with TV "Next Up"; Top 10 and genre rows

**Playback**

- Built-in player powered by libmpv: hardware decoding, HDR tone mapping and nearly every container and codec
- Netflix-style controls: scrubbing, ±10 s, volume, speed, audio and subtitle tracks, and subtitle/audio timing
- Next-episode countdown with auto-advance, the paused "You're watching" screen, fullscreen and keyboard shortcuts
- Resume points saved as you watch; anything 90% watched is marked complete
- Optional external VLC, as a fallback or as the default player

**Files and subtitles**

- Optional OpenSubtitles integration: search by file hash for perfectly synced results, downloaded next to the video
- Loose videos are organized into their own folders, along with their subtitles and artwork
- Delete movies, shows or single episodes to Recently Deleted, with full restore for 30 days
- Show in Finder / File Explorer, and offline drives are never pruned from the library

## Install

**macOS** (Apple Silicon)

1. Download [TruongFlix-macOS.dmg](https://github.com/iant4093/TruongFlix/releases/latest/download/TruongFlix-macOS.dmg) and drag TruongFlix into Applications.
2. The first time, right-click the app and choose **Open**. Release builds are ad-hoc signed, not notarized.

**Windows** (x64, Windows 10 or later)

1. Download [TruongFlix-Windows-Setup.exe](https://github.com/iant4093/TruongFlix/releases/latest/download/TruongFlix-Windows-Setup.exe) and run it.
2. If SmartScreen appears, choose **More info › Run anyway**. The installer is not code-signed.

On first launch, the setup wizard asks for a free [TMDB API key](https://www.themoviedb.org/settings/api), an optional [OpenSubtitles key](https://www.opensubtitles.com/en/consumers), and your media folders. The player engine is included, so no other software is required. The download buttons always point to the most recent successfully published release.

Installed copies update themselves: they check for a new version once a day (or from **Settings › About & Updates**) and install it after verifying its signature.

## Tech stack

| Area | Technologies |
|---|---|
| App shell | Tauri 2 (Rust), WKWebView on macOS, WebView2 on Windows |
| Interface | React 18, TypeScript, Vite, Tailwind CSS, Framer Motion, Zustand |
| Playback | libmpv with FFmpeg; macOS: CAOpenGLLayer under a transparent webview; Windows: owned video window behind a transparent window |
| Metadata | TMDB API v3, IMDb non-commercial datasets, OpenSubtitles REST API |
| Storage | SQLite via tauri-plugin-sql, local file operations and a same-volume trash |
| Delivery | GitHub Actions, macOS `.dmg`, Windows NSIS installer, signed auto-updates, SHA-256 checksums |

## Build locally

Requires **Node 22+**, **Rust stable** and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. On macOS, also install mpv (`brew install mpv`), which the bundler copies into the app.

```bash
npm install

# Desktop app with hot reload
npm run app:dev

# UI-only preview in a browser, with a mocked backend and sample data
npm run dev

# Copy the player engine into src-tauri/libmpv/ (macOS: Homebrew's libmpv; Windows: downloads libmpv-2.dll)
npm run bundle:libmpv

# Release build: bundles libmpv, builds installers, signs the updater archive, writes latest.json
npm run app:build
```

`app:build` signs updates with `~/.tauri/truongflix.key` or `$TAURI_SIGNING_PRIVATE_KEY`. Generate a key once with `npx tauri signer generate -w ~/.tauri/truongflix.key`. Without it, use `npx tauri build` for an unsigned local build.

## Tests

```bash
# TypeScript check and production frontend build
npm run build

# Rust unit tests: scanner, subtitles, file management, IMDb parsing, VLC auth
cd src-tauri && cargo test

# Network and engine tests (real IMDb datasets, OpenSubtitles, VLC)
cd src-tauri && cargo test -- --ignored

# Built-in player smoke test on macOS: renders into a real window and reports drawn frames
cd src-tauri && TRUONGFLIX_PLAYER_PROBE=1 cargo run --example player_smoke -- /path/to/video.mkv
```

For debugging playback in the app, run `TRUONGFLIX_PLAYER_DEBUG=1 npm run app:dev`, which logs frame and state information.

## CI and releases

Pull requests and pushes to `main` run:

1. A TypeScript check and production frontend build.
2. macOS and Windows builds: libmpv bundling, Rust tests and installer packaging.
3. A Windows player smoke test that launches the built app on a sample video and captures screenshots as an artifact.

After all builds pass, pushes to `main` publish a GitHub Release `v<major>.<minor>.<run number>` containing `TruongFlix-macOS.dmg`, `TruongFlix-Windows-Setup.exe`, the signed updater archives, `latest.json` and `SHA256SUMS`. Installed apps pick up the new version through `latest.json`. Pull requests never publish.

The updater signing key is stored as the `TAURI_SIGNING_PRIVATE_KEY` repository secret. Builds without it (such as fork pull requests) still produce installers, just without update signatures. GitHub Actions are pinned to commit SHAs, and Dependabot checks them weekly.

## Repository layout

```text
.
├── src/                    React app
│   ├── components/         Library, player, modals, settings and shared UI
│   ├── services/           Scanner, parser, TMDB, IMDb, subtitles, files, player, updates, SQLite
│   ├── store/              Zustand store and library selectors
│   └── dev/                Browser-preview mock of the Tauri backend (dev only)
├── src-tauri/              Rust backend
│   ├── src/player/         libmpv bindings and macOS/Windows video surfaces
│   ├── src/                Scanner, VLC, subtitles, file management and IMDb commands
│   └── examples/           Player smoke test
├── scripts/                libmpv bundling and release packaging
├── docs/                   README screenshots and icon
├── .github/                CI/release workflow and Dependabot
└── README.md
```

TruongFlix uses the TMDB API but is not endorsed or certified by TMDB. IMDb data is used under IMDb's non-commercial terms.
