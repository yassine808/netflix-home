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
- Search across titles, filenames, genres, years, collections
- Custom player: resume, seek preview, buffered bar, volume, 10s skips, fullscreen, keyboard shortcuts
- Progress and My List saved in the browser
- Range-request streaming, so seeking works without copying the file
- Lazy thumbnail generation and persistent metadata cache

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

## Notes

- Browser playback depends on codecs. H.264/AAC MP4 is universally safe. HEVC, DTS, and some MKV files may not play in Chrome or Firefox; the player shows a clear error when that happens.
- ffmpeg and ffprobe ship through npm (`ffmpeg-static`, `ffprobe-static`), so there is nothing to install on the machine.
- The UI is an original fan-made interface. Not affiliated with Netflix.
