# AGENTS — netflix-home

## What this is

A local, Netflix-style streaming app. Node/Express backend scans a movie folder (default `G:\NETFLIX`), probes files with ffmpeg/ffprobe, generates thumbnails, builds cached hero previews, streams video with HTTP range support, and downloads public-domain films from archive.org. Vanilla JS frontend in `public/`.

## Commands

```powershell
npm install          # deps: express, ffmpeg-static, ffprobe-static
npm start            # scans the library root; port 3000, or a random free port if 3000 is taken
npm run dev          # node --watch
npm run deploy       # publish server/, public/, node_modules/ and the exe to G:\NETFLIX
netflix-home.exe     # hidden server + browser + tray icon (source: launcher.cs)
```

Run `npm run deploy` after every app change: the copy in `G:\NETFLIX` is what Yassine actually launches, and it must match the source.

There is no test suite and no build step. Verify by starting the server and hitting the API:

```powershell
Invoke-RestMethod http://localhost:3000/api/library
```

## Layout

- `server/index.js` — Express routes: library, rescan, stream, thumbnail, artwork, item, hero, series catalog
- `server/library.js` — folder walk, filename/NFO parsing, ffprobe metadata cache, thumbnail queue
- `server/hero.js` — SQLite-indexed hero stills + 12 s preview clips, background warm-up
- `public/index.html` + `app.js` + `styles.css` — home UI, search, modal
- `public/watch.html` + `watch.js` + `watch.css` — custom player
- `public/common.js` — shared formatting, storage, and API helpers
- `<library root>\.cache\` — `library.db`, thumbnails, frames, `hero\`, settings (gitignored)
- `netflix-home.exe` + `launcher.cs` — desktop launcher: hidden server, opens the browser, tray icon
- `deploy.ps1` — builds the exe and mirrors the app to `G:\NETFLIX`
- `media/` — fallback library used when no `G:` location exists; test videos can live here (gitignored)
- `G:\NETFLIX\` — real deployment: `Movies\`, `.cache\`, `server\`, `public\`, `node_modules\`, `netflix-home.exe`

## Conventions

- Vanilla ES modules, no framework, no bundler.
- Build user-facing DOM with `textContent` or `createEl`, never interpolate filenames into `innerHTML` (local files can contain arbitrary characters).
- Keep the Netflix look: black/near-black surfaces, `#e50914` red, white play buttons, 16:9 cards.
- Progress and My List live in `localStorage`; don't move them server-side without a reason.
- Paths from IDs are resolved and checked against the library root in `resolveItemFile`.
- The library root is resolved once: `LIBRARY_ROOT` → an exact `Movies` folder beside the app → `G:\NETFLIX` → `G:\Movies` → `G:\` → project `media\`. Compare directory names exactly; Windows is case-insensitive but the project also has `media\`.

## Gotchas

- Windows paths: IDs are base64url of the path relative to the root.
- Thumbnails are generated on demand and cached by ID hash.
- Hero rows must be returned normalized (`{image, video, startSec, builtAt}`); the raw SQLite row uses snake_case and breaks the preview route.
- `node:sqlite` is built into Node 22+; no dependency to install.
- The deployed copy is self-contained (its own `node_modules`), so a change only reaches `G:\NETFLIX` after `npm run deploy`.
- npm 11 blocks install scripts by default; if `ffmpeg-static/ffmpeg.exe` is missing, run `npm install-scripts approve ffmpeg-static` or the package's `install.js`.
- Never commit `.cache/`, `node_modules/`, or downloaded media.
