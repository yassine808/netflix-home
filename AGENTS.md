# AGENTS — netflix-home

## What this is

A local, Netflix-style streaming app. Node/Express backend scans a movie folder (default `G:\NETFLIX`), probes files with ffmpeg/ffprobe, keeps a picture database (one chosen still per title), builds cached hero previews, streams video with HTTP range support, and downloads public-domain and catalog films. Vanilla JS frontend in `public/`.

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
Invoke-WebRequest "http://localhost:3000/api/thumb/<id>" -SkipHttpErrorCheck
```

## Layout

- `bundle/build.mjs` — esbuild CJS bundle, SEA blob, postject injection, PE subsystem patch (no console window)
- `bundle/entry.js` — resolves the library root, extracts UI + ffmpeg once to `.cache\app\<buildId>`, single-instance check, opens the browser, writes `launcher.log`
- `bundle/shims/` — `ffmpeg-static` / `ffprobe-static` replacements that read `FFMPEG_PATH` / `FFPROBE_PATH`
- `server/index.js` — Express routes: library, rescan, stream, thumbnail, artwork, item, hero, series catalog, `POST /api/quit`
- `server/library.js` — folder walk, filename/NFO parsing, ffprobe metadata cache; `ensureThumb` delegates to the picture cache
- `server/pictures.js` — `pictures.db`: picks a still per title by edge density over several sampled moments, stores the JPEG in `.cache\pictures\`
- `server/hero.js` — SQLite-indexed hero stills + 12 s preview clips, background warm-up
- `server/audio.js` — audio-track probe + on-demand dub remux into `.cache\audio\`
- `public/index.html` + `app.js` + `styles.css` — home UI, search, series/detail sheets
- `public/watch.html` + `watch.js` + `watch.css` — custom player
- `public/common.js` — shared formatting, storage, and API helpers
- `<library root>\.cache\` — `library.db`, `pictures.db`, `pictures\`, `hero\`, `app\` (extracted UI), `port`, settings (gitignored)
- `deploy.ps1` — copies the built EXE to `G:\NETFLIX` and removes legacy `server/public/node_modules/package*.json`
- `media/` — fallback library used when no `G:` location exists; test videos can live here (gitignored)
- `G:\NETFLIX\` — real deployment: `Movies\`, `.cache\`, `netflix-home.exe`

## Conventions

- Vanilla ES modules, no framework. The bundler is only for the single-file EXE.
- Build user-facing DOM with `textContent` or `createEl`, never interpolate filenames into `innerHTML` (local files can contain arbitrary characters).
- Keep the Netflix look: black/near-black surfaces, `#e50914` red, white play buttons, 16:9 cards.
- Progress and My List live in `localStorage`; don't move them server-side without a reason.
- Paths from IDs are resolved and checked against the library root in `resolveItemFile`.
- The library root is resolved once: `LIBRARY_ROOT` → an exact `Movies` folder beside the app → `G:\NETFLIX` → `G:\Movies` → `G:\` → project `media\`. Compare directory names exactly; Windows is case-insensitive but the project also has `media\`.
- Series click opens the catalog sheet (`openSeriesSheet`), which merges local episodes into the Castle episode list: local episodes get **Play** plus their progress bar, the rest keep **Download**. Episode thumbnails are the catalog API's images; never generate frames for that sheet.
- The player's **Next episode** button asks `GET /api/next/:id`. Local result → `/watch.html?id=<next>`; catalog result → `/?open=<current id>&season=<n>&episode=<n>`, which `boot()` turns into the series sheet with that season open and the row highlighted (`.is-target`).
- The player has no playback-speed control; the ±10 s jumps are 54 px with 32 px icons.
- **Dubs/audio tracks**: every HLS download maps all audio renditions (`-map 0:v:0 -map 0:a?`), so the original language and the English dub both land in the file. Browsers can only play the first audio stream, so the player fetches another track as `/api/stream/<id>?audio=<streamIndex>`, which remuxes it once (`-c copy`) into `.cache\audio\` and caches by id + mtime + track. The CC panel's Audio section lists `/api/audio/<id>` and hides itself for single-track files; the pick is stored per series under `netflix-home:audio:series:<key>`.
- **Skip Intro** windows come from `server/intro.js` in this order: `<name>.intro.json` sidecar → `.cache\intro.json` → ffprobe chapters → IntroDB (`https://api.introdb.app/intro?imdb_id=&season=&episode=`, keyless; the IMDb id is resolved once per series through Cinemeta). Results are cached per episode (`<seriesKey>#s<n>e<n>`). There is no guessed fallback: unknown timing means no button, so the cold open is never skipped.

## Gotchas

- Windows paths: IDs are base64url of the path relative to the root.
- Pictures are generated on demand by `server/pictures.js` and indexed per width in `pictures.db`; a title's JPEG path is `<sha1(id)>-<width>.jpg`.
- Subtitles are plain sidecar `.vtt` files next to the video (`<name>.<lang>.vtt`); `/api/subtitles` scans the folder, so adding a file needs no rescan. Castle supplies most of them; OpenSubtitles legacy REST (`rest.opensubtitles.org/search/episode-<e>/imdbid-<id>/season-<s>/sublanguageid-<lang>`, `User-Agent` required, `.srt.gz`) fills the rest.
- Hero rows must be returned normalized (`{image, video, startSec, builtAt}`); the raw SQLite row uses snake_case and breaks the preview route.
- `node:sqlite` is built into Node 22+; no dependency to install. Load it with `createRequire(process.execPath)('node:sqlite')` — top-level `await import` breaks CJS SEA bundling.
- The EXE is GUI-subsystem: there is no console and no tray icon. Quit through the profile menu (`POST /api/quit`, loopback only). A second launch probes `.cache\port` and only opens the browser.
- postject prints `warning: The signature seems corrupted!` during injection — expected.
- npm 11 blocks install scripts by default; if `ffmpeg-static/ffmpeg.exe` is missing, run `npm install-scripts approve ffmpeg-static` or the package's `install.js`.
- Never commit `.cache/`, `node_modules/`, `dist/`, `.build/`, `bundle/manifest.json`, or downloaded media.