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
- Verified: catalog coverage over 25 popular titles - Breaking Bad (5 seasons), Cyberpunk: Edgerunners (2 seasons / 10 eps each), Better Call Saul, The Boys, Game of Thrones, Stranger Things, Severance, Peaky Blinders, The Last of Us, Squid Game, Succession, House of the Dragon, Money Heist, Attack on Titan, One Piece, and films Interstellar, Inception, Oppenheimer, Dune, The Dark Knight, Parasite, Spirited Away, The Godfather; The Sopranos and The Wire are missing. Real downloads: Breaking Bad S01E01 480p (143 MB) and Cyberpunk S01E01 720p (177 MB) completed, ffprobe reports h264 1280x720 + aac, 1532 s; both appear in `/api/library`. Quality probe: 720p resolves, 1080p returns "premium-only". Subtitle sidecar pending the S01E02 480p job.
- Next: confirm the S01E02 job writes its `.vtt` sidecar, then commit.
