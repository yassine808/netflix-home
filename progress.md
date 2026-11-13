# Progress — netflix-home

## Plan
- [x] Create local git repo and project folder `D:\Projects\netflix-home`
- [x] Build library scanner, metadata extraction, thumbnail cache
- [x] Build streaming API with range requests
- [x] Build Netflix-style home UI, rows, search, detail modal
- [x] Build custom video player with resume and progress saving
- [x] Download sample movies (to project `media\` fallback — G: absent) and verify end-to-end
- [x] Visual QA in the browser and fixes
- [ ] Commit

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

