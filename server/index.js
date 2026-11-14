import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { initDb, dbStats, analyzeDb, purgeOrphans, maybeVacuum,
  getCastleTitleSaved, castleTitleCount, castleMediaCount,
} from './db.js';
import { notePlayback, playbackActive } from './proc.js';
import { initCache, scanLibrary, getLibrary, getItem, resolveItemFile,
  ensureThumb, artPath, isScanning,
} from './library.js';
import { initArtwork, officialArt, cachedArt, artWidth, sizedArt, warmArtwork } from './artwork.js';
import {
  initDownloads,
  addHlsDownload,
  addTorrentDownload,
  listDownloads, cancelDownload, retryDownload,
  pauseDownloads, resumeDownloads,
} from './downloads.js';
import { findReleases, rankReleases, releaseLabel } from './torrentio.js';
import { searchOnline, getOnlineTitle } from './online.js';
import {
  searchCastle, browseCastle, getCastleTitle, getCastleSeries, getCastleStream,
  getCastleEpisodeTracks, selectCastleAudioTracks, getCastleStats, CASTLE_GENRES,
  isCastleId, castleArt, castleEpisodeArt, castleEpisodeArtForSeries, castleTrailerItem,
} from './castle.js';
import { castleSyncStatus, startCastleSync } from './castle-sync.js';
import { initSettings, getSettings, isOffline, setOffline } from './settings.js';
import { initFrames, frameMeta, ensureSprite } from './frames.js';
import { initIntro, getIntroMarkers, saveIntroMarkers } from './intro.js';
import { initHero, heroStart, heroReady, ensureHero, warmHeroes } from './hero.js';
import { initTrailers, trailerPathFor, trailerStatus, warmTrailer, warmTrailers } from './trailers.js';
import { resolveImdbId } from './imdb.js';
import { ensureEnglishSubtitle, fetchEnglishSubtitle, syncSubtitleTracks, subtitleBody } from './subs.js';
import { initAudio, probeAudioTracks, ensureAudioVariant } from './audio.js';

/* In the single-file build there is no real file on disk, so the bundle passes
 * APP_ROOT (where the exe lives) and PUBLIC_DIR (extracted UI files). */
const __dirname = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.env.APP_ROOT || process.cwd();
  }
})();
const projectRoot = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(__dirname, '..');
const publicDir = process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : path.join(projectRoot, 'public');

function exactDir(dir, name) {
  try {
    return fs.readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}

/* The deployed copy lives next to its own movies (G:\NETFLIX\Movies), so a
 * "Movies" folder beside the app wins over the old fixed locations. */
function resolveLibraryRoot() {
  if (process.env.LIBRARY_ROOT) return path.resolve(process.env.LIBRARY_ROOT);
  if (exactDir(projectRoot, 'Movies')) return projectRoot;
  for (const candidate of ['G:\\NETFLIX', 'G:\\Movies', 'G:\\']) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* drive not ready */
    }
  }
  const fallback = path.join(projectRoot, 'media');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const libraryRoot = resolveLibraryRoot();
/* The database and thumbnails live with the library, so G:\NETFLIX holds the
 * movies, the cache and the launcher together. */
const cacheDir = path.join(libraryRoot, '.cache');
const preferredPort = Number(process.env.PORT) || 3000;

// Anyone can already be on 3000 (another dev server, an old instance). Rather
// than fail, walk to a random high port and remember it for the launcher.
const PORT_FILE = path.join(cacheDir, 'port');

initDb(cacheDir);
initCache(cacheDir);
initSettings(cacheDir);
initArtwork(cacheDir);
initFrames(cacheDir);
initIntro(cacheDir);
initHero(cacheDir);
initAudio(cacheDir);
initTrailers(cacheDir, {
  ytDlpPath: process.env.YTDLP_PATH || path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'bin', 'yt-dlp.exe'),
});
getLibrary().root = libraryRoot;
initDownloads({
  root: libraryRoot,
  onDownloadComplete: async () => {
    // A finished download is also picked up by the watcher; coalesce so a
    // whole season finishing at once triggers one scan.
    queueRefresh(400);
  },
  // A file that is already in the library must not be downloaded twice; this is
  // what kept producing duplicate titles (and " (1)" copies) in the UI.
  findDownload: (fileName) => {
    const wanted = String(fileName || '').toLowerCase();
    if (!wanted) return null;
    return getLibrary().items.find((entry) => entry.fileName.toLowerCase() === wanted) || null;
  },
});

/* One refresh path for boot, the folder watcher and downloads. The scan is
 * cheap when nothing changed (directory mtimes match), and warm-up work only
 * runs when something actually appeared. */
let refreshTimer = null;
let watchTimer = null;
let lateTimer = null;
let watchMutedUntil = 0;
let watchDirty = false;
let libraryRequested = false;
let warmTimer = null;
let warmedAt = 0;

/* Warm-ups are background work: start them only after a page has actually
 * asked for the library, so a headless launch stays silent. */
function warmLibrary() {
  const lib = getLibrary();
  if (!lib.items?.length || warmedAt === lib.updatedAt) return;
  warmedAt = lib.updatedAt;
  warmHeroes(lib.items, libraryRoot);
  warmTrailers(lib.items);
  warmArtwork(lib.items);
}

function queueWarm(delay = 400) {
  if (warmTimer) return;
  warmTimer = setTimeout(() => {
    warmTimer = null;
    warmLibrary();
  }, delay);
  warmTimer.unref?.();
}

async function refreshLibrary(reason) {
  // Writing catalog.db (WAL) is itself a change under the watched root, so the
  // watcher is muted for the duration of a refresh and shortly after it.
  watchMutedUntil = Date.now() + 60000;
  let lib;
  try {
    lib = await scanLibrary(libraryRoot);
  } catch (err) {
    console.warn('scan failed:', err?.message || String(err));
    return null;
  } finally {
    watchMutedUntil = Date.now() + 2000;
    if (watchDirty) {
      watchDirty = false;
      queueRefresh(600);
    }
  }
  const scan = lib.scan || {};
  if (scan.changed) {
    // Housekeeping rides on real changes, never on a no-op refresh.
    const orphans = purgeOrphans();
    if (scan.written > 50) analyzeDb();
    if (!playbackActive()) maybeVacuum();
    if (libraryRequested) queueWarm(0);
    console.log(`library ${reason}: ${lib.items.length} title(s), ${scan.dirs} folder(s), `
      + `${scan.readDirs} read, ${scan.probed} probed in ${scan.ms} ms`
      + (orphans ? `, ${orphans} orphan row(s) removed` : ''));
  } else {
    console.log(`library ${reason}: unchanged, ${scan.dirs} folder(s) checked in ${scan.ms} ms`);
  }
  return lib;
}

/* Windows fires a recursive event for any file under the root. Downloads,
 * renames and deletions all land here; the scan is debounced so a copy in
 * progress does not start a hundred scans. */
function watchLibrary() {
  const cacheRoot = path.resolve(cacheDir).toLowerCase();
  try {
    const watcher = fs.watch(libraryRoot, { recursive: true }, (event, name) => {
      const rel = String(name || '');
      if (/\.(part|tmp)$/i.test(rel)) return;
      // The event path arrives relative on most Windows builds, but can be
      // absolute; comparing the resolved path covers both. Everything the app
      // writes itself lives under .cache and must not trigger a scan.
      const abs = path.isAbsolute(rel) ? rel : path.join(libraryRoot, rel);
      const resolved = path.resolve(abs);
      const lower = resolved.toLowerCase();
      if (lower.startsWith(cacheRoot)) return;
      // Our own log/writer files sit beside the media; writing them must not
      // look like a library change (that produced one scan per log line).
      const base = path.basename(resolved).toLowerCase();
      if (base.endsWith('.log') || base === 'netflix-home.exe' || base === 'launcher.exe') return;
      if (Date.now() < watchMutedUntil) {
        // A scan is running or just finished; its own follow-up only exists if
        // the flag was already set when it ended, so schedule a late pass too.
        watchDirty = true;
        if (!lateTimer) {
          const delay = Math.max(500, watchMutedUntil - Date.now() + 300);
          lateTimer = setTimeout(() => {
            lateTimer = null;
            if (!watchDirty) return;
            watchDirty = false;
            refreshLibrary('watch');
          }, delay);
          lateTimer.unref?.();
        }
        return;
      }
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        refreshLibrary('watch');
      }, 2500);
      watchTimer.unref?.();
    });
    watcher.on('error', () => {
      try { watcher.close(); } catch { /* already gone */ }
    });
  } catch {
    /* watching is an optimisation; scanning still works without it */
  }
}

/* Rescan requests coalesce with the background work instead of racing it. */
function queueRefresh(delay = 0) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshLibrary('manual');
  }, delay);
  refreshTimer.unref?.();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

/* Offline mode: the flag lives on the server, so the browser cannot route
 * around it. Every route that reaches the internet answers 503. Castle reads
 * that come straight from catalog.db (saved title, saved art, saved trailer,
 * sync status) stay available; only their refresh/download actions are
 * blocked. */
app.use('/api', (req, res, next) => {
  if (!isOffline()) return next();
  const p = req.path;
  const method = req.method;
  const savedCastleRead = method === 'GET' && (
    p.startsWith('/castle/title/')
    || p.startsWith('/castle/series/')
    || p.startsWith('/castle/art/')
    || p.startsWith('/castle/episode-art/')
    || p.startsWith('/castle/trailer/')
    || p === '/castle/sync'
  );
  const blocked = (p.startsWith('/online/')
    || (p.startsWith('/castle/') && !savedCastleRead)
    || p === '/releases'
    || (method === 'POST' && (p === '/downloads'
      || p === '/downloads/series'
      || /^\/downloads\/[^/]+\/retry$/.test(p))));
  if (!blocked) return next();
  res.status(503).json({ error: 'offline mode is on — internet access is disabled', offline: true });
});

app.get('/api/settings', (req, res) => res.json(getSettings()));

/* Catalog database size, row counts and process cost, for verifying the cache
 * and spotting growth without a profiler. */
app.get('/api/db/stats', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const usage = process.cpuUsage();
  const memory = process.memoryUsage();
  res.json({
    ...dbStats(),
    process: {
      cpuUserMs: Math.round(usage.user / 1000),
      cpuSystemMs: Math.round(usage.system / 1000),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      uptimeSec: Math.round(process.uptime()),
    },
  });
});

app.post('/api/settings/offline', (req, res) => {
  if (typeof req.body?.offline !== 'boolean') {
    return res.status(400).json({ error: 'pass {"offline": true|false}' });
  }
  const settings = setOffline(req.body.offline);
  if (settings.offline) pauseDownloads();
  else resumeDownloads();
  res.json(settings);
});

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg', '.divx': 'video/divx',
};

/* The library JSON is rebuilt only when something changed. gzip is computed
 * once per revision too: for a few hundred titles that is the difference
 * between ~400 KB and ~60 KB on the wire. */
let libCache = { key: '', body: null, gzip: null };

app.get('/api/library', (req, res) => {
  const lib = getLibrary();
  const etag = `"lib-${lib.updatedAt || 0}-${lib.items.length}"`;
  const scanning = isScanning();
  // The page is open: allow background warm-ups from now on.
  libraryRequested = true;
  if (lib.items.length) queueWarm();
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  const key = `${etag}|${scanning}|${JSON.stringify(lib.scan || null)}|${lib.scannedInMs}`;
  if (libCache.key !== key) {
    const json = JSON.stringify({
      root: lib.root,
      updatedAt: lib.updatedAt,
      scannedInMs: lib.scannedInMs,
      scan: lib.scan || null,
      scanning,
      items: lib.items.map((item) => {
        const { posterPath, backdropPath, ...safe } = item;
        return { ...safe, hasPoster: Boolean(posterPath), hasBackdrop: Boolean(backdropPath) };
      }),
      collections: lib.collections,
    });
    libCache = { key, body: Buffer.from(json, 'utf8'), gzip: null };
  }
  if (/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) {
    if (!libCache.gzip) libCache.gzip = gzipSync(libCache.body, { level: 6 });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(libCache.gzip.length));
    return res.end(libCache.gzip);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(libCache.body.length));
  return res.end(libCache.body);
});

app.post('/api/rescan', async (req, res) => {
  try {
    const lib = await refreshLibrary('rescan');
    res.json({ ok: true, count: lib.items.length, updatedAt: lib.updatedAt, scan: lib.scan || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* One series, with its seasons and the episodes actually on disk. Duplicate
 * files for the same episode (two qualities) collapse to the better copy. */
app.get('/api/series/:key', (req, res) => {
  const key = String(req.params.key || '');
  const episodes = getLibrary().items.filter((item) => item.seriesKey === key);
  if (!episodes.length) return res.status(404).json({ error: 'series not found' });

  const best = new Map();
  for (const item of episodes) {
    const slot = `${item.season}x${item.episode}`;
    const previous = best.get(slot);
    if (!previous) {
      best.set(slot, item);
      continue;
    }
    const score = (value) => (value.height || 0) * 1000000 + (value.size || 0);
    if (score(item) > score(previous)) best.set(slot, item);
  }

  const seasons = new Map();
  for (const item of best.values()) {
    const list = seasons.get(item.season) || [];
    list.push(item);
    seasons.set(item.season, list);
  }

  const payload = [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, list]) => ({
      season,
      episodes: list
        .sort((a, b) => a.episode - b.episode)
        .map((item) => ({
          id: item.id,
          title: item.title,
          displayTitle: item.displayTitle,
          season: item.season,
          episode: item.episode,
          episodeLabel: item.episodeLabel,
          durationSec: item.durationSec,
          size: item.size,
          mtime: item.mtime,
          height: item.height,
          hasPoster: Boolean(item.posterPath),
          hasBackdrop: Boolean(item.backdropPath),
        })),
    }));

  res.json({
    key,
    title: episodes[0].seriesTitle,
    count: payload.reduce((total, season) => total + season.episodes.length, 0),
    seasons: payload,
    // Saved Castle episode pictures for the player's episode panel.
    art: castleEpisodeArtForSeries(key),
  });
});

/* Every episode of the series that the download catalog knows about, so the
 * detail modal can offer Play for files on disk and Download for the rest. */
const seriesCatalogCache = new Map();
const SERIES_CATALOG_TTL = 10 * 60 * 1000;

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function defaultQuality(resolutions) {
  const list = Array.isArray(resolutions) ? resolutions : [];
  return list.find((entry) => entry.resolution === 2 && !entry.premium)
    || [...list].reverse().find((entry) => !entry.premium)
    || list[0]
    || null;
}

function shapeCatalogEpisode(entry) {
  const quality = defaultQuality(entry.resolutions);
  return {
    episode: entry.episode,
    title: entry.title,
    duration: entry.duration,
    thumbnail: entry.thumbnail,
    movieId: entry.movieId,
    episodeId: entry.episodeId,
    quality: quality
      ? { resolution: quality.resolution, label: quality.label, size: quality.size, premium: quality.premium }
      : null,
  };
}

async function catalogSeriesEpisodes(seriesTitle) {
  const search = await searchCastle(seriesTitle);
  const wanted = normalizeTitle(seriesTitle);
  const candidates = (search.results || []).filter((entry) => entry.type === 'series' || entry.type === 'anime');
  const exact = candidates.find((entry) => normalizeTitle(entry.title) === wanted);
  const loose = candidates.find((entry) => {
    const name = normalizeTitle(entry.title);
    return name && (name.includes(wanted) || wanted.includes(name));
  });
  const hit = exact || loose;
  if (!hit) return null;

  const first = await getCastleTitle(hit.id);
  const seasonRows = Array.isArray(first.seasons) ? first.seasons : [];
  if (!seasonRows.length) {
    return {
      catalogId: hit.id,
      title: hit.title,
      poster: hit.poster,
      seasons: [{
        season: 0,
        episodes: (first.episodes || []).map(shapeCatalogEpisode),
      }],
    };
  }

  const seasons = [];
  for (const row of seasonRows) {
    let episodes = [];
    if (row.season === first.activeSeason) {
      episodes = (first.seasons.find((entry) => entry.season === first.activeSeason)?.episodes) || [];
    } else {
      const detail = await getCastleTitle(hit.id, { season: row.season });
      const active = (detail.seasons || []).find((entry) => entry.season === detail.activeSeason);
      episodes = active?.episodes || [];
    }
    seasons.push({ season: row.season, episodes: episodes.map(shapeCatalogEpisode) });
  }

  return { catalogId: hit.id, title: hit.title, poster: hit.poster, seasons };
}

async function seriesCatalogValue(key) {
  const episodes = getLibrary().items.filter((item) => item.seriesKey === key);
  if (!episodes.length) return null;
  const seriesTitle = episodes[0].seriesTitle || episodes[0].title;
  const cached = seriesCatalogCache.get(key);
  if (cached && Date.now() - cached.at < SERIES_CATALOG_TTL) return cached.value;

  const data = await catalogSeriesEpisodes(seriesTitle);
  if (!data) return null;
  const value = { seriesKey: key, seriesTitle, seasons: data.seasons, catalogTitle: data.title, catalogId: data.catalogId };
  seriesCatalogCache.set(key, { at: Date.now(), value });
  return value;
}

app.get('/api/series/:key/catalog', async (req, res) => {
  if (isOffline()) {
    return res.status(503).json({ error: 'offline mode is on — internet access is disabled', offline: true });
  }
  const key = String(req.params.key || '');
  const episodes = getLibrary().items.filter((item) => item.seriesKey === key);
  if (!episodes.length) return res.status(404).json({ error: 'series not found' });

  const seriesTitle = episodes[0].seriesTitle || episodes[0].title;
  try {
    const value = await seriesCatalogValue(key);
    if (!value) return res.status(404).json({ error: `“${seriesTitle}” is not in the download catalog` });
    res.set('Cache-Control', 'public, max-age=600');
    res.json(value);
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

/* The episode after this one. A local file can be played straight away; an
 * episode that is only in the download catalog returns season/episode so the
 * player can send the user to the sheet where it can be downloaded. */
app.get('/api/next/:id', async (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (!item.isSeries || !item.seriesKey) return res.status(404).json({ error: 'not a series episode' });

  const season = Number(item.season) || 0;
  const episode = Number(item.episode) || 0;
  const isAfter = (entry) => entry.season > season || (entry.season === season && entry.episode > episode);
  const order = (a, b) => a.season - b.season || a.episode - b.episode;

  const localNext = getLibrary().items
    .filter((entry) => entry.seriesKey === item.seriesKey && entry.id !== item.id && isAfter(entry))
    .sort(order)[0];
  if (localNext) {
    return res.json({
      kind: 'local',
      id: localNext.id,
      season: localNext.season,
      episode: localNext.episode,
      title: localNext.displayTitle || localNext.title,
    });
  }

  if (isOffline()) return res.json({ kind: 'none' });

  try {
    const catalog = await seriesCatalogValue(item.seriesKey);
    const next = (catalog?.seasons || [])
      .flatMap((row) => (row.episodes || []).map((entry) => ({ season: row.season, episode: entry.episode, title: entry.title })))
      .filter(isAfter)
      .sort(order)[0];
    if (!next) return res.json({ kind: 'none' });
    res.json({ kind: 'catalog', season: next.season, episode: next.episode, title: next.title });
  } catch {
    res.json({ kind: 'none' });
  }
});

/* Byte-range file serving, shared by the original file and dub variants. */
function sendMedia(req, res, full, type) {
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return res.status(404).end();
  }

  const total = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');

  if (!range) {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(full).pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
  }
  end = Math.min(end, total - 1);

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full, { start, end }).pipe(res);
}

app.get('/api/stream/:id', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).end();
  notePlayback();
  const { full } = found;

  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';

  // ?audio=<stream index> serves that dub; the file's own first track needs no work.
  const wanted = Number(req.query.audio);
  if (Number.isInteger(wanted) && wanted >= 0) {
    try {
      const tracks = await probeAudioTracks(found.item, full);
      const track = tracks.find((entry) => entry.streamIndex === wanted);
      if (track && tracks[0] && track.streamIndex !== tracks[0].streamIndex) {
        const variant = await ensureAudioVariant(found.item, full, track);
        if (variant !== full) return sendMedia(req, res, variant, 'video/mp4');
      }
    } catch {
      /* fall back to the original file */
    }
  }

  return sendMedia(req, res, full, type);
});

/* Audio tracks of one file, for the player's dub menu. */
app.get('/api/audio/:id', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  let tracks = [];
  try {
    tracks = await probeAudioTracks(found.item, found.full);
  } catch {
    tracks = [];
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json({
    tracks: tracks.map((track) => ({
      index: track.streamIndex,
      position: track.position,
      lang: track.lang,
      label: track.label,
      codec: track.codec,
      channels: track.channels,
      default: track.default,
    })),
  });
});

/* ---------- scrubber preview frames + intro markers (both local) ---------- */

/* Hero cache: still + short preview clip stored in <library>/.cache/library.db.
 * The still falls back to a generated thumbnail while the clip is being built. */
app.get('/api/hero/:id/image.jpg', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).end();
  const { item, full } = found;
  const cached = heroReady(item);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cached.image);
  }
  ensureHero(item, full).catch(() => {});
  const out = await ensureThumb(item, full, 1280);
  if (!out) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(out);
});

app.get('/api/hero/:id/preview.mp4', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).end();
  notePlayback();
  const { item, full } = found;
  const hero = await ensureHero(item, full);
  if (!hero?.video) return res.status(503).json({ error: 'preview is not ready' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(hero.video);
});

app.get('/api/hero/:id', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const { item } = found;
  const cached = heroReady(item);
  // Fetch the billboard trailer in the background the first time it is asked for.
  warmTrailer(item);
  res.json({
    ready: Boolean(cached),
    startSec: cached ? cached.startSec : heroStart(item),
    builtAt: cached ? cached.builtAt : null,
    trailer: trailerStatus(item),
  });
});

/* Official trailer downloaded from YouTube, used by the home billboard. */
app.get('/api/hero/:id/trailer.mp4', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).end();
  const file = trailerPathFor(found.item);
  if (!file) {
    warmTrailer(found.item);
    return res.status(404).end();
  }
  res.setHeader('Cache-Control', 'public, no-cache');
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(file);
});

/* Trailer state for the series sheet: starts the Netflix/Cinemeta lookup when
 * nothing is cached yet and reports when the file is ready to play. */
app.get('/api/trailer/:id', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  // Queue the lookup before reading the status: a cold call must report
  // `pending`, otherwise the client stops polling and never sees the file.
  warmTrailer(found.item);
  const status = trailerStatus(found.item);
  res.setHeader('Cache-Control', 'no-store');
  const version = status.version || 0;
  res.json({ ...status, url: status.status === 'ready' ? `/api/hero/${encodeURIComponent(found.item.id)}/trailer.mp4?v=${version}` : '' });
});

app.get('/api/frames/:id', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  res.json(frameMeta(found.item));
});

app.get('/api/frames/:id/sprite.jpg', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const { item, full } = found;
  try {
    const out = await ensureSprite(item, full);
    if (!out) return res.status(500).json({ error: 'could not build preview frames' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(out);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/intro/:id', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  try {
    const data = await getIntroMarkers(found.item, found.full);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/intro/:id', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const startSec = Number(req.body?.startSec);
  const endSec = Number(req.body?.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    return res.status(400).json({ error: 'pass numeric startSec and endSec' });
  }
  const saved = saveIntroMarkers(found.item, startSec, endSec);
  if (!saved) return res.status(400).json({ error: 'invalid intro window' });
  res.json(saved);
});

function sendArt(req, res, art, immutable = false) {
  if (!art) return res.status(404).end();
  res.setHeader('Cache-Control', immutable ? 'public, max-age=604800' : 'public, max-age=86400');
  if (art.etag) {
    res.setHeader('ETag', art.etag);
    if (req.headers['if-none-match'] === art.etag) return res.status(304).end();
  }
  if (art.path) return res.sendFile(art.path);
  res.setHeader('Content-Type', art.mime || 'image/jpeg');
  return res.end(art.buffer);
}

app.get('/api/art/:id/:kind', async (req, res) => {
  const want = req.params.kind;
  const kind = want === 'poster' || want === 'logo' ? want : 'backdrop';
  const width = artWidth(req.query.w);
  // Sidecar pictures only exist for poster/backdrop.
  const sidecar = kind === 'logo' ? null : artPath(kind, req.params.id);
  if (sidecar) {
    // Local pictures are often 1920 px wide; scale them to the slot too.
    const scaled = width ? await sizedArt(req.params.id, kind, width, sidecar) : null;
    if (scaled) return sendArt(req, res, scaled, true);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(sidecar);
  }
  const item = getItem(req.params.id);
  if (!item) return res.status(404).end();
  const artId = item.seriesKey || item.id;
  // One cached JPEG per requested width, built from the original.
  const scaled = width && kind !== 'logo' ? await sizedArt(artId, kind, width) : null;
  if (scaled) return sendArt(req, res, scaled, true);
  // Official artwork from the catalog, cached in catalog.db.
  const cached = cachedArt(artId, kind);
  if (cached) return sendArt(req, res, cached, true);
  const art = await officialArt(item, kind);
  if (!art) return res.status(404).end();
  // First view pays for the download; hand back the sized copy when asked.
  const later = width && kind !== 'logo' ? await sizedArt(artId, kind, width) : null;
  if (later) return sendArt(req, res, later, true);
  return sendArt(req, res, art, true);
});

app.get('/api/item/:id', (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const { posterPath, backdropPath, ...safe } = item;
  res.json({ ...safe, hasPoster: Boolean(posterPath), hasBackdrop: Boolean(backdropPath) });
});

/* Delete the video and its subtitle sidecars. The library scan that follows
 * drops the catalog rows, so the card disappears without a restart. */
async function deleteLibraryFiles(found) {
  const base = path.resolve(libraryRoot);
  const full = path.resolve(found.full);
  if (full !== base && !full.toLowerCase().startsWith(base.toLowerCase() + path.sep)) {
    throw Object.assign(new Error('file is outside the library'), { status: 400 });
  }
  try {
    await fs.promises.unlink(full);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const open = err.code === 'EBUSY' || err.code === 'EPERM';
      throw Object.assign(
        new Error(open ? 'the file is open in the player — close it and try again' : err.message),
        { status: open ? 409 : 500 },
      );
    }
  }
  // `<video>.<lang>.vtt` and friends belong to the file that just went away.
  const dir = path.dirname(full);
  const prefix = path.basename(full, path.extname(full)) + '.';
  try {
    for (const name of await fs.promises.readdir(dir)) {
      if (!name.startsWith(prefix) || !/\.(vtt|srt|ass|ssa)$/i.test(name)) continue;
      await fs.promises.unlink(path.join(dir, name)).catch(() => {});
    }
  } catch {
    /* folder vanished with the file */
  }
}

app.delete('/api/item/:id', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  try {
    await deleteLibraryFiles(found);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  const lib = await refreshLibrary('delete');
  res.json({ ok: true, id: found.item.id, count: lib?.items?.length ?? getLibrary().items.length });
});

/* Bulk delete for the series sheet's "Delete all": one scan at the end instead
 * of one per episode. Failures are reported per file (usually a file that is
 * still open in the player). */
app.post('/api/items/delete', async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(String).filter(Boolean))].slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'no episode ids' });
  const removed = [];
  const failed = [];
  for (const id of ids) {
    const found = resolveItemFile(id);
    if (!found) {
      failed.push({ id, error: 'not found' });
      continue;
    }
    try {
      await deleteLibraryFiles(found);
      removed.push(id);
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }
  const lib = removed.length ? await refreshLibrary('delete') : null;
  const payload = {
    ok: failed.length === 0,
    removed: removed.length,
    failed,
    count: lib?.items?.length ?? getLibrary().items.length,
  };
  res.status(failed.length && !removed.length ? 409 : 200).json(payload);
});

/* ---------- subtitles (sidecar .vtt files next to the video) ---------- */
app.get('/api/subtitles/:id', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  let tracks = syncSubtitleTracks(found.item, found.full);
  // Old downloads may predate the English track. Fetch it once on demand so the
  // player always offers English next to the original language.
  if (!tracks.some((track) => track.lang === 'en') && !isOffline()) {
    try {
      const added = await ensureEnglishSubtitle(found.full, found.item);
      if (added) tracks = syncSubtitleTracks(found.item, found.full);
    } catch {
      /* stay with whatever sidecars exist */
    }
  }
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.json({ tracks: tracks.map(({ lang, label }) => ({ lang, label })) });
});

app.get('/api/subtitle/:id/:lang', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const lang = String(req.params.lang || '').toLowerCase();
  const track = subtitleBody(found.item, found.full, lang);
  if (!track) return res.status(404).json({ error: 'subtitle not found' });
  if (track.etag) res.setHeader('ETag', track.etag);
  if (track.etag && req.headers['if-none-match'] === track.etag) return res.status(304).end();
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(track.body);
});

/* ---------- online catalog (metadata only) ---------- */

/* Cinemeta artwork is served from live.metahub.space, which now answers 404.
 * Fill missing posters from the download catalog instead of shipping broken
 * images; a failed lookup just leaves the original payload untouched. */
const BROKEN_ART = /metahub\.space/i;

function artKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function backfillArtwork(data) {
  if (!data?.results?.length) return data;
  try {
    const castle = await searchCastle(data.query);
    const map = new Map();
    for (const item of castle.results) {
      if (item.poster) map.set(artKey(item.title), item);
    }
    return {
      ...data,
      results: data.results.map((item) => {
        const brokenPoster = !item.poster || BROKEN_ART.test(item.poster);
        const brokenBackground = !item.background || BROKEN_ART.test(item.background);
        if (!brokenPoster && !brokenBackground) return item;
        const match = map.get(artKey(item.title));
        if (!match) return item;
        return {
          ...item,
          poster: brokenPoster ? match.poster || item.poster : item.poster,
          background: brokenBackground ? match.background || item.background : item.background,
        };
      }),
    };
  } catch {
    return data;
  }
}

app.get('/api/online/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (q.length > 80) return res.status(400).json({ error: 'q is too long' });

  try {
    const data = await searchOnline(q);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await backfillArtwork(data));
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

app.get('/api/online/title/:type/:id', async (req, res) => {
  try {
    const data = await getOnlineTitle(req.params.type, req.params.id);
    const enriched = await backfillArtwork({ query: data.title, results: [data] });
    res.set('Cache-Control', 'public, max-age=1800');
    res.json(enriched.results[0] || data);
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

/* ---------- castle catalog (search + real downloads) ---------- */

app.get('/api/castle/browse', async (req, res) => {
  const mode = String(req.query.mode || 'random');
  const genre = String(req.query.genre || '').trim();
  try {
    const results = await browseCastle({ mode, genre, fresh: req.query.fresh === '1' });
    res.set('Cache-Control', 'no-store');
    res.json({
      provider: 'castle',
      mode,
      genre,
      count: results.length,
      genres: CASTLE_GENRES.map((entry) => entry.name),
      results,
    });
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

/* Ratings for a handful of Castle ids in one request:
 * /api/castle/ratings?ids=6161299972855808,6150388343775232 */
app.get('/api/castle/ratings', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ids is required' });
  if (ids.length > 24) return res.status(400).json({ error: 'at most 24 ids per request' });
  if (ids.some((id) => !isCastleId(id))) return res.status(400).json({ error: 'every id must be a castle id' });

  try {
    const settled = await Promise.allSettled(ids.map((id) => getCastleStats(id)));
    const ratings = settled
      .filter((entry) => entry.status === 'fulfilled')
      .map((entry) => entry.value);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ provider: 'castle', count: ratings.length, ratings });
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

app.get('/api/castle/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (q.length > 80) return res.status(400).json({ error: 'q is too long' });

  try {
    const data = await searchCastle(q, page);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ source: 'castle', ...data });
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

app.get('/api/castle/title/:id', async (req, res) => {
  if (!isCastleId(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const data = await getCastleTitle(req.params.id, { season: req.query.season });
    res.set('Cache-Control', 'public, max-age=1800');
    res.json(data);
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

/* Saved Castle pictures. The first request downloads the image into
 * catalog.db; every later request (including offline) is a row read. */
function sendCastleImage(req, res, row) {
  if (!row?.blob) return res.status(404).end();
  res.setHeader('Content-Type', row.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  if (row.etag) {
    res.setHeader('ETag', row.etag);
    if (req.headers['if-none-match'] === row.etag) return res.status(304).end();
  }
  return res.end(Buffer.from(row.blob));
}

app.get('/api/castle/art/:id/:kind', async (req, res) => {
  const kind = req.params.kind === 'poster' ? 'poster' : req.params.kind === 'backdrop' ? 'backdrop' : '';
  if (!kind || !isCastleId(req.params.id)) return res.status(404).end();
  try {
    sendCastleImage(req, res, await castleArt(req.params.id, kind));
  } catch {
    res.status(404).end();
  }
});

app.get('/api/castle/episode-art/:episodeId', async (req, res) => {
  if (!isCastleId(req.params.episodeId)) return res.status(404).end();
  try {
    sendCastleImage(req, res, await castleEpisodeArt(req.params.episodeId));
  } catch {
    res.status(404).end();
  }
});

/* Trailer for a catalog-only title. It shares the trailer key with a saved
 * local copy of the same show, so both play the same cut. */
app.get('/api/castle/trailer/:id', (req, res) => {
  const saved = isCastleId(req.params.id) ? getCastleTitleSaved(req.params.id) : null;
  if (!saved) return res.status(404).json({ error: 'title is not saved' });
  const item = castleTrailerItem(saved);
  warmTrailer(item);
  const status = trailerStatus(item);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...status,
    url: status.status === 'ready'
      ? `/api/castle/trailer/${encodeURIComponent(req.params.id)}/file.mp4?v=${status.version || 0}`
      : '',
  });
});

app.get('/api/castle/trailer/:id/file.mp4', (req, res) => {
  const saved = isCastleId(req.params.id) ? getCastleTitleSaved(req.params.id) : null;
  if (!saved) return res.status(404).end();
  const file = trailerPathFor(castleTrailerItem(saved));
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, no-cache');
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(file);
});

/* Sync refreshes all saved Castle titles. GET reports progress; POST starts it. */
app.get('/api/castle/sync', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...castleSyncStatus(),
    savedTitles: castleTitleCount(),
    savedImages: castleMediaCount(),
  });
});

app.post('/api/castle/sync', (req, res) => {
  const result = startCastleSync();
  if (!result.started && result.offline) {
    return res.status(503).json({ error: 'offline mode is on — internet access is disabled', offline: true });
  }
  res.status(result.started ? 202 : 200).json({
    ...result,
    ...castleSyncStatus(),
    savedTitles: castleTitleCount(),
    savedImages: castleMediaCount(),
  });
});

/* All seasons with full episode lists, for "Download all". */
app.get('/api/castle/series/:id/episodes', async (req, res) => {
  if (!isCastleId(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const data = await getCastleSeries(req.params.id);
    res.set('Cache-Control', 'public, max-age=1800');
    res.json(data);
  } catch (err) {
    res.status(err?.status || 502).json({ error: err?.message || String(err) });
  }
});

const QUALITY_LABEL = { 1: '480p', 2: '720p', 3: '1080p' };

function pad2(value) {
  return String(Math.max(0, Number(value) || 0)).padStart(2, '0');
}

/* Ranked Torrentio releases for one episode/movie, for debugging the picker:
 * /api/releases?imdbId=tt12590266&season=1&episode=1&original=Japanese */
app.get('/api/releases', async (req, res) => {
  const imdbId = String(req.query.imdbId || '');
  if (!/^tt\d{4,10}$/.test(imdbId)) return res.status(400).json({ error: 'imdbId is required' });
  const isSeries = req.query.type !== 'movie';
  const season = Number(req.query.season) || 0;
  const episode = Number(req.query.episode) || 0;
  try {
    const streams = await findReleases({ imdbId, isSeries, season, episode });
    const ranked = rankReleases(streams, { originalLanguage: String(req.query.original || '') });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      imdbId,
      streams: streams.length,
      count: ranked.length,
      releases: ranked.slice(0, 15).map((release) => ({
        label: releaseLabel(release),
        name: release.name,
        fileName: release.fileName,
        quality: release.quality,
        codec: release.codec,
        seeders: release.seeders,
        sizeBytes: release.sizeBytes,
        dualAudio: release.dualAudio,
        languages: release.languages,
        score: release.score,
        infoHash: release.infoHash,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) });
  }
});

app.post('/api/castle/download', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'JSON body required' });
  }

  const movieId = String(body.movieId || '');
  const episodeId = String(body.episodeId || '');
  const resolution = Number(body.resolution) || 2;
  if (!isCastleId(movieId)) return res.status(400).json({ error: 'movieId is required' });
  if (!isCastleId(episodeId)) return res.status(400).json({ error: 'episodeId is required' });
  if (!QUALITY_LABEL[resolution]) return res.status(400).json({ error: 'resolution must be 1, 2 or 3' });

  const title = String(body.title || '').trim() || 'Untitled';
  const season = Number(body.season) || 0;
  const episode = Number(body.episode) || 0;
  const quality = QUALITY_LABEL[resolution];
  const isSeries = season > 0;
  const fileName = isSeries
    ? `${title} S${pad2(season)}E${pad2(episode)} ${quality}.mp4`
    : `${title}${body.year ? ` (${body.year})` : ''} ${quality}.mp4`;

  try {
    const audio = await getCastleEpisodeTracks({ movieId, episodeId }).catch(() => null);
    const originalAudio = audio?.original || '';

    /* Torrentio first when it has a healthy H.264 release with the original
     * audio and English; Castle stays the fallback (HLS 720p) and the source of
     * every piece of metadata the UI shows. */
    if (body.source !== 'castle') {
      try {
        const imdbId = await resolveImdbId({
          title,
          seriesTitle: title,
          isSeries,
          tmdbId: body.imdbId,
          id: `castle:${movieId}`,
          seriesKey: `castle:${movieId}`,
        });
        if (imdbId) {
          const torrent = await addTorrentDownload({
            imdbId,
            season,
            episode,
            seriesTitle: title,
            year: Number(body.year) || 0,
            originalLanguage: originalAudio,
            collection: 'Downloads',
            folder: isSeries ? title : '',
            poster: String(body.poster || ''),
          });
          if (torrent?.skipped) {
            return res.status(200).json({ ...torrent, source: 'torrentio', originalAudio });
          }
          if (torrent) return res.status(201).json({ ...torrent, originalAudio });
        }
      } catch (err) {
        console.warn(`[download] torrentio unavailable (${err?.message || err}); falling back to castle`);
      }
    }

    const stream = await getCastleStream({ movieId, episodeId, resolution });
    if (stream.preview) {
      return res.status(409).json({ error: 'this quality is only available as a preview' });
    }
    // Original language + English only; the rest are dubs we do not keep.
    const audioTracks = audio ? selectCastleAudioTracks(audio.tracks, audio.original) : [];

    // Keep every track the service ships (original language + English and the
    // rest), then add an English track from OpenSubtitles if it is missing.
    const seen = new Set();
    const subtitles = [];
    for (const track of stream.subtitles || []) {
      const code = String(track.language || '').toLowerCase();
      if (!/^[a-z]{2,3}$/.test(code) || seen.has(code) || !track.url) continue;
      seen.add(code);
      subtitles.push({ language: code, url: track.url });
    }
    if (!seen.has('en') && !isOffline()) {
      try {
        const imdbId = await resolveImdbId({
          title,
          seriesTitle: title,
          isSeries,
          tmdbId: body.imdbId,
        });
        const english = await fetchEnglishSubtitle({ imdbId, season, episode });
        if (english) subtitles.push({ language: 'en', text: english });
      } catch {
        /* the download still succeeds without the extra track */
      }
    }

    const jobs = await addHlsDownload({
      url: stream.url,
      referer: 'https://api.hlowb.com/',
      title: isSeries ? `${title} S${pad2(season)}E${pad2(episode)}` : title,
      seriesTitle: title,
      fileName,
      collection: 'Downloads',
      folder: isSeries ? title : '',
      season,
      episode,
      total: Number(body.size) || 0,
      poster: String(body.poster || ''),
      source: 'castle',
      subtitles,
      audioTracks,
    });
    res.status(201).json({
      count: jobs.length,
      jobs,
      source: 'castle',
      quality,
      subtitleCount: stream.subtitles.length,
      subtitles: subtitles.map((track) => track.language),
      audio: audioTracks.map((track) => track.language),
      originalAudio: audio?.original || '',
    });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || String(err) });
  }
});

/* ---------- downloads ---------- */

app.get('/api/downloads', (req, res) => {
  const jobs = listDownloads();
  res.json({ root: libraryRoot, count: jobs.length, jobs });
});

app.post('/api/downloads/:id/retry', (req, res) => {
  const job = retryDownload(req.params.id);
  if (!job) return res.status(404).json({ error: 'download not found' });
  res.json(job);
});

app.delete('/api/downloads/:id', async (req, res) => {
  const job = await cancelDownload(req.params.id);
  if (!job) return res.status(404).json({ error: 'download not found' });
  res.json(job);
});

/* Stop the app. The single-file build has no tray icon, so this menu item is
 * the way to shut it down; only a loopback caller may use it. */
app.post('/api/quit', (req, res) => {
  const remote = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    return res.status(403).json({ error: 'local requests only' });
  }
  res.json({ ok: true });
  setTimeout(() => {
    // Leave the file compact and the query plans fresh for the next start.
    try {
      analyzeDb();
      maybeVacuum();
    } catch {
      /* shutting down anyway */
    }
    process.exit(0);
  }, 200);
});

/* Assets are cached for a year, so their URLs carry a stamp that changes
 * whenever one of the files does. HTML itself is revalidated on every load. */
const ASSET_VERSION = (() => {
  const hash = crypto.createHash('sha1');
  for (const name of ['app.js', 'common.js', 'watch.js', 'styles.css', 'watch.css', 'fonts.css']) {
    try {
      const st = fs.statSync(path.join(publicDir, name));
      hash.update(`${name}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      /* a file missing from a custom build just does not contribute */
    }
  }
  return hash.digest('hex').slice(0, 8);
})();

function sendHtml(res, name, status = 200) {
  fs.readFile(path.join(publicDir, name), 'utf8', (err, html) => {
    if (err) return res.status(500).end();
    const versioned = html.replace(/(href|src)="\/([^"?#]+\.(?:css|js))"/g, `$1="/$2?v=${ASSET_VERSION}"`);
    res.status(status);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(versioned);
  });
}

app.get(['/', '/index.html'], (req, res) => sendHtml(res, 'index.html'));
app.get(['/watch', '/watch.html'], (req, res) => sendHtml(res, 'watch.html'));
app.use(express.static(publicDir, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else if (/\.(?:js|css|woff2?|ttf|otf|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.mp4$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));
app.use((req, res) => sendHtml(res, '404.html', 404));

function listen(port, attempt = 0) {
  const server = app.listen(port, async () => {
    const actual = server.address()?.port || port;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(PORT_FILE, String(actual), 'utf8');
    console.log(`netflix-home running at http://localhost:${actual}`);
    console.log(`library root: ${libraryRoot}`);
    const cached = getLibrary();
    console.log(`library ready: ${cached.items.length} title(s) from catalog.db`);
    // Serve the saved index immediately; verify folder mtimes in the background
    // and let the watcher take it from there.
    setTimeout(() => refreshLibrary('startup'), 1200).unref?.();
    watchLibrary();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 8) {
      const next = 20000 + Math.floor(Math.random() * 40000);
      console.warn(`port ${port} is in use, trying ${next}`);
      listen(next, attempt + 1);
      return;
    }
    console.error('server could not start:', err.message);
    process.exit(1);
  });
}

listen(preferredPort);
