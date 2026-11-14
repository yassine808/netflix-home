# Plan — smooth, fast netflix-home with low CPU/GPU cost

Goal: the UI opens instantly, pages cost almost nothing to serve, and background work never
spikes the CPU or GPU while Yassine is watching something.

Hard constraints:

- One server process (`node server/index.js`), one SQLite file.
- No new dependency if a Node built-in can do it.
- Warm-up jobs (ffmpeg) are optional extras: the page must be usable before they finish.
- Never trade correctness for speed silently — if the index can be stale, say so in the docs.

## Baseline (measured 2026-11-14)

| Thing | Before this pass | Now |
|---|---|---|
| Launch scan | walked every folder, `stat` per video | `readdir` per folder, `stat` only new names |
| 26 files / 8 folders, nothing changed | ~97 ms, all 26 files stat'ed | **7–11 ms, 0 stats, 0 ffprobe** |
| First `/api/library` after restart | 138 ms (waits for scan) | served from `catalog.db` at listen |
| Rescan with no changes | new `updatedAt` → browser re-downloads 20 KB | ETag unchanged → `304`, 0 bytes |
| New file appears | not noticed until restart/manual rescan | folder watcher → scan in ~2.5 s |

## Phase 1 — trust the index, watch the folders (done)

- [x] `dirs` table: per-folder listing (name, size, mtime) saved in `catalog.db`.
- [x] `walkIndexed()`: always `readdir` (names cannot lie), reuse saved sizes/mtimes for names
      that still exist, `stat` only unknown names.
- [x] `scan_state` table: root, item count, last scan duration.
- [x] Boot serves `loadCachedLibrary()` first; the folder check runs 1.2 s later, off the path
      of the first request.
- [x] `fs.watch(root, {recursive:true})` with a 2.5 s debounce; `.cache` and `*.part` ignored so
      the app's own writes and in-progress downloads do not cause scan storms.
- [x] Unchanged scan keeps `updatedAt`, so the library ETag and every 304 stay valid.
- [x] `/api/rescan` and download completion share one `refreshLibrary()` path.
- [x] `/api/db/stats` reports `dirs`; `/api/library` reports `scan: {ms, files, dirs, reusedDirs,
      readDirs, probed, changed}`.

Known limit: a file replaced in place under the same name (same folder mtime, same entry name)
is not detected at launch. The watcher catches it while the app runs; a manual Rescan also
detects it because `readdir` names and stat results are compared. Acceptable trade.

## Phase 2 — make background work cheap (next)

- [x] **Low-priority ffmpeg.** Every `ffprobe`/`ffmpeg`/`yt-dlp` child goes through
      `server/proc.js`, which calls `os.setPriority(pid, PRIORITY_BELOW_NORMAL)`.
      Measured base priority 6 (below normal is 6, normal is 8).
- [x] **Lanes instead of ad-hoc concurrency.** `mediaLane` (1 heavy ffmpeg at a time) and
      `probeLane` (3 ffprobe reads) in `proc.js`; every module now uses them.
- [x] **Pause warm-ups on playback.** `/api/stream` and the hero preview call `notePlayback()`;
      `warmHeroes`, `warmTrailers` and `warmArtwork` stop when playback was active in the last
      20 s. On-demand builds still run, so the player never waits for a warm-up.
- [x] **Warm only what is missing.** Warmers skip items whose DB row is fresh (already the case).
- [ ] **Idle scheduling.** Start warm-ups only after the first `/api/library` request.
- [ ] **Cheaper defaults for stills.** Picture sampling 8 → 5 candidates, hero clip 12 s → 8 s,
      ffmpeg `-threads 1 -preset veryfast`. Only if the visual result holds up.
- [ ] **Cancel on playback.** Pause the queue mid-build, not just before starting the next item.

Success: idle CPU under 1 % with the app open, a 12 s hero build never makes playback stutter.

## Phase 3 — send fewer bytes (done)

- [x] **Compress `/api/library`.** The JSON body is built once per revision (ETag + scan
      fingerprint) and gzipped once at level 6. Measured 886 B → 502 B for one title; the
      ratio grows with the payload. `Vary: Accept-Encoding` and the same ETag/304 path stay.
- [x] **Size the artwork to the slot.** `/api/art/:id/:kind?w=480` renders a JPEG at the
      nearest ladder width (160/240/320/480/640/960/1280) once, under `.cache\art\sized\`,
      from the cached original or a sidecar picture. ffmpeg clamps to the source width, so
      small posters are never upscaled. `thumbUrl(item, width)` / `posterUrl(item, width)`
      now pass `w`; hero uses the original, cards 480 (grid 640), episode thumbs 320.
      Measured 101 KB / 1600 px → 9.7 KB at 480 px; warm hit 17 ms.
- [x] **Immutable asset headers.** HTML is served `no-cache` with `?v=<stamp>` on every
      `/x.css` and `/x.js`; those files (plus fonts and icons) get
      `max-age=31536000, immutable`. The stamp hashes the six asset files' size+mtime, so a
      deploy invalidates them automatically.
- [ ] **Preconnect/preload.** Skipped: the hero is chosen client-side after `/api/library`,
      so the server cannot put its URL in `<head>`. The hero `<img>` now uses
      `fetchpriority="high"` instead.
- [ ] **Cap parallel image requests.** Lazy rows (Phase 4) are the real fix; the server now
      scales art through a two-slot lane, so a burst of 50 cards cannot starve a hero build.

Success: home page under 150 KB transferred on a warm cache, under 900 KB on a cold one.

## Phase 4 — render less, render once

- [ ] **Incremental rows.** `loadLibrary()` currently replaces `state.items` and re-renders. Diff
      by item id and patch only changed rows; a poll that returns 304 must not touch the DOM.
- [ ] **`content-visibility: auto`** on rows + `contain-intrinsic-size`, so offscreen rows skip
      layout and paint entirely (big win on GPU cost during scroll).
- [ ] **Images**: `loading="lazy"`, `decoding="async"`, explicit `width`/`height` to stop layout
      shift, `fetchpriority="high"` only on the hero.
- [ ] **Virtualize Top 10 / long rows** if a row exceeds ~40 cards.
- [ ] **No animation on hover for offscreen cards**; the ambient gradient already uses CSS, keep
      it out of JS.
- [ ] **Drop the 60 s library poll** to 5 min; visibility change and ETag revalidation already
      cover the cases that matter.
- [ ] **Player**: sprite timeline built on demand only when the user hovers the scrubber, not on
      load; `preload="metadata"` stays.

Success: scrolling 500 cards holds 60 fps and does not allocate after the first paint.

## Phase 5 — keep the database small and quick

- [ ] `PRAGMA optimize` on open and on `POST /api/quit`; `ANALYZE` after a scan that changed
      more than 50 rows.
- [ ] `PRAGMA wal_autocheckpoint=512`, `journal_size_limit=8 MB` so `-wal` cannot grow to 10 MB
      like it is now.
- [ ] `VACUUM` only when idle and the file is >25 % free pages; skip when a player is open.
- [ ] Index the queries actually used: `items(collection, mtime DESC)`, `subtitles(item_id)`,
      `assets(kind)`. Check with `EXPLAIN QUERY PLAN` before adding.
- [ ] Purge rows for files that no longer exist (already done by `keep`), plus orphan `assets`,
      `subtitles`, `audio_tracks` older than 30 days.

Success: `catalog.db` stays under ~5 MB, no query over 1 ms for 26 items / 1000 items.

## Phase 6 — startup and process budget

- [ ] Parallel module init where it is IO-bound; keep `sync` only for `node:sqlite`.
- [ ] Skip the `dirs` walk entirely when a `scan_state` root fingerprint (volume serial + root
      mtime + watcher active) matches and the watcher has reported nothing since boot.
- [ ] Log one line per refresh instead of several; diagnostics go to `/api/db/stats`.
- [ ] Measure: `process.cpuUsage()` and `memoryUsage()` exposed in `/api/db/stats`.

## Measurement harness (do this before optimising further)

- [ ] `scripts/bench.mjs`: boots the server on a temp port, records
      `t(listen)`, `t(first library)`, `t(scan)`, `cpuUsage`, `rss`, and the byte count of a cold
      and warm home page, then prints a table and fails if it regresses past the limits above.
- [ ] Run it before/after every phase; paste the table into `progress.md`.

## Order

1. Phase 2 (ffmpeg priority + queue) — biggest risk of "app feels heavy" today.
2. Phase 3 (gzip + sized art) — pure user-visible speed.
3. Phase 4 (DOM diff + content-visibility) — GPU/CPU during scrolling.
4. Phase 5 + 6 (DB and startup polish) — long-term stability.
