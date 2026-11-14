# AGENTS — netflix-home

## What this is

A local, Netflix-style streaming app. Node/Express backend scans a movie folder (default `G:\NETFLIX`), probes files with ffmpeg/ffprobe, records everything it knows in one SQLite catalog (`catalog.db`), builds cached hero previews, streams video with HTTP range support, and downloads films and episodes from the Castle catalog. Vanilla JS frontend in `public/`.

The shipped artifact is a **single self-contained EXE**: server, UI, ffmpeg and ffprobe are bundled with Node SEA (`bundle/`), so the deployment folder holds only the EXE, the videos and `.cache/`.

## Commands

```powershell
npm install          # deps: express, ffmpeg-static, ffprobe-static, esbuild, postject (dev)
npm start            # dev server, port 3000 (random free port if taken)
npm run dev          # node --watch
npm run bundle       # build dist\netflix-home.exe (esbuild → SEA blob → postject → GUI subsystem)
npm run deploy       # bundle, then copy the EXE to G:\NETFLIX and clean legacy folders
```

Run `npm run deploy` after every app change: the copy in `G:\NETFLIX` is what Yassine actually launches, and it must match the source. `deploy.ps1` alone only copies an existing build, so run `npm run bundle` first when you changed `public/` or `server/`.

There is no test suite. Verify by starting the server and hitting the API, then exercising the UI over CDP:

```powershell
Invoke-RestMethod http://localhost:3000/api/library
Invoke-RestMethod http://localhost:3000/api/db/stats
Invoke-WebRequest "http://localhost:3000/api/thumb/<id>" -SkipHttpErrorCheck
```

## Layout

- `bundle/build.mjs` — esbuild CJS bundle, SEA blob, postject injection, PE subsystem patch (no console window)
- `bundle/entry.js` — resolves the library root, extracts UI + ffmpeg once to `.cache\app\<buildId>`, single-instance check, opens the browser, writes `launcher.log`
- `bundle/shims/` — `ffmpeg-static` / `ffprobe-static` replacements that read `FFMPEG_PATH` / `FFPROBE_PATH`
- `server/index.js` — Express routes: library, rescan, stream, thumbnail, artwork, item, hero, series catalog, `GET /api/db/stats`, `POST /api/quit`
- `server/library.js` — folder walk with a saved directory index, filename/NFO parsing, ffprobe metadata, `items` table (payload JSON), instant library load from the DB on boot
- `server/db.js` — **one** SQLite database (`.cache\catalog.db`): schema, WAL pragmas, one-time migration from the old `pictures.db` / `library.db` / `trailers.db`, asset helpers, `dbStats`
- `server/pictures.js` — picks a still per title by edge density over several sampled moments, stores the JPEG in `.cache\pictures\` and the row in `catalog.db`
- `server/hero.js` — hero stills + 12 s preview clips indexed in `catalog.db`, background warm-up
- `server/artwork.js` — Cinemeta poster/backdrop/logo downloaded once into `assets` BLOBs, served with an ETag; `warmArtwork` imports legacy `.cache\art` files
- `server/subs.js` — subtitle sidecars read once into the `subtitles` table, body served from the DB with an ETag
- `server/audio.js` — audio-track probe cached in `audio_probe` / `audio_tracks`, on-demand dub remux into `.cache\audio\`
- `public/index.html` + `app.js` + `styles.css` — home UI, search, series/detail sheets
- `public/watch.html` + `watch.js` + `watch.css` — custom player
- `public/common.js` — shared formatting, storage, and API helpers
- `<library root>\.cache\` — `catalog.db`, `pictures\`, `hero\`, `audio\`, `art\`, `frames\`, `trailers\`, `app\` (extracted UI), `port`, settings (gitignored)
- `deploy.ps1` — copies the built EXE to `G:\NETFLIX` and removes legacy `server/public/node_modules/package*.json`
- `media/` — fallback library used when no `G:` location exists; test videos can live here (gitignored)
- `G:\NETFLIX\` — real deployment: `Movies\`, `.cache\`, `netflix-home.exe`

## Conventions

- Vanilla ES modules, no framework. The bundler is only for the single-file EXE.
- **Everything metadata-ish lives in `catalog.db`.** One `node:sqlite` connection (`server/db.js`) owns the file, opened with WAL, `synchronous=NORMAL`, `busy_timeout=5000`, a 32 MB page cache and mmap. Small assets (posters, backdrops, logos, subtitle text) are rows in `assets` / `subtitles`; large media (pictures, hero stills/clips, trailers, dub MP4s) stay on disk and are indexed by path. Do not add a second database file for a new feature: add a table to `db.js` and a prepared statement in the owning module.
- Scans write inside one `transaction()`; the HTTP side reads from memory, so a scan never blocks a request.
- **A launch never re-probes the library.** `dirs` stores each folder's listing (name/size/mtime); `walkIndexed` re-lists the folder, reuses saved sizes for names that still exist and stats only new ones. Directory mtimes alone are unreliable on NTFS (lazily updated), so the listing is always read and mtimes are only a hint. A scan that changes nothing keeps `updatedAt`, so the `/api/library` ETag stays stable and browsers get `304`. `fs.watch(libraryRoot, {recursive:true})` triggers the same debounced refresh (2.5 s, `.cache` and `*.part` ignored) instead of a launch crawl. Do not add a second scan path: call `refreshLibrary(reason)` in `index.js`.
- `plan.md` holds the performance roadmap (low-priority ffmpeg, gzip, sized artwork, DOM diffing); keep measurements there and in `progress.md` when a phase lands.
- `/api/library`, `/api/art/*` and `/api/subtitle/*` send an ETag and answer `304 Not Modified`, and `getLibrary()` in `public/common.js` uses `cache: 'no-cache'` so every navigation revalidates instead of downloading 20 KB again. `GET /api/db/stats` returns file size and row counts for debugging.
- **Top nav is Home / Local / Favourite / Online.** `Local` lists the library, `Favourite` lists My List entries (local + Castle snapshots), and `Online` draws 30 random catalog titles from `GET /api/castle/browse` (merged genre searches, cached until **Shuffle** sends `?fresh=1`). archive.org is gone: no `/api/catalog/*` routes, no picker sheet.
- Build user-facing DOM with `textContent` or `createEl`, never interpolate filenames into `innerHTML` (local files can contain arbitrary characters).
- Keep the Netflix look: black/near-black surfaces, `#e50914` red, white play buttons, 16:9 cards.
- Progress and My List live in `localStorage`; don't move them server-side without a reason.
- **One card per title.** `seriesKey` is derived from the show's title only, never from its folder, so the same series under `Downloads\` and `Movies\Downloads\` stays one show: one card, one episode list, and Next episode crosses folders. The home page groups series by normalized title as a second guard, and `group.ids` keeps every file id of a title mapped to its card so search and My List never draw a second card for a duplicate-quality copy. Downloads skip a file whose name already exists anywhere in the library instead of writing a `" (1)"` copy.
- Paths from IDs are resolved and checked against the library root in `resolveItemFile`.
- The library root is resolved once: `LIBRARY_ROOT` → an exact `Movies` folder beside the app → `G:\NETFLIX` → `G:\Movies` → `G:\` → project `media\`. Compare directory names exactly; Windows is case-insensitive but the project also has `media\`.
- Series click opens the catalog sheet (`openSeriesSheet`), which merges local episodes into the Castle episode list: local episodes get **Play** plus their progress bar, the rest keep **Download**. Episode thumbnails are the catalog API's images; never generate frames for that sheet.
- The player's **Next episode** button asks `GET /api/next/:id`. Local result → `/watch.html?id=<next>`; catalog result → `/?open=<current id>&season=<n>&episode=<n>`, which `boot()` turns into the series sheet with that season open and the row highlighted (`.is-target`).
- The player has no playback-speed control; the ±10 s jumps are 54 px with 32 px icons.
- **Dubs/audio tracks**: every HLS download maps all audio renditions (`-map 0:v:0 -map 0:a?`), so the original language and the English dub both land in the file. Browsers can only play the first audio stream, so the player fetches another track as `/api/stream/<id>?audio=<streamIndex>`, which remuxes it once (`-c copy`) into `.cache\audio\` and caches by id + mtime + track. The CC panel's Audio section lists `/api/audio/<id>` and hides itself for single-track files; the pick is stored per series under `netflix-home:audio:series:<key>`.
- **Skip Intro** windows come from `server/intro.js` in this order: `<name>.intro.json` sidecar → `.cache\intro.json` → ffprobe chapters → IntroDB (`https://api.introdb.app/intro?imdb_id=&season=&episode=`, keyless; the IMDb id is resolved once per series through Cinemeta). Results are cached per episode (`<seriesKey>#s<n>e<n>`). There is no guessed fallback: unknown timing means no button, so the cold open is never skipped.

## Gotchas

- Windows paths: IDs are base64url of the path relative to the root.
- Pictures are generated on demand by `server/pictures.js`; the JPEG lives at `<cache>\pictures\<sha1(id)>-<width>.jpg` and its row in `catalog.db` keeps source size/mtime so a rebuild only happens when the video changes.
- Subtitles are plain sidecar `.vtt` files next to the video (`<name>.<lang>.vtt`); `syncSubtitleTracks` reads them into `catalog.db` once per directory-mtime change, and `/api/subtitle/:id/:lang` serves the stored body. Castle supplies most of them; OpenSubtitles legacy REST (`rest.opensubtitles.org/search/episode-<e>/imdbid-<id>/season-<s>/sublanguageid-<lang>`, `User-Agent` required, `.srt.gz`) fills the rest and the file is picked up on the next directory change.
- Legacy `pictures.db`, `library.db` and `trailers.db` are migrated once via `ATTACH` (only when the target table is empty) and then left on disk; `meta.json` is read only as a first-upgrade probe cache. Don't resurrect them as write targets.
- Hero rows must be returned normalized (`{image, video, startSec, builtAt}`); the raw SQLite row uses snake_case and breaks the preview route.
- `node:sqlite` is built into Node 22+; no dependency to install. `server/db.js` loads it with `createRequire(process.execPath)('node:sqlite')` — a top-level `await import` breaks CJS SEA bundling.
- The EXE is GUI-subsystem: there is no console and no tray icon. Quit through the profile menu (`POST /api/quit`, loopback only). A second launch probes `.cache\port` and only opens the browser.
- postject prints `warning: The signature seems corrupted!` during injection — expected.
- npm 11 blocks install scripts by default; if `ffmpeg-static/ffmpeg.exe` is missing, run `npm install-scripts approve ffmpeg-static` or the package's `install.js`.
- Never commit `.cache/`, `node_modules/`, `dist/`, `.build/`, `bundle/manifest.json`, or downloaded media.