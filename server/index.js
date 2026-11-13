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
} from './downloads.js';
import { searchOnline, getOnlineTitle } from './online.js';
import { searchCastle, getCastleTitle, getCastleStream, isCastleId } from './castle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const cacheDir = path.join(projectRoot, '.cache');

function resolveLibraryRoot() {
  if (process.env.LIBRARY_ROOT) return path.resolve(process.env.LIBRARY_ROOT);
  for (const candidate of ['G:\\Movies', 'G:\\']) {
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
const port = Number(process.env.PORT) || 3000;

initCache(cacheDir);
getLibrary().root = libraryRoot;
initDownloads({
  root: libraryRoot,
  onDownloadComplete: async () => {
    await scanLibrary(libraryRoot);
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

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
    res.json({ ok: true, count: lib.items.length, updatedAt: lib.updatedAt });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
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
  const out = await ensureThumb(item, full);
  if (!out) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(out);
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

    const english = stream.subtitles.find((track) => track.language === 'en')
      || stream.subtitles.find((track) => /^english/i.test(track.title));

    const jobs = await addHlsDownload({
      url: stream.url,
      referer: 'https://api.hlowb.com/',
      title: isSeries ? `${title} S${pad2(season)}E${pad2(episode)}` : title,
      fileName,
      collection: 'Downloads',
      folder: isSeries ? title : '',
      total: Number(body.size) || 0,
      poster: String(body.poster || ''),
      source: 'castle',
      subtitleUrl: english?.url || '',
      subtitleLang: english?.language || 'en',
    });
    res.status(201).json({ count: jobs.length, jobs, subtitleCount: stream.subtitles.length });
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

app.delete('/api/downloads/:id', (req, res) => {
  const job = cancelDownload(req.params.id);
  if (!job) return res.status(404).json({ error: 'download not found' });
  res.json(job);
});

app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('/watch', (req, res) => res.sendFile(path.join(publicDir, 'watch.html')));
app.use((req, res) => res.status(404).sendFile(path.join(publicDir, '404.html')));

app.listen(port, async () => {
  console.log(`netflix-home running at http://localhost:${port}`);
  console.log(`library root: ${libraryRoot}`);
  try {
    const lib = await scanLibrary(libraryRoot);
    console.log(`library ready: ${lib.items.length} title(s) in ${lib.scannedInMs} ms`);
  } catch (err) {
    console.error('scan failed:', err);
  }
});
