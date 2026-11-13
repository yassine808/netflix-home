# AGENTS — netflix-home

## What this is

A local, Netflix-style streaming app. Node/Express backend scans a movie folder (default `G:\Movies`), probes files with ffmpeg/ffprobe, generates thumbnails, streams video with HTTP range support, and downloads public-domain films from archive.org. Vanilla JS frontend in `public/`.

## Commands

```powershell
npm install          # deps: express, ffmpeg-static, ffprobe-static
npm start            # http://localhost:3000, scans G:\Movies
npm run dev          # node --watch
start.vbs            # hidden server + browser + minimized taskbar button (launcher.ps1)
```

There is no test suite and no build step. Verify by starting the server and hitting the API:

```powershell
Invoke-RestMethod http://localhost:3000/api/library
```

## Layout

- `server/index.js` — Express routes: library, rescan, stream, thumbnail, artwork, item
- `server/library.js` — folder walk, filename/NFO parsing, ffprobe metadata cache, thumbnail queue
- `public/index.html` + `app.js` + `styles.css` — home UI, search, modal
- `public/watch.html` + `watch.js` + `watch.css` — custom player
- `public/common.js` — shared formatting, storage, and API helpers
- `.cache/` — generated metadata and thumbnails (gitignored)
- `start.vbs` + `launcher.ps1` — desktop launcher: hidden server, opens the browser, minimized taskbar button
- `media/` — fallback library used when `G:\Movies` is not mounted; test videos can live here (gitignored)
- `G:\Movies` — preferred library location; root is configurable via `LIBRARY_ROOT`

## Conventions

- Vanilla ES modules, no framework, no bundler.
- Build user-facing DOM with `textContent` or `createEl`, never interpolate filenames into `innerHTML` (local files can contain arbitrary characters).
- Keep the Netflix look: black/near-black surfaces, `#e50914` red, white play buttons, 16:9 cards.
- Progress and My List live in `localStorage`; don't move them server-side without a reason.
- Paths from IDs are resolved and checked against the library root in `resolveItemFile`.

## Gotchas

- Windows paths: IDs are base64url of the path relative to the root.
- Thumbnails are generated on demand and cached by ID hash.
- npm 11 blocks install scripts by default; if `ffmpeg-static/ffmpeg.exe` is missing, run `npm install-scripts approve ffmpeg-static` or the package's `install.js`.
- Never commit `.cache/`, `node_modules/`, or downloaded media.
