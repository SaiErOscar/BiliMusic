<div align="center">
  <img src="./src/assets/icon.png" width="112" height="112" alt="BiliMusic Logo" />
  <h1>BiliMusic</h1>
  <p>
    <strong>Turn Bilibili into a polished, animated, Apple Music inspired desktop music library.</strong>
  </p>
  <p>
    <a href="./README.md">中文</a>
    ·
    <a href="./docs/CHANGELOG.md">Changelog v1.0.1 → v1.2.18-new</a>
    ·
    <a href="#-getting-started">Getting Started</a>
    ·
    <a href="#-harmonyos-pc">HarmonyOS PC</a>
  </p>
  <p>
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111" />
    <img alt="Electron" src="https://img.shields.io/badge/Electron-36-47848F?style=for-the-badge&logo=electron&logoColor=fff" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=fff" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=fff" />
    <img alt="Version" src="https://img.shields.io/badge/version-1.2.18--new-30d158?style=for-the-badge" />
  </p>
</div>

<br />

<div align="center">
  <table>
    <tr>
      <td align="center" width="20%">
        <h3>Apple Music Style</h3>
        <p>Glass panels, immersive background, spring motion, soft glows</p>
      </td>
      <td align="center" width="20%">
        <h3>Bilibili Source</h3>
        <p>Search, recommendations, rankings, favorites, creator spaces</p>
      </td>
      <td align="center" width="20%">
        <h3>Download & Offline</h3>
        <p>Audio/video download, lyric export, batch download, artist metadata</p>
      </td>
      <td align="center" width="20%">
        <h3>Desktop Player</h3>
        <p>Tray, queue, playlists, lyrics, WebDAV sync, OTA hot-patch</p>
      </td>
      <td align="center" width="20%">
        <h3>HarmonyOS PC</h3>
        <p>Dedicated Electron adaptation for HarmonyOS desktop</p>
      </td>
    </tr>
  </table>
</div>

## Table of Contents

- [Vision](#-vision)
- [Feature Map](#-feature-map)
- [Architecture](#-architecture)
- [Getting Started](#-getting-started)
- [Desktop Packaging](#-desktop-packaging)
- [HarmonyOS PC](#-harmonyos-pc)
- [Project Structure](#-project-structure)
- [Persistence](#-persistence)
- [Roadmap](#-roadmap)
- [Disclaimer](#-disclaimer)

## Vision

BiliMusic is not just a video player wrapped in a desktop shell. Its goal is to take the huge, loose, title-noisy, music-rich universe of Bilibili and shape it into something that feels like a real desktop music app.

Video titles are cleaned before lyric search. Search results become music-like track lists. Creator pages can be browsed like artist pages. Queues, favorites, recent tracks, and playlists gradually become a local library. The interface leans toward Apple Music: calm, translucent, animated, and refined, while still staying efficient as a desktop tool.

## Feature Map

### Search & Discovery

- Bilibili video search and user search
- Discovery, recommendations, and music rankings
- Creator space browsing like artist pages
- Apple Music style result rows with play, play next, add to queue, add to playlist

### Player

- Bottom player bar: play/pause, prev/next, repeat/shuffle, seek, volume, queue, download
- Immersive player: large cover art, dynamic background, rotating disc, lyric panel, fullscreen
- Playback state persistence: queue and current track restored after restart
- Quality settings (standard/high/lossless), audio URL caching with 403 auto-retry

### Lyrics

- Bilibili title cleaning: removes noise words like "official MV", "full version", "cover"
- QQ Music lyric source matching with title similarity, artist, album, and duration scoring
- Manual lyric search and version selection
- Lyric time offset adjustment (±0.2s steps, persisted per track)
- Export `.lrc` lyric files with offset preserved when downloading audio

### Login

- **QR code login**: scan with the Bilibili app, officially recommended
- **Password / SMS login**: opens the official Bilibili login page in a dedicated window (the official page natively handles GeeTest CAPTCHA), supporting password, SMS, and QR code; cookies are captured automatically after login

### Download

- Audio download (m4a/flac) and video download (MP4 via ffmpeg merge)
- Filename options: video title / cleaned song name / custom input (pre-filled with original title)
- **Separate toggles for metadata and lyrics**: "embed artist metadata" and "download .lrc lyrics" are independent options
- Stream-to-file writing to avoid memory spikes on large files
- Real-time download progress feedback
- Download history is recorded (including the original video link) and shown on the download page
- The temporary `.tmp` helper folder is auto-hidden and removed after video download
- Empty target folders (non-default) are auto-marked as video/audio-specific folders

### Batch Download

- One-click download all tracks from a playlist
- One-click download all content from a Bilibili favorites folder
- **Background execution**: cancel anytime, hide the window to keep downloading in the background, and resume progress later
- Custom download location (system folder picker)
- Filename format: video title / cleaned name / custom template (`{title}` `{artist}` `{index}` placeholders)
- Real-time progress: current/total, success/fail count, progress bar

### Playlists

- Create playlists from the sidebar with name and description
- Add tracks from any page via reusable modal
- Playlist detail: play all, delete, remove single, batch remove
- Import/export playlists as JSON
- Edit playlist name and description (Edit button / double-click rename in sidebar)
- Drag playlists in the sidebar to reorder, synced to the All Playlists page
- Sort the All Playlists page by modified time / file name (one-shot)
- Export Bilibili favorites folder as a local playlist

### Bilibili Favorites

- Fetch favorites folder list after login
- Import favorites to local library
- Bidirectional sync: local favorites ↔ Bilibili folders (auto on startup + every 2 min, and immediately on any change)
- Batch download favorites content
- Export favorites as a local playlist
- Favorite tracks to a Bilibili folder (aid auto-resolved via bvid when missing; folders already containing the track are pre-checked, uncheck to un-favorite)
- Remove a track from a folder with the 「×」 button on each row

### Settings

- Light / dark / system theme
- Expanded / collapsed / automatic sidebar
- Playback quality / download quality / download format
- Auto play / lyric display
- Download directory
- Playlist import / export
- Login: QR code / password / SMS

### WebDAV Sync & OTA Hot-Patch

- WebDAV bidirectional sync for playlists and favorites with tombstone mechanism
- OTA renderer hot-patch: asar package + SHA-512 verification + heartbeat rollback

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         React UI                              │
│ Pages · Components · Contexts · Hooks · Services              │
└──────────────────────────────┬───────────────────────────────┘
                               │ window.electronAPI
┌──────────────────────────────▼───────────────────────────────┐
│                    Electron Preload Bridge                    │
│ Bili API · Lyrics API · Download · Window · Tray · Storage    │
└──────────────────────────────┬───────────────────────────────┘
                               │ IPC
┌──────────────────────────────▼───────────────────────────────┐
│                    Electron Main Process                      │
│ Protocol · BrowserWindow · Tray · API Proxy · ffmpeg · OTA    │
└──────────────────────────────┬───────────────────────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        │                                             │
┌───────▼────────┐                          ┌─────────▼─────────┐
│ Desktop Builds │                          │ HarmonyOS PC HAP   │
│ Win/macOS/Linux│                          │ platform/HarmonyOS │
└────────────────┘                          └───────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript 5 |
| Build Tool | Vite 6 |
| Styling | Tailwind CSS 4 + CSS Variables |
| Animation | Framer Motion |
| Desktop Runtime | Electron 36 (ESM) |
| A/V Merge | ffmpeg-static (cross-platform static binary) |
| Testing | Vitest + jsdom (26 test cases) |
| Code Quality | ESLint 9 flat config |
| Sync | WebDAV |
| Hot Update | OTA asar renderer patch |

## Getting Started

### Requirements

- Node.js 20+
- npm

### Install & Develop

```bash
npm install
npm run dev
```

### Build

```bash
npm run build            # Build frontend + Electron main process
npm run electron:start   # Build and start Electron
```

## Desktop Packaging

```bash
npm run electron:build
```

Artifacts are written to `release/`. Configured targets:

| Platform | Format |
|----------|--------|
| Windows | NSIS installer (.exe) |
| macOS | DMG + ZIP |
| Linux | AppImage + DEB |

CI auto-build: push a `v*` tag to trigger GitHub Actions parallel builds across all platforms and publish a Release.

## HarmonyOS PC

The HarmonyOS PC Electron project is at `platform/HarmonyOS`.

```bash
npm run harmony:prepare  # Build and sync resources
npm run harmony:build    # Sync resources and try building HAP
```

> Note: the hvigor build tool requires a pure-ASCII project path, and the CLI hvigor has a metadata format mismatch with the DevEco 6.1 SDK (`sdk-pkg.json` vs `uni-package.json`). If the CLI cannot locate the SDK, open `platform/HarmonyOS` in DevEco Studio and build manually — the IDE's built-in hvigor-support matches the SDK version.

## Project Structure

```text
BiliMusic
├─ electron/
│  ├─ main.ts             Main process entry
│  ├─ preload.cjs          Renderer bridge
│  ├─ biliApi.ts           Bilibili API proxy + download + ffmpeg + login window
│  ├─ lyricsApi.ts         Lyrics API proxy
│  ├─ otaUpdater.ts        OTA renderer hot-patch
│  ├─ webdav.ts            WebDAV sync
│  └─ tray-preload.cjs     Tray-specific preload
├─ src/
│  ├─ components/          Player, lyrics, queue, download, layout, login, favorites
│  ├─ contexts/            Playback, auth, now-playing state
│  ├─ hooks/               Theme, settings, lyrics
│  ├─ pages/               Discover, search, recommendations, playlists, favorites, settings, downloads
│  ├─ services/            Bilibili data, lyric matching, download, favorites sync, batch download
│  ├─ styles/              Global styles and Apple Music design system
│  └─ types/               Type definitions
├─ tests/                  Vitest unit tests
├─ scripts/                Build and HarmonyOS sync scripts
├─ platform/HarmonyOS/     HarmonyOS PC Electron project
└─ release/                Installer output
```

## Persistence

- **localStorage**: playback state, queue, playlists, favorites, lyric cache, settings, download history
- **Electron userData**: downloaded files
- **WebDAV**: cloud bidirectional sync for playlists and favorites

## Roadmap

- [ ] More complete download manager (task list, pause/resume)
- [ ] Configurable lyric sources and fallback
- [ ] Mini player
- [ ] Listening statistics
- [ ] Further HarmonyOS PC behavior refinement

## Disclaimer

BiliMusic is intended for learning, research, and personal use. It is not affiliated with, endorsed by, or commercially connected to Bilibili, Apple Music, Apple Inc., or any related service provider. The project does not bundle audio, video, or lyric resources. Please respect platform terms, copyright rules, and local laws.

## Author

Designed and built by MikannQAQ.