# Progress — netflix-home

## Plan
- [x] Create local git repo and project folder `D:\Projects\netflix-home`
- [x] Build library scanner, metadata extraction, thumbnail cache
- [x] Build streaming API with range requests
- [x] Build Netflix-style home UI, rows, search, detail modal
- [x] Build custom video player with resume and progress saving
- [x] Download sample movies (to project `media\` fallback — G: absent) and verify end-to-end
- [x] Visual QA in the browser and fixes
- [x] Commit
- [x] Make the GitHub repo private
- [x] Add archive.org catalog + download APIs with fallback
- [x] Add multi-file/series download API
- [x] Connect catalog + download APIs to the UI (New & Popular, picker, downloads drawer, search fallback)
- [x] Replace archive.org-only search with a keyless IMDb-backed movie/series catalog and split search into local-first and online sections
- [x] Move the library to `G:\Movies`
- [x] Castle catalog integration: search, season/episode detail, HLS → MP4 downloads, download dialog in the UI
- [x] Verify mainstream coverage (Cyberpunk, Breaking Bad and 20+ other popular titles) and download real episodes end-to-end
- [x] Startup film: remove Skip/Sound-on buttons, always play with sound at a lower volume
- [x] Fix the empty circular list button and the bright line under the hero in the detail modal
- [x] Series modal: list every episode with Play for local files and Download for missing ones
- [x] SQLite hero cache (`library.db`) for each title's still + 12 s preview clip
- [x] Move everything to `G:\NETFLIX` (Movies + `.cache` database + exe) and add `npm run deploy`
- [ ] Cyberpunk: Edgerunners 2 download (season 2 is in the Castle catalog; nothing is blocking it now)

## Log

### 2026-11-13 — project setup and first build
- Goal: Netflix-like local movie app, videos under `G:\`.
- Done: git repo, Express server, scanner (ffprobe + ffmpeg thumbnails), range streaming, home UI, search, modal, custom player, docs.
- Verified: pending — server not started yet.
- Next: download test films, start server, check API and playback.

### 2026-11-13 — test library, playback QA, UI fixes
- Goal: verify end-to-end playback and visual fidelity.
- Done: downloaded `Nosferatu (1922)` and `Night of the Living Dead (1968)` into `media\Classics` (G: was absent); fixed `[hidden]` CSS override, year parsing, short-clip durations, search overlay opacity/clear button, Top 10 image layering; moved card play button top-right; added mobile bottom nav; added `cropdetect` thumbnail pass; added fallback root logic (`LIBRARY_ROOT` → `G:\` → `G:\Movies` → project `media\`).
- Verified: `/api/library` returns 2 titles with ffprobe metadata; thumbs HTTP 200 (~47 KB); stream responds `206 Partial Content` with correct `Content-Range`; Brave/puppeteer QA with no console errors — modal, Movies view, search, player autoplay/pause, resume progress bar, My List row; mobile 390×844 no horizontal overflow; Top 10 row renders ranks 1–6 with loaded images.
- Next: commit; G: drive restoration.

### 2026-11-13 — G: drive missing (blocked)
- Goal: restore `G:\` so library lives on the external drive.
- Done: inspected disks/volumes/PnP. Windows shows only internal SATA disks (0–3); no `G:` volume. USB device `USB\VID_0000&PID_0002\5&244075AE&0&8` fails enumeration with Code 43 "Device Descriptor Request Failed"; Disk 4 logged IO retries (Event 153) at 07:03–07:11 then disappeared. Tried rescan, disable/enable, and remove + rescan — device reappears still failing.
- Verified: `Get-Disk`, `Get-Volume`, `Get-PSDrive G` all show no USB disk/G:.
- Next: abandoned in software — needs physical check (different USB port/cable/power, test on another PC). App auto-selects `G:\` on next restart once mounted.

### 2026-11-13 — G: back, private repo, film download API
- Goal: move the library to `G:\`, publish the repo privately, add catalog/download APIs with a fallback.
- Done: G: returned as Disk 4 (ST1000LM USB, label `Other`, 1 TB). Moved both test films to `G:\Movies\Classics`, removed the 0/12 KB partials left from the failed G: downloads, and changed root resolution to prefer `G:\Movies` then `G:\` then project `media\`. Created `server/downloads.js`; added `GET /api/catalog/search`, `GET /api/catalog/fallback`, `GET /api/catalog/item/:identifier`, `POST/GET /api/downloads`, `GET/DELETE /api/downloads/:id`, and `POST /api/downloads/:id/retry`. Downloads stream archive.org files to `<root>\<collection>\`, write `.nfo` + `-poster.jpg` for single films, and rescan the library. Created private repo `https://github.com/yassine808/netflix-home` and pushed `main`.
- Verified: `gh repo view` reports `visibility: PRIVATE`. `/api/library` root is `G:\Movies` with 3 titles. Search returned 24 archive.org results; fallback returned 5 curated titles; item metadata listed the MP4. Downloaded `The Great Train Robbery (1903)` (58 MB) end-to-end — progress 20% → 69% → 100%, poster/NFO written, library rescanned to 3 titles. Multi-file item correctly returns 400 with the file list; cancel removes the `.part` and ends `cancelled`; retry requeues.
- Next: commit and push the API work. Cyberpunk: Edgerunners 2 stays blocked — Netflix exclusive, no legal direct download.

### 2026-11-13 — API pushed, final verification
- Goal: close out the private repo and download API work.
- Done: committed `e671a7b` and pushed `main` to the private repo. Updated cancel handling so a running job reports `cancelling` until the abort finishes, then `cancelled`.
- Verified: `gh repo view` reports `visibility: PRIVATE`; `GET /api/library` root `G:\Movies` with 3 titles streamed via `206 Partial Content`; UI rendered all 3 cards with no console errors; download cancel test moved `downloading` → `cancelling` → `cancelled` and deleted the `.part` file.
- Next: Cyberpunk: Edgerunners 2 cannot be added from a legal download source; drop owned files into `G:\Movies` if available.

### 2026-11-13 — series download endpoint
- Goal: allow one call to queue every episode/file of a multi-file archive.org item.
- Done: added `POST /api/downloads/series` with optional `files` subset, a 100-file cap, and grouping under `<collection>\<title>\`. It reuses the same job queue, progress, cancel, and retry paths.
- Verified: started a throwaway server on port 3002 with a temp library, downloaded the 3 MP4 parts of *The Great Train Robbery* (~46 MB) into `Series\<title>\`; all 3 jobs completed and the library found 3 items. Temp server stopped and temp folder deleted. Main server restarted; empty-body validation returns 400.
- Next: none.

### 2026-11-13 — connect catalog and downloads to the website
- Goal: expose the archive.org search/download APIs in the app instead of only as backend routes.
- Done: added frontend API helpers in `public/common.js`; added a **New & Popular** page (top nav + mobile **New** tab) with archive.org search, quick genre chips, curated fallback picks, and result cards; added a catalog picker with description, file list, MP4-first default, single-file download, and **Download all** for multi-file items; added a downloads drawer with badge, live progress bar, speed, cancel/retry, completion toast, and automatic library rescan; added **Search archive.org for “…”** to the local search overlay when a query has no library matches; refactored body scroll locking for the new overlays.
- Verified: desktop Brave/puppeteer QA — 5 curated picks, `film` search returned 24 archive.org results, picker listed files and selected the MP4, search CTA opened Discover with the query, downloads drawer opened, no console errors. Mobile 390×844 — no horizontal overflow, New tab active, archive search and CTA worked. End-to-end on a temp server/library: downloaded *The Great Train Robbery* (197 MB), toast fired, progress reached 100%, library rescanned to 1 item, poster/NFO written. Series action queued all 9 files (badge 9); cancel buttons cleared every active job and left no `.part` files. Temp server/library removed. Main `G:\Movies` library remains 3 titles and 0 jobs.
- Next: commit and push. Cyberpunk: Edgerunners 2 remains blocked — Netflix exclusive, no legal direct-download source.

### 2026-11-13 — IMDb-backed online catalog and split search
- Goal: replace the archive.org-only search source with a catalog that covers mainstream movies and series, and show local results before API results.
- Done: added `server/online.js` using Cinemeta (`v3-cinemeta.strem.io`), a keyless IMDb-backed metadata service. It queries the movie and series catalogs in parallel, normalizes and de-duplicates results, ranks exact titles first, and exposes a detail payload with overview, IMDb rating, genres, cast, runtime, and per-season episode lists. Added `GET /api/online/search?q=` and `GET /api/online/title/:type/:id` with input validation, 9 s timeouts, an LRU cache (10 min search, 6 h title), and defensive parsing. Rebuilt the search overlay into **In your library** first and **Movies & series online** second, with counts, loading/empty/error states, portrait online cards, and an online detail modal containing season tabs, episode thumbnails/synopses, **Where to watch** (JustWatch), **IMDb**, and **Find free download** (archive.org). Kept archive.org downloads as a separate **Free downloads** action. Added API helpers in `public/common.js`, styles, and README documentation.
- Verified: API — `cyberpunk edgerunners` returns Cyberpunk: Edgerunners (2022, series); `peaky blinders` 9 results with the series first; `attack on titan` 19 results with the series first; `the matrix` 19 results with the 1999 film first. Details — Cyberpunk: Edgerunners has 2 seasons / 20 episodes (season 2, 10 episodes, first airing 2026-10-20), Peaky Blinders 6 seasons / 36 episodes, Attack on Titan 4 seasons / 89 episodes; film *Night of the Living Dead* shows rating 7.8, 96 min, no season block. UI — headless Chromium/CDP at 1440×1000 and 390×844: local card and 24 online cards rendered in the right order, online detail and Season 2 tab worked, Escape closed the modal, library detail still opened, archive CTA and **Find free download** opened Discover with the query, zero console errors, no horizontal overflow on mobile. Caching measured 71 ms then 3 ms for a repeated search; bad input returns 400 and an unknown IMDb id returns 404. Library remains 3 titles and 0 downloads.
- Next: commit and push the online catalog work. Mainstream titles are metadata-only; legal availability is linked out.


### 2026-11-13 - mainstream download catalog (Castle)
- Goal: find a source that can actually download mainstream movies and series (Cyberpunk: Edgerunners, Breaking Bad, the popular shows), not just link out to legal services.
- Done: `server/castle.js` talks to the keyless Castle API (`api.hlowb.com`): AES-CBC catalog payloads, `/film-api` search, title detail with seasons/episodes/sizes/subtitle tracks, and `getVideo2` for a signed HLS URL. Added `/api/castle/search`, `/api/castle/title/:id`, `/api/castle/download`; the HLS job kind in `server/downloads.js` remuxes segments to MP4 with ffmpeg-static. UI: Downloadable section in the search overlay, download dialog with season tabs, quality picker, per-episode and download-season actions. Anime rows are downloadable now (detail route works). Premium 1080p returns a clear 409 instead of a generic 404. English subtitles are saved as `<name>.en.vtt` beside the video.
- Verified: catalog coverage over 25 popular titles - Breaking Bad (5 seasons), Cyberpunk: Edgerunners (2 seasons / 10 eps each), Better Call Saul, The Boys, Game of Thrones, Stranger Things, Severance, Peaky Blinders, The Last of Us, Squid Game, Succession, House of the Dragon, Money Heist, Attack on Titan, One Piece, and films Interstellar, Inception, Oppenheimer, Dune, The Dark Knight, Parasite, Spirited Away, The Godfather; The Sopranos and The Wire are missing. Real downloads: Breaking Bad S01E01 480p (143 MB) and Cyberpunk S01E01 720p (177 MB) completed, ffprobe reports h264 1280x720 + aac, 1532 s; both appear in `/api/library`. Quality probe: 720p resolves, 1080p returns "premium-only". Subtitles: Cyberpunk S01E02 720p wrote `Cyberpunk Edgerunners S01E02 720p.en.vtt` (real WebVTT cues). UI: headless Chromium at 1440x1000 - Cyberpunk appears in the Downloadable section, modal shows 2 seasons x 10 episodes, 1080p flagged premium, 390px wide has no horizontal overflow; online cards now borrow Castle artwork because live.metahub.space answers 404.
- Next: nothing blocking; season 2 downloads are running.

### 2026-11-13 - desktop launcher + push
- Goal: push the download work and make the app start from the desktop without a console, leaving a minimized taskbar button that reopens the page.
- Done: `launcher.ps1` starts `node server/index.js` hidden, waits for the port, opens `http://localhost:3000`, and shows a minimized WinForms window titled netflix-home; restoring it opens the browser again and re-minimizes; closing it kills the server it started. `start.vbs` runs the script with no console flash. Single instance guard (second launch only opens the browser), attach path when the port is already served, and `launcher.log` diagnostics. Documented in README and AGENTS.md.
- Verified: attach path - wscript start.vbs produced one powershell window titled netflix-home and wrote "port 3000 already served" + "browser opened"; GetWindowPlacement showed showCmd=2 (minimized); ShowWindow(SW_RESTORE) wrote "window restored; opening browser" and the window was iconic again 3 s later. Start path - launcher on port 3011 spawned node (pid 23004), `/api/library` answered 200, closing the window killed the node and the port; log shows "server stopped". Second double-click left one window and logged "launcher already running".
- Next: none.

### 2026-11-13 - tray icon launcher
- Goal: put a Netflix-style icon in the Windows notification area (next to the clock), not a taskbar button.
- Done: replaced the PowerShell launcher with `netflix-home.exe` built from `launcher.cs` (WinForms, /target:winexe, icon embedded with /win32icon). It starts node hidden, opens the browser, and shows a NotifyIcon with the red-N icon: left click reopens the page, right-click menu has **Open netflix-home** and **Quit (stop server)**. Single-instance mutex, attach when port 3000 is served, `launcher.log` diagnostics. Generated `public/favicon.ico` with 7 sizes (16-256) from a drawn tile + N. Removed launcher.ps1 and start.vbs.
- Verified: exe running (pid 8992), server pid 14288, `/api/library` 200; UI Automation lists a tray button named "netflix-home - http://localhost:3000" at 1582,1032; its Invoke pattern wrote "tray clicked; opening browser" to launcher.log; screenshots of the tray show the red N between OpenCode Tor and Discord. Windows 11 hid the icon at first, so `HKCU\Control Panel\NotifyIconSettings\17575691917665392587\IsPromoted` was set to 1 and the icon moved into the visible area.
- Next: none.

### 2026-11-13 - random free port + en/fr/ar/it subtitles
- Goal: do not fail when port 3000 is taken, and always download English, French, Arabic and Italian subtitle tracks.
- Done: the server keeps 3000 (or ``PORT``) as a preference and on ``EADDRINUSE`` retries a random port between 20000 and 59999 up to 8 times, writing the winner to ``.cache/port`` and printing it. The launcher parses stdout, falls back to the port file, verifies ``/api/library`` before attaching, and opens the real port in the browser and tray. Castle downloads now keep every track in en, fr, ar, it order and write ``<name>.<lang>.vtt``. Added ``TODO.md`` (offline/online toggle, lighter app).
- Verified: with another process holding 3000 the server logged ``port 3000 is in use, trying 50689``; ``.cache/port`` held 50689; the launcher opened and later attached to 50689 and the tray title showed it; a second launch only reopened the browser. A real 480p Cyberpunk S01E01 download into a throwaway library completed (49.7 MB) and wrote ``.en.vtt`` (15.4 KB), ``.fr.vtt`` (17 KB), ``.ar.vtt`` (63.5 KB) and ``.it.vtt`` (18 KB) out of 24 offered tracks. Test server stopped, temp library deleted, ``.cache/port`` restored to the running app.
- Next: none.

### 2026-11-13 - offline mode, subtitles, search history, fuzzy search
- Goal: fix cancelled downloads showing as finished, make the hero preview play sound by default, add an offline switch, player subtitle controls, search history, and typo-tolerant local search.
- Done: `server/settings.js` persists `{offline}` to `.cache/settings.json`; every internet route answers 503 while offline, downloads pause (`.part` kept) and resume when it is switched off. `DELETE /api/downloads/:id` now deletes the job and its `.part` file, paused downloads appear in their own state with Cancel, and failed jobs moved to a separate Failed section under Finished. Added `/api/subtitles/:id` and `/api/subtitle/:id/:lang` that discover sidecar `.vtt` files (en/fr/ar/it first). Player: CC button, language panel, and -/+ 0.5 s timing with per-title offsets saved in localStorage. Hero preview starts unmuted; if the browser blocks audible autoplay it falls back to muted and flags the mute button. Search: last 8 queries kept as removable chips, and local search scores exact/prefix/substring matches then bounded Levenshtein distance per token. Self-hosted Bricolage Grotesque and Manrope (9 woff2 files in `public/fonts`, generated `public/fonts.css`), so offline mode makes zero external requests.
- Verified: `node --check` on `server/index.js`, `server/downloads.js`, `server/settings.js` and both public modules. Isolated server on 31002 with a throwaway library - offline on returned 503 for catalog/online/castle search and POST /api/downloads while `/api/library` stayed 200; `/api/subtitles` listed en+fr and `/api/subtitle/:id/en` returned WebVTT; unknown language returned 404. Direct module test - queue, pause, then cancel removed the job, deleted the simulated `.part`, and resume did not resurrect it. Real server restarted on port 3000: `/api/settings` returns `{"offline":false}`, Breaking Bad S01E01 lists an English track and the VTT starts with `WEBVTT`; `/fonts.css` and `/fonts/font-1.woff2` are served locally (font/woff2). DOM id audit: all 135 app.js and 34 watch.js element refs exist, no duplicate ids, no remote font/host references left in the page sources. UI interactions were not clicked through because this machine has no working headless browser (Brave headless hangs).
- Next: visual pass of the new switch, history chips, and CC panel from a normal browser.

### 2026-11-13 - TODO pass: series grouping, Netflix player, startup film
- Goal: finish every open TODO item (offline switch, lighter app, player redesign, skip-intro, scrubber previews, series modal, toast, fades, startup, resume -5 s, footer, ambient color, title-only home cards) and use the Netflix logo animation as the startup.
- Done: series-aware metadata (`server/library.js`) with `seriesTitle`, `season`, `episode`, `episodeLabel`, `seriesKey`, `displayTitle`, `isSeries`; `GET /api/series/:key` collapses duplicate qualities to the higher-resolution file. New `server/frames.js` (160x90 sprite, max 100 tiles, 10 columns, concurrency 2) and `server/intro.js` (sidecar JSON, chapters, cache, episode heuristic, POST save). Width-aware `/api/thumb/:id?w=`. Player rebuilt Netflix-simple with a 4px scrubber, 10 s skips, white play, speed cycle, auto-hiding UI, `#tlPreview` sprite hover, `#skipIntro`, resume at saved-5 s, and a short black boot. Shell: grouped one-card-per-title home, Continue Watching and Top 10 by series, series modal with season tabs and per-episode Play/progress, green/yellow offline switch, centered footer wordmark, spring toast with icon/close/progress, site fade-out, per-title ambient hover colors, smaller thumbs with lazy/async decoding, and client-side fallback title cleanup (strips `S01E01` and `720p`). Startup now plays the downloaded 1080p24 Netflix logo film (`public/startup.mp4`, 4.06 s, h264+aac, 346 KB) once per tab session with Skip and Sound-on; reduced motion skips it.
- Verified: `node --check` on all edited server and public modules; CSS braces balanced 803/803; QA harness on the live server - 147 app.js refs and 38 watch.js refs all resolve, no duplicate ids; `/api/library` 19 items, Cyberpunk 2 seasons / 12 deduped episodes, Breaking Bad 1/1; sprite 346,319 bytes; `/api/intro` heuristic 0-90 s; `?w=640` thumb 22,461 bytes; `/startup.mp4` returns 200 video/mp4 346,418 bytes. Test server on 31050 stopped, test intro marker removed, real server restarted on 3000 (pid 19920).
- Next: visual check of the startup film and series modal in a normal browser.

### 2026-11-13 - startup buttons, modal fixes, series downloads, hero cache, G:\NETFLIX deployment
- Goal: drop the Skip/Sound-on buttons, fix the empty round button and the bright line under Play, offer Download for episodes that are not on disk, cache each title's hero still + intro clip in a database, and move movies + database + exe into `G:\NETFLIX`.
- Done: startup film now plays unmuted at `volume = 0.4` with no controls (muted fallback that unmutes on the first pointer/key gesture, safety timeout kept). `.modal-hero`/`.online-hero` got `overflow: hidden` (killed the artwork sliver under Play) and `.btn-round` is fixed at 50x50 with `padding: 0`, so the plus/check icon is no longer collapsed by `.btn` padding; icon toggling uses `toggleAttribute` because SVG elements have no `hidden` property. `server/hero.js` stores hero still + 12 s h264/aac clip in `library.db` (SQLite via `node:sqlite`) and `hero\<hash>.jpg|.mp4`, warms one title per series in the background (2 builds at a time) and builds on demand; routes `/api/hero/:id`, `/api/hero/:id/image.jpg`, `/api/hero/:id/preview.mp4`. The billboard loads the cached still and clip and falls back to streaming the real file. `GET /api/series/:key/catalog` merges the Castle catalog into the modal so every episode has either Play (file on disk) or Download (720p if free, else the highest non-premium quality). Root resolution now prefers a `Movies` folder beside the app, then `G:\NETFLIX`, so the deployed copy scans its own folder; `.cache` lives in the library root. `launcher.cs` mirrors that resolution for its port file. New `deploy.ps1` + `npm run deploy` build the exe and mirror `server\`, `public\`, `package.json` and (first run) `node_modules\` to `G:\NETFLIX`. Moved `G:\Movies` to `G:\NETFLIX\Movies` (63 files).
- Verified: `node --check` on server/index.js, hero.js, library.js and public/app.js, common.js. `/api/library` reports root `G:\NETFLIX` with 19 titles in ~160 ms; hero image 200 (108 KB) and preview 200/206 (~554 KB) with the billboard video playing `loop: true` from `/api/hero/.../preview.mp4`; catalog returns Cyberpunk 2 seasons x 10 episodes with 720p sizes. Headless QA: Season 2 shows 2 Play rows + 8 Download rows (`Episode 3 ... 28m · HD 720P · 133 MB`), clicking Download queued `Cyberpunk Edgerunners S02E03` (cancelled after), modal list button 50x50 with a 26x26 icon, no console errors. Deployment: `deploy.log` says "deployed to G:\NETFLIX", the folder holds `Movies\ .cache\ server\ public\ node_modules\ package.json netflix-home.exe`; starting `G:\NETFLIX\netflix-home.exe` logged server pid, port 3000, browser and tray, and the served app answered library/hero/catalog with `public/app.js` hashing equal to the source.
- Next: none.
