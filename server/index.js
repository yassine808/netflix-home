import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initCache, scanLibrary, getLibrary, getItem, resolveItemFile,
  ensureThumb, artPath, isScanning,
} from './library.js';
import {
  initDownloads, searchCatalog, getCatalogItem, fallbackCatalog,
  addDownload, addSeriesDownload, addHlsDownload,
  listDownloads, getDownload, cancelDownload, retryDownload,
  pauseDownloads, resumeDownloads,
} from './downloads.js';
import { searchOnline, getOnlineTitle } from './online.js';
import { searchCastle, getCastleTitle, getCastleSeries, getCastleStream, isCastleId } from './castle.js';
import { initSettings, getSettings, isOffline, setOffline } from './settings.js';
import { initFrames, frameMeta, ensureSprite, spriteFile } from './frames.js';
import { initIntro, getIntroMarkers, saveIntroMarkers } from './intro.js';
import { initHero, heroStart, heroReady, ensureHero, warmHeroes } from './hero.js';
import { initTrailers, trailerPathFor, trailerStatus, warmTrailer, warmTrailers } from './trailers.js';
import { resolveImdbId } from './imdb.js';
import { ensureEnglishSubtitle, fetchEnglishSubtitle } from './subs.js';

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

initCache(cacheDir);
initSettings(cacheDir);
initFrames(cacheDir);
initIntro(cacheDir);
initHero(cacheDir);
initTrailers(cacheDir, {
  ytDlpPath: process.env.YTDLP_PATH || path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'bin', 'yt-dlp.exe'),
});
getLibrary().root = libraryRoot;
initDownloads({
  root: libraryRoot,
  onDownloadComplete: async () => {
    const lib = await scanLibrary(libraryRoot);
    warmHeroes(lib.items, libraryRoot);
    warmTrailers(lib.items);
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

/* Offline mode: the flag lives on the server, so the browser cannot route
 * around it. Every route that reaches the internet answers 503. */
app.use('/api', (req, res, next) => {
  if (!isOffline()) return next();
  const p = req.path;
  const method = req.method;
  const blocked = p.startsWith('/online/')
    || p.startsWith('/castle/')
    || p === '/catalog/search'
    || p.startsWith('/catalog/item/')
    || (method === 'POST' && (p === '/downloads'
      || p === '/downloads/series'
      || /^\/downloads\/[^/]+\/retry$/.test(p)));
  if (!blocked) return next();
  res.status(503).json({ error: 'offline mode is on — internet access is disabled', offline: true });
});

app.get('/api/settings', (req, res) => res.json(getSettings()));

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

app.get('/api/library', (req, res) => {
  const lib = getLibrary();
  res.json({
    root: lib.root,
    updatedAt: lib.updatedAt,
    scannedInMs: lib.scannedInMs,
    scanning: isScanning(),
    items: lib.items.map((item) => {
      const { posterPath, backdropPath, ...safe } = item;
      return { ...safe, hasPoster: Boolean(posterPath), hasBackdrop: Boolean(backdropPath) };
    }),
    collections: lib.collections,
  });
});

app.post('/api/rescan', async (req, res) => {
  try {
    const lib = await scanLibrary(libraryRoot);
    warmHeroes(lib.items, libraryRoot);
    warmTrailers(lib.items);
    res.json({ ok: true, count: lib.items.length, updatedAt: lib.updatedAt });
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

app.get('/api/stream/:id', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).end();
  const { item, full } = found;

  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return res.status(404).end();
  }

  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
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
});

app.get('/api/thumb/:id', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).end();
  const { item, full } = found;
  const requested = Number(req.query.w) || 1280;
  const width = Math.min(1280, Math.max(160, Math.round(requested / 160) * 160));
  const out = await ensureThumb(item, full, width);
  if (!out) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(out);
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
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(file);
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

app.get('/api/art/:id/:kind', (req, res) => {
  const kind = req.params.kind === 'poster' ? 'poster' : 'backdrop';
  const art = artPath(kind, req.params.id);
  if (!art) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(art);
});

app.get('/api/item/:id', (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const { posterPath, backdropPath, ...safe } = item;
  res.json({ ...safe, hasPoster: Boolean(posterPath), hasBackdrop: Boolean(backdropPath) });
});

/* ---------- subtitles (sidecar .vtt files next to the video) ---------- */

const SUBTITLE_LABELS = {
  en: 'English', fr: 'Français', ar: 'العربية', it: 'Italiano', es: 'Español',
  de: 'Deutsch', pt: 'Português', nl: 'Nederlands', pl: 'Polski', ru: 'Русский',
  tr: 'Türkçe', ja: '日本語', ko: '한국어', zh: '中文', hi: 'हिन्दी',
  th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu',
  tl: 'Filipino', sv: 'Svenska', da: 'Dansk', no: 'Norsk', fi: 'Suomi',
  cs: 'Čeština', el: 'Ελληνικά', he: 'עברית', hu: 'Magyar', ro: 'Română',
  uk: 'Українська', bg: 'Български', hr: 'Hrvatski', sr: 'Српски', sk: 'Slovenčina',
};
const SUBTITLE_ORDER = ['en', 'fr', 'ar', 'it'];

function subtitleTracks(full) {
  let names;
  try {
    names = fs.readdirSync(path.dirname(full));
  } catch {
    return [];
  }
  const stem = path.basename(full).replace(/\.[^.]+$/, '').toLowerCase();
  const tracks = [];
  const seen = new Set();
  for (const name of names) {
    if (!/\.vtt$/i.test(name)) continue;
    const base = name.replace(/\.vtt$/i, '');
    if (!base.toLowerCase().startsWith(stem)) continue;
    const suffix = base.slice(stem.length);
    const match = /\.([a-z]{2,3})$/i.exec(suffix);
    const lang = match ? match[1].toLowerCase() : '';
    if (!lang || seen.has(lang)) continue;
    seen.add(lang);
    tracks.push({ lang, label: SUBTITLE_LABELS[lang] || lang.toUpperCase(), file: name });
  }
  const rank = (lang) => {
    const index = SUBTITLE_ORDER.indexOf(lang);
    return index >= 0 ? index : SUBTITLE_ORDER.length;
  };
  return tracks.sort((a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang));
}

app.get('/api/subtitles/:id', async (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  let tracks = subtitleTracks(found.full);
  // Old downloads may predate the English track. Fetch it once on demand so the
  // player always offers English next to the original language.
  if (!tracks.some((track) => track.lang === 'en') && !isOffline()) {
    try {
      const added = await ensureEnglishSubtitle(found.full, found.item);
      if (added) tracks = subtitleTracks(found.full);
    } catch {
      /* stay with whatever sidecars exist */
    }
  }
  res.json({ tracks });
});

app.get('/api/subtitle/:id/:lang', (req, res) => {
  const found = resolveItemFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const lang = String(req.params.lang || '').toLowerCase();
  const track = subtitleTracks(found.full).find((entry) => entry.lang === lang);
  if (!track) return res.status(404).json({ error: 'subtitle not found' });
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(path.dirname(found.full), track.file));
});

/* ---------- public-domain catalog ---------- */

app.get('/api/catalog/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const results = await searchCatalog(q, page);
    res.json({ source: 'archive.org', query: q, page, count: results.length, results });
  } catch (err) {
    const results = fallbackCatalog();
    res.json({
      source: 'fallback',
      query: q,
      page,
      count: results.length,
      fallback: true,
      error: err?.message || String(err),
      results,
    });
  }
});

app.get('/api/catalog/fallback', (req, res) => {
  const results = fallbackCatalog();
  res.json({ source: 'fallback', count: results.length, results });
});

app.get('/api/catalog/item/:identifier', async (req, res) => {
  try {
    const item = await getCatalogItem(req.params.identifier);
    res.json(item);
  } catch (err) {
    res.status(err?.status || 502).json({
      error: err?.message || String(err),
      ...(err?.files ? { files: err.files } : {}),
    });
  }
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
    const stream = await getCastleStream({ movieId, episodeId, resolution });
    if (stream.preview) {
      return res.status(409).json({ error: 'this quality is only available as a preview' });
    }

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
      total: Number(body.size) || 0,
      poster: String(body.poster || ''),
      source: 'castle',
      subtitles,
    });
    res.status(201).json({
      count: jobs.length,
      jobs,
      subtitleCount: stream.subtitles.length,
      subtitles: subtitles.map((track) => track.language),
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

app.get('/api/downloads/:id', (req, res) => {
  const job = getDownload(req.params.id);
  if (!job) return res.status(404).json({ error: 'download not found' });
  res.json(job);
});

app.post('/api/downloads', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'JSON body required' });
  }
  if (!body.url && !body.identifier) {
    return res.status(400).json({ error: 'pass "url" or "identifier"' });
  }

  try {
    const jobs = await addDownload(body);
    res.status(201).json({ count: jobs.length, jobs });
  } catch (err) {
    res.status(err?.status || 500).json({
      error: err?.message || String(err),
      ...(err?.files ? { files: err.files } : {}),
    });
  }
});

app.post('/api/downloads/series', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.identifier) {
    return res.status(400).json({ error: 'pass "identifier" (and optional "files")' });
  }
  try {
    const jobs = await addSeriesDownload(body);
    res.status(201).json({ count: jobs.length, jobs });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || String(err) });
  }
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
  setTimeout(() => process.exit(0), 200);
});

app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('/watch', (req, res) => res.sendFile(path.join(publicDir, 'watch.html')));
app.use((req, res) => res.status(404).sendFile(path.join(publicDir, '404.html')));

function listen(port, attempt = 0) {
  const server = app.listen(port, async () => {
    const actual = server.address()?.port || port;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(PORT_FILE, String(actual), 'utf8');
    console.log(`netflix-home running at http://localhost:${actual}`);
    console.log(`library root: ${libraryRoot}`);
    try {
      const lib = await scanLibrary(libraryRoot);
      console.log(`library ready: ${lib.items.length} title(s) in ${lib.scannedInMs} ms`);
      warmHeroes(lib.items, libraryRoot);
    warmTrailers(lib.items);
    } catch (err) {
      console.error('scan failed:', err);
    }
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
