# netflix-home

A Netflix-style web app for a local movie library. Point it at a folder (default `G:\NETFLIX`, with a local `media` folder as fallback), and every video file in it shows up as a title you can browse, search, and stream. The server can also download public-domain films from archive.org into the library.

![stack](https://img.shields.io/badge/node-20%2B-brightgreen) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

## Run it

```powershell
npm install
npm start
```

Open the URL it prints: `http://localhost:3000`, or a random free port when 3000 is already taken.

The server scans the library on startup. The header button (or the profile menu) is **Sync catalog**: it refreshes every Castle title already saved in `catalog.db`. To rescan the library folder after adding files, use **Scan library** on the empty home page.

### Build the single-file app

```powershell
npm run bundle
```

Produces `dist\netflix-home.exe` (~230 MB). Everything lives inside that one file: the server, the web UI, ffmpeg and ffprobe. On first launch it extracts the UI and the two binaries once into `<library root>\.cache\app\<buildId>\` and then serves from there.

### Publish to the library drive

```powershell
npm run deploy
```

Builds the EXE and copies it to `G:\NETFLIX`. Because the app is a single file, the target holds only `netflix-home.exe`, `Movies\` and `.cache\`; any `server\`, `public\`, `node_modules\` or `package*.json` left by older releases are deleted. Run it after every change so the copy on `G:` matches the source. Pass `-Target D:\somewhere` to publish elsewhere.

### Launch from the desktop

Double-click **`netflix-home.exe`**.

- no console window appears; the server starts hidden and the app opens in the default browser
- if the app is already running, a second launch just opens the page (it reads the port from `.cache\port`)
- if port 3000 is taken by something else, the server picks a random free port and opens that one
- it scans the folder it lives in (`G:\NETFLIX`), so the exe, the movies and the database stay together
- **Quit app** in the profile menu stops the server (`POST /api/quit`, loopback only). There is no tray icon.
- diagnostics go to `launcher.log` (gitignored)

## Library folder

Default root is `G:\NETFLIX` when that drive is mounted (the folder also holds `.cache\` and the exe). A `Movies` folder next to the app wins first, so the published copy always scans its own folder. If `G:` isn't there, the app falls back to `media\` inside the project (created automatically), so you can test without the external drive. Videos are picked up recursively from either location:

```
G:\NETFLIX\
├─ netflix-home.exe
├─ .cache\                 library.db, pictures.db, pictures\, hero previews, extracted UI
└─ Movies\
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
- Cards and the billboard use the title's **official artwork** (poster and backdrop) fetched once through Cinemeta and cached in `.cache\art\`; a frame sampled from the video is never used for a card. Local `poster.jpg` / `fanart.jpg` sidecars win when present.
- The sampled-frame picture database is only a legacy fallback: for each title several moments between 12 % and 82 % of the runtime are sampled, each frame is scored by edge density, and the best one is stored in `.cache\pictures.db` with its JPEG in `.cache\pictures\`.
- The cache lives in the library root, so moving the drive carries the database with it.

### Change the library root

```powershell
$env:LIBRARY_ROOT='E:\Films'
npm start
```

Or edit the fallback logic in `server/index.js`. The root is the folder beside the app when it has a `Movies` folder, then `G:\NETFLIX`, then `G:\Movies`, otherwise the project's `media\` folder.

The port starts at 3000 (or `$env:PORT`). If that port is busy, the server tries a random port between 20000 and 59999 (up to 8 times) and writes the one it got to `<library root>\.cache\port`; the launcher reads it back, and the exact URL is printed on startup.

## Features

- Netflix-style billboard with a cached hero still and a 12 s preview clip (built with ffmpeg, indexed in SQLite under `.cache\library.db`), so the home page never seeks a multi-GB file
- The billboard picks a different title on every load and plays that title's official trailer (id from Cinemeta, downloaded one at a time with `yt-dlp` into `.cache\trailers`), falling back to the cached clip and then the real stream; the title's main picture stays visible while the trailer buffers, then the video fades in when it actually plays
- Series in your library open a catalog-style sheet: hero art, **+ My List**, **Resume**, **Download all**, size line and season tabs; episodes already on disk get **Play** with their watched progress bar, the rest get **Download**. The library's own episodes draw immediately, so a local series opens without a loading wait (the catalog merge and skeleton only cover remote titles). Episode art is the catalog's own thumbnail — saved in `catalog.db` and reused by the player's Episodes panel — no frames are generated
- **Download all** queues every episode of every season, skips what is already on disk, and only turns into **Everything downloaded** when the whole series is local
- **Next episode** in the player: a downloaded episode plays straight away; one that is not on disk opens the series sheet on that season with the episode highlighted, ready to download
- One picture per title drawn from the official catalog artwork (resolved through Cinemeta and cached in `.cache\art`), so a card never shows a frame sampled from the video
- Rows: Continue Watching, Recently Added, Top 10, collections, My List. Continue Watching lists a show once — the latest episode of the season watched last — even when it lives in two folders
- My List saves library titles and downloadable catalog titles alike; catalog entries are stored as small snapshots and reopen their download sheet
- Skeleton placeholders while a series sheet loads its seasons and episodes
- Notifications (download started, finished, failed) show the title's picture, not just an icon
- Hover cards with play shortcut, detail modal with technical metadata
- The billboard's main action is a large white pill (64 px tall, 24 px label, 30 px triangle, dropping to 54 px on phones); sheets keep their normal **Play**/**Resume** button with a larger triangle inside
- Search across your library and the online movie/series catalog, split into local results first and online results second
- Local search tolerates typos ("cyberpunck" finds Cyberpunk) and keeps the last searches as removable chips
- Details, seasons, pictures and trailers of every Castle title you open are saved in `catalog.db` and reused, so a saved title opens instantly and stays available offline; **Sync catalog** refreshes them and fills in new artwork
- New & Popular is the **Online** page: browse the Castle catalog by mode and genre, then open any card to download it
- Offline switch in the header: the server stops all internet traffic and pauses downloads until it is off again; saved Castle titles, pictures, episode art and trailers keep working
- Online title pages with overview, IMDb rating, genres, seasons and episode lists, plus legal watch links
- Downloads from the Online page: pick a film or series, choose episodes, and it lands in the library
- Downloads drawer with live progress, speed, cancel/retry, and automatic library refresh
- Free-download search for public-domain films when the online catalog has no local copy
- Custom player: resume, seek preview, buffered bar, volume, large ±10 s skips, fullscreen, keyboard shortcuts; the control bar shows `SxxExx` in the middle (the title for a movie)
- Player subtitles from the `.vtt` sidecars, with language switching, a per-title timing offset, plus subtitle size and background-opacity controls. Defaults are English on, 100 % size, 0 % background, and the choice is stored once per series so every episode opens the same way
- **Skip Intro** appears only during the real intro window, taken from a local marker, the file's chapters, or the free IntroDB API (cached to `.cache\intro.json`); episodes with no known timing get no button instead of a guessed window
- Progress and My List saved in the browser
- Range-request streaming, so seeking works without copying the file
- Lazy thumbnail generation and persistent metadata cache

## Offline mode

The **Online/Offline** switch in the header is enforced by the server, not the browser. Turning it on writes `offline: true` to `.cache/settings.json`, answers 503 on every route that would reach the internet (`/api/online/*`, Castle search/browse/download/refresh, `/api/catalog/search`, `/api/catalog/item/*`, and new download requests), and pauses active downloads. Castle data already saved in `catalog.db` stays readable: the title sheet, posters/backdrops, episode pictures, trailers and the Sync status route all keep answering offline. Paused jobs keep their `.part` file and resume when the switch goes back to Online. Fonts are served from `public/fonts`, so the page makes no external requests at all while offline.

Cancelling a download removes the job and deletes its `.part` file, so cancelled items never show up under Finished.

## Online catalog

Search covers mainstream movies and series through [Cinemeta](https://v3-cinemeta.strem.io), the keyless IMDb-backed metadata service behind Stremio. It has no API key and no account. Results are metadata only: poster, year, type, overview, IMDb rating, genres, and per-season episode data. The detail view links to JustWatch and IMDb for legal availability.

Examples that resolve correctly:

- `Cyberpunk: Edgerunners` — 2 seasons, 20 episodes
- `Peaky Blinders` — 6 seasons
- `Attack on Titan` — 4 seasons, 89 episodes

Cinemeta is community-run, so the server treats responses defensively, caches them (10 minutes for searches, 6 hours for titles), and returns a clear error if the provider is down. No legal API offers downloadable mainstream films or series, so online results never include a download button. Public-domain downloads remain separate under **Free downloads** in search and in **New & Popular**.

## Discover and download

Open **Online** in the top nav (or **New** on mobile). Browse the Castle catalog by mode and genre or shuffle it, then click a card to open its download sheet: season tabs, per-episode buttons, and **Download all** for a series. The download drawer tracks progress and offers cancel/retry. Finished files land in the library folder (or `Series\<title>\` for a series) and show up after the automatic rescan.

In the local search overlay, every query shows two sections: **In your library** first, then **Movies & series online** (Cinemeta metadata) and **Downloadable** (Castle). The online section opens with seasons and legal watch links; the downloadable section opens the Castle sheet. Below both, **Free downloads** opens the archive.org search with that query already applied.

## Download sources

Two independent sources feed the download queue:

| Source | What it covers | Limits |
| --- | --- | --- |
| archive.org | Public-domain films and multi-part items | Public domain only |
| Castle (`api.hlowb.com`) | Mainstream movies, series and anime, with seasons, episodes, sizes and subtitle tracks | Keyless, but 1080p is premium-only; 720p and 480p download normally |

The Castle catalog is searched from the same overlay (**Downloadable** section) and browsed on the **Online** page. Any title opens a download dialog with season tabs, per-episode buttons and **Download all**, which covers every season of the series; downloads are fixed at 720p. The backend resolves a signed HLS playlist per episode and remuxes it to MP4 with ffmpeg, so the result is a plain H.264/AAC file the built-in player can stream. Every subtitle track the service offers (original language, English and the rest) is saved next to the video as `<name>.<lang>.vtt`.

When Castle has no English track, the free OpenSubtitles REST endpoint (`rest.opensubtitles.org`) fills the gap: it is searched by IMDb id, season and episode, the best `.srt` is downloaded and converted to `.vtt`. The player also calls the same fallback lazily through `/api/subtitles/:id`, so older local downloads gain an English track next to their original-language one. Some seasons simply have no Italian release; the player then lists only the tracks that exist.

Verified coverage in the live catalog: Breaking Bad, Cyberpunk: Edgerunners, Better Call Saul, The Boys, Game of Thrones, Stranger Things, Severance, Peaky Blinders, The Last of Us, Squid Game, Succession, House of the Dragon, Money Heist, Attack on Titan, One Piece, plus mainstream films such as Interstellar, Inception, Oppenheimer, Dune, The Dark Knight, Parasite, Spirited Away and The Godfather. The Sopranos and The Wire are absent from this catalog.

## Keyboard shortcuts (player)

| Key | Action |
| --- | --- |
| Space / K | Play / pause |
| ← / → | Back / forward 10s |
| ↑ / ↓ | Volume |
| M | Mute |
| F | Fullscreen |
| C | Subtitle language and timing panel |

## API

| Route | Description |
| --- | --- |
| `GET /api/library` | Library items and collections |
| `POST /api/rescan` | Rescan the library folder |
| `GET /api/item/:id` | One item's metadata |
| `GET /api/next/:id` | Next episode of a series: `kind: "local"` with an id to play, `kind: "catalog"` with season/episode to download, or `kind: "none"` |
| `GET /api/intro/:id` | Intro window for the Skip Intro button: `startSec`/`endSec` from a sidecar, the cache, chapters or IntroDB, or `null` when none is known |
| `POST /api/intro/:id` | Save a manual intro window (`{"startSec": 71, "endSec": 161}`) |
| `GET /api/subtitles/:id` | Subtitle tracks found next to the video (`.en.vtt`, `.fr.vtt`, …) |
| `GET /api/subtitle/:id/:lang` | One WebVTT subtitle file |
| `GET /api/settings` | App settings, including the offline flag |
| `POST /api/settings/offline` | Turn offline mode on or off (`{"offline": true}`); pauses or resumes downloads |
| `GET /api/stream/:id` | Video stream with HTTP range support |
| `GET /api/thumb/:id` | Cached picture for one title (JPEG; `?w=` picks 480/640/1280) |
| `POST /api/quit` | Stop the app (loopback callers only; used by **Quit app** in the profile menu) |
| `GET /api/hero/:id` | Whether the cached hero still/clip is ready, and where it starts |
| `GET /api/hero/:id/image.jpg` | Cached hero still (falls back to a generated thumbnail) |
| `GET /api/hero/:id/preview.mp4` | 12 s cached preview clip used by the home billboard |
| `GET /api/hero/:id/trailer.mp4` | Official trailer for the billboard (downloaded once with `yt-dlp`) |
| `GET /api/art/:id/poster\|backdrop` | Official catalog artwork (local sidecar file first, then `.cache\art\`) |
| `GET /api/series/:key/catalog` | Every known episode of a series with catalog ids and a default quality |
| `GET /api/catalog/search?q=` | Search public-domain films on archive.org |
| `GET /api/catalog/fallback` | Built-in catalog used when archive.org is unreachable |
| `GET /api/catalog/item/:identifier` | Video files and metadata for one archive.org item |
| `GET /api/online/search?q=` | Search mainstream movies and series (Cinemeta metadata) |
| `GET /api/online/title/:type/:id` | Title detail with seasons and episodes (`type` is `movie` or `series`, `id` is an IMDb id) |
| `GET /api/castle/search?q=` | Search the downloadable Castle catalog (movies, series, anime) |
| `GET /api/castle/title/:id?season=` | Season and episode list with per-resolution sizes and subtitle tracks (saved row first) |
| `GET /api/castle/series/:id/episodes` | Every season with its full episode list, used by **Download all** |
| `GET /api/castle/art/:id/poster\|backdrop` | Saved Castle poster/backdrop; downloaded into `catalog.db` on first request and readable offline |
| `GET /api/castle/episode-art/:episodeId` | Saved Castle episode thumbnail |
| `GET /api/castle/trailer/:id` | Trailer status for a saved Castle title (queues it on first call) |
| `GET /api/castle/trailer/:id/file.mp4` | Trailer file for a saved Castle title |
| `GET /api/castle/sync` | Sync progress: running, counts, saved titles and saved pictures |
| `POST /api/castle/sync` | Refresh every saved Castle title, fill in new artwork, queue missing trailers |
| `POST /api/castle/download` | Resolve one episode's HLS stream and queue an MP4 download |
| `POST /api/downloads` | Queue a film (or several files) for download |
| `POST /api/downloads/series` | Queue every video file from one item into a folder |
| `GET /api/downloads` | All download jobs with progress |
| `GET /api/downloads/:id` | One download job |
| `POST /api/downloads/:id/retry` | Retry a failed/cancelled job (resumes the `.part` file) |
| `DELETE /api/downloads/:id` | Cancel and remove a download; deletes its `.part` file |

### Download films

The downloader accepts archive.org URLs and Castle HLS streams, so it covers openly downloadable media and the keyless Castle catalog. Files land in `<library root>\<collection>\`, then the library rescans automatically.

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
- Hero previews are generated in the background (two at a time) and stored next to the library in `.cache\hero\`; the index lives in `.cache\library.db` (SQLite via Node's built-in `node:sqlite`, no extra dependency). Delete the folder to force a rebuild.
- Card pictures are indexed in `.cache\pictures.db` and written to `.cache\pictures\`; delete either to force a rebuild.
- The UI is an original fan-made interface. Not affiliated with Netflix.
