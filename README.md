# netflix-home

A Netflix-style web app for a local movie library. Point it at a folder (default `G:\Movies`, with a local `media` folder as fallback), and every video file in it shows up as a title you can browse, search, and stream. The server can also download public-domain films from archive.org into the library.

![stack](https://img.shields.io/badge/node-20%2B-brightgreen) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

## Run it

```powershell
npm install
npm start
```

Open http://localhost:3000

The server scans the library on startup. Use the refresh button in the header (or the profile menu) to rescan after adding files.

### Launch from the desktop (no console)

Double-click **`netflix-home.exe`** (or a shortcut to it). It starts the server hidden, opens the app in your default browser, and parks a Netflix-style icon in the notification area (system tray):

- click the tray icon → the page opens in the default browser
- right-click it → **Open netflix-home** / **Quit (stop server)**
- quitting stops the server it started
- if port 3000 is already served, the launcher attaches to it instead of starting a second server
- launching it twice only reopens the page

Windows 11 hides new tray icons by default. If the icon is not next to the clock, drag it out of the **^** overflow, or enable it in **Settings → Personalization → Taskbar → Other system tray icons**. Diagnostics go to `launcher.log` (gitignored).

The launcher is a small WinForms app; the source is `launcher.cs` and it is rebuilt with:

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe `
  /win32icon:public\favicon.ico /out:netflix-home.exe `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll launcher.cs
```

## Library folder

Default root is `G:\Movies` when that drive is mounted. If it isn't, the app falls back to `media\` inside the project (created automatically), so you can test without the external drive. Videos are picked up recursively from either location:

```
G:\Movies\
└─ Classics\
   ├─ Night of the Living Dead (1968).mp4
   ├─ Nosferatu (1922).mp4
   └─ The Great Train Robbery (1903).mp4
```

- Supported containers: MP4, MKV, AVI, MOV, WEBM, M4V, WMV, FLV, MPG, TS, M2TS, OGV.
- Folder name becomes a collection row on the home page (when it holds 2+ videos).
- Years in filenames like `Movie (2019).mp4` are parsed and shown as metadata.
- Optional Kodi-style `.nfo` files next to a video add title, plot, genres, and rating.
- Optional `poster.jpg` / `fanart.jpg` (or `<name>-poster.jpg` / `<name>-fanart.jpg`) are used as artwork.
- Thumbnails are generated from the video itself with ffmpeg and cached in `.cache/`.

### Change the library root

```powershell
$env:LIBRARY_ROOT='E:\Films'
npm start
```

Or edit the fallback logic in `server/index.js`. The root is `G:\Movies` when mounted, otherwise the project's `media\` folder. Port is configurable with `$env:PORT`.

## Features

- Netflix-style billboard with a muted in-page preview of the featured title
- Rows: Continue Watching, Recently Added, Top 10, collections, My List
- Hover cards with play shortcut, detail modal with technical metadata
- Search across your library and the online movie/series catalog, split into local results first and online results second
- Online title pages with overview, IMDb rating, genres, seasons and episode lists, plus legal watch links
- New & Popular page: search archive.org, pick a film or multi-file item, and download it into the library
- Downloads drawer with live progress, speed, cancel/retry, and automatic library refresh
- Free-download search for public-domain films when the online catalog has no local copy
- Custom player: resume, seek preview, buffered bar, volume, 10s skips, fullscreen, keyboard shortcuts
- Progress and My List saved in the browser
- Range-request streaming, so seeking works without copying the file
- Lazy thumbnail generation and persistent metadata cache

## Online catalog

Search covers mainstream movies and series through [Cinemeta](https://v3-cinemeta.strem.io), the keyless IMDb-backed metadata service behind Stremio. It has no API key and no account. Results are metadata only: poster, year, type, overview, IMDb rating, genres, and per-season episode data. The detail view links to JustWatch and IMDb for legal availability.

Examples that resolve correctly:

- `Cyberpunk: Edgerunners` — 2 seasons, 20 episodes
- `Peaky Blinders` — 6 seasons
- `Attack on Titan` — 4 seasons, 89 episodes

Cinemeta is community-run, so the server treats responses defensively, caches them (10 minutes for searches, 6 hours for titles), and returns a clear error if the provider is down. No legal API offers downloadable mainstream films or series, so online results never include a download button. Public-domain downloads remain separate under **Free downloads** in search and in **New & Popular**.

## Discover and download

Open **New & Popular** in the top nav (or **New** on mobile). Search archive.org or pick one of the curated titles. Click a card to see its files: choose one source and download it, or use **Download all** for a multi-file item. The download drawer tracks progress and offers cancel/retry. Finished files land in `G:\Movies\Downloads\` (or `Series\<title>\` for multi-file items) and show up in the library after the automatic rescan.

In the local search overlay, every query shows two sections: **In your library** first, then **Movies & series online**. The online section uses the IMDb-backed catalog and opens a detail view with seasons and legal watch links. Below both sections, **Free downloads** opens the archive.org search with that query already applied.

## Download sources

Two independent sources feed the download queue:

| Source | What it covers | Limits |
| --- | --- | --- |
| archive.org | Public-domain films and multi-part items | Public domain only |
| Castle (`api.hlowb.com`) | Mainstream movies, series and anime, with seasons, episodes, sizes and subtitle tracks | Keyless, but 1080p is premium-only; 720p and 480p download normally |

The Castle catalog is searched from the same overlay (**Downloadable** section) and from **New & Popular**. Any title opens a download dialog with season tabs, per-episode buttons, a quality picker, and **Download season**. The backend resolves a signed HLS playlist per episode and remuxes it to MP4 with ffmpeg, so the result is a plain H.264/AAC file the built-in player can stream. English subtitles are saved next to the video as `<name>.en.vtt`.

Verified coverage in the live catalog: Breaking Bad, Cyberpunk: Edgerunners, Better Call Saul, The Boys, Game of Thrones, Stranger Things, Severance, Peaky Blinders, The Last of Us, Squid Game, Succession, House of the Dragon, Money Heist, Attack on Titan, One Piece, plus mainstream films such as Interstellar, Inception, Oppenheimer, Dune, The Dark Knight, Parasite, Spirited Away and The Godfather. The Sopranos and The Wire are absent from this catalog.

## Keyboard shortcuts (player)

| Key | Action |
| --- | --- |
| Space / K | Play / pause |
| ← / → | Back / forward 10s |
| ↑ / ↓ | Volume |
| M | Mute |
| F | Fullscreen |

## API

| Route | Description |
| --- | --- |
| `GET /api/library` | Library items and collections |
| `POST /api/rescan` | Rescan the library folder |
| `GET /api/item/:id` | One item's metadata |
| `GET /api/stream/:id` | Video stream with HTTP range support |
| `GET /api/thumb/:id` | Generated thumbnail (JPEG) |
| `GET /api/art/:id/poster\|backdrop` | Local artwork if present |
| `GET /api/catalog/search?q=` | Search public-domain films on archive.org |
| `GET /api/catalog/fallback` | Built-in catalog used when archive.org is unreachable |
| `GET /api/catalog/item/:identifier` | Video files and metadata for one archive.org item |
| `GET /api/online/search?q=` | Search mainstream movies and series (Cinemeta metadata) |
| `GET /api/online/title/:type/:id` | Title detail with seasons and episodes (`type` is `movie` or `series`, `id` is an IMDb id) |
| `GET /api/castle/search?q=` | Search the downloadable Castle catalog (movies, series, anime) |
| `GET /api/castle/title/:id?season=` | Season and episode list with per-resolution sizes and subtitle tracks |
| `POST /api/castle/download` | Resolve one episode's HLS stream and queue an MP4 download |
| `POST /api/downloads` | Queue a film (or several files) for download |
| `POST /api/downloads/series` | Queue every video file from one item into a folder |
| `GET /api/downloads` | All download jobs with progress |
| `GET /api/downloads/:id` | One download job |
| `POST /api/downloads/:id/retry` | Retry a failed/cancelled job (resumes the `.part` file) |
| `DELETE /api/downloads/:id` | Cancel a queued or running download |

### Download films

The downloader accepts archive.org URLs only, so it stays limited to openly downloadable media. Files land in `<library root>\<collection>\`, then the library rescans automatically.

```powershell
# find something
curl "http://localhost:3000/api/catalog/search?q=his%20girl%20friday"

# inspect files (some items have several)
curl "http://localhost:3000/api/catalog/item/HisGirlFriday"

# queue the MP4 into G:\Movies\Classics
curl -X POST http://localhost:3000/api/downloads `
  -H "Content-Type: application/json" `
  -d '{"identifier":"HisGirlFriday","file":"MoviePowderPresentsHisGirlFriday.mp4","collection":"Classics"}'

# queue every video file from one item (e.g. a multi-part series)
curl -X POST http://localhost:3000/api/downloads/series `
  -H "Content-Type: application/json" `
  -d '{"identifier":"TheGreatTrainRobbery1903EdwinS.PorterUsa","collection":"Series"}'

# watch progress
curl "http://localhost:3000/api/downloads"

# cancel or retry
curl -X DELETE "http://localhost:3000/api/downloads/<job-id>"
curl -X POST "http://localhost:3000/api/downloads/<job-id>/retry"
```

If the archive.org search API is down, `GET /api/catalog/search` returns `source: "fallback"` with the curated public-domain list instead of failing. `GET /api/catalog/fallback` always returns that list. Single-film downloads also write a `.nfo` metadata file and a `-poster.jpg` next to the video when artwork is available.

### Download from the mainstream catalog

```powershell
# find a title and its catalogue id
curl "http://localhost:3000/api/castle/search?q=cyberpunk%20edgerunners"

# list seasons/episodes plus sizes and subtitle tracks
curl "http://localhost:3000/api/castle/title/10234075158397263?season=1"

# queue one episode: resolution 1=480p, 2=720p, 3=1080p (premium, usually refused)
curl -X POST http://localhost:3000/api/castle/download `
  -H "Content-Type: application/json" `
  -d '{"movieId":"6161299972855808","episodeId":"6161299974526976","resolution":2,"title":"Cyberpunk Edgerunners","season":1,"episode":1}'
```

Use the `movieId` of the season (not the series id) and the `episodeId` from the detail response. Movies use the same call with `season` and `episode` omitted.

## Notes

- Browser playback depends on codecs. H.264/AAC MP4 is universally safe. HEVC, DTS, and some MKV files may not play in Chrome or Firefox; the player shows a clear error when that happens.
- ffmpeg and ffprobe ship through npm (`ffmpeg-static`, `ffprobe-static`), so there is nothing to install on the machine.
- The UI is an original fan-made interface. Not affiliated with Netflix.
