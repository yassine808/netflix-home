# netflix-home

A Netflix-style web app for a local movie library. Point it at a folder (default `G:\`, with a local `media` folder as fallback), and every video file in it shows up as a title you can browse, search, and stream.

![stack](https://img.shields.io/badge/node-20%2B-brightgreen) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

## Run it

```powershell
npm install
npm start
```

Open http://localhost:3000

The server scans the library on startup. Use the refresh button in the header (or the profile menu) to rescan after adding files.

## Library folder

Default root is `G:\` when that drive is mounted. If it isn't, the app falls back to `media\` inside the project (created automatically), so you can test without the external drive. Videos are picked up recursively from either location:

```
G:\
└─ Movies\
   ├─ Blender\
   │  ├─ Big Buck Bunny (2008).mp4
   │  └─ Sintel (2010).mkv
   └─ Tears of Steel (2012).mp4
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

Or edit the fallback logic in `server/index.js`. The root is `G:\` when mounted, otherwise the project's `media\` folder. Port is configurable with `$env:PORT`.

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

## Notes

- Browser playback depends on codecs. H.264/AAC MP4 is universally safe. HEVC, DTS, and some MKV files may not play in Chrome or Firefox; the player shows a clear error when that happens.
- ffmpeg and ffprobe ship through npm (`ffmpeg-static`, `ffprobe-static`), so there is nothing to install on the machine.
- The UI is an original fan-made interface. Not affiliated with Netflix.
