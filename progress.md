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
- [x] Move the library to `G:\Movies`
- [ ] Cyberpunk: Edgerunners 2 (blocked: Netflix-exclusive, DRM-protected, no legal download)

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

