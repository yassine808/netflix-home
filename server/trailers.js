import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveImdbId, normalizeTitle } from './imdb.js';
import { isOffline } from './settings.js';
import { getDb } from './db.js';
import { netflixTrailer } from './netflix.js';
import { run as runProc, playbackActive } from './proc.js';

/**
 * Trailers: Netflix's own billboard clip first (see server/netflix.js), then
 * Cinemeta (keyless) resolves the official trailer of the season that matches
 * the library; KinoCheck covers titles Cinemeta misses, then a YouTube search.
 * The cut is downloaded once into <cache>\trailers and indexed in the shared
 * catalog database. The home billboard and the series sheet then play it from
 * disk, online or offline.
 */

const CINEMETA = 'https://v3-cinemeta.strem.io';
const KINOCHECK = 'https://api.kinocheck.de';
const TRAILER_HEIGHT = 720;

/* SQLite is shared with the rest of the catalog; see db.js. */
let db = null;
let trailerDir = null;
let ytDlp = process.env.YTDLP_PATH || 'yt-dlp.exe';
const resolving = new Map();

function hashFor(id) {
  return crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 20);
}

export function initTrailers(cacheDir, { ytDlpPath } = {}) {
  if (ytDlpPath) ytDlp = ytDlpPath;
  trailerDir = path.join(cacheDir, 'trailers');
  try {
    fs.mkdirSync(trailerDir, { recursive: true });
    db = getDb();
    if (!db) throw new Error('sqlite missing');
    db.exec(`CREATE TABLE IF NOT EXISTS trailers (
      id TEXT PRIMARY KEY,
      imdb_id TEXT,
      youtube_id TEXT,
      title TEXT,
      path TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      source TEXT,
      fetched_at INTEGER NOT NULL
    )`);
    // Older databases predate the source column; keep their rows.
    try {
      db.exec('ALTER TABLE trailers ADD COLUMN source TEXT');
    } catch {
      /* column already there */
    }
  } catch (err) {
    db = null;
    console.warn('trailer index disabled:', err?.message || String(err));
  }
}

function rowFor(id) {
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM trailers WHERE id = ?').get(String(id)) || null;
  } catch {
    return null;
  }
}

function writeRow(entry) {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO trailers (id, imdb_id, youtube_id, title, path, size, status, error, source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        imdb_id = excluded.imdb_id,
        youtube_id = excluded.youtube_id,
        title = excluded.title,
        path = excluded.path,
        size = excluded.size,
        status = excluded.status,
        error = excluded.error,
        source = excluded.source,
        fetched_at = excluded.fetched_at`)
      .run(entry.id, entry.imdbId || '', entry.youtubeId || '', entry.title || '',
        entry.path || '', Number(entry.size) || 0, entry.status || 'pending',
        entry.error || null, entry.source || '', Date.now());
  } catch {
    /* index is best effort */
  }
}

async function fetchJson(url, timeout = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* KinoCheck is keyless and indexes movies, shows and anime by IMDb id. It often
 * has no trailer for older shows, so it runs after Cinemeta. */
async function resolveViaKinocheck(item, imdbId) {
  const kind = item.isSeries ? 'shows' : 'movies';
  const data = await fetchJson(`${KINOCHECK}/${kind}?imdb_id=${encodeURIComponent(imdbId)}&language=en`);
  return data?.trailer?.youtube_video_id || null;
}

/* Cinemeta lists official trailers per title; the first one is the main cut.
 * When it has no entry, the caller falls back to a YouTube search. */
async function resolveTrailer(item) {
  const imdbId = await resolveImdbId(item);
  if (!imdbId) return null;
  const type = item.isSeries ? 'series' : 'movie';
  const key = `${type}:${imdbId}`;
  if (resolving.has(key)) return resolving.get(key);
  const task = (async () => {
    try {
      const data = await fetchJson(`${CINEMETA}/meta/${type}/${encodeURIComponent(imdbId)}.json`);
      const list = Array.isArray(data?.meta?.trailers) ? data.meta.trailers : [];
      const official = list.find((entry) => entry && entry.source && entry.type !== 'Teaser') || list[0];
      if (official?.source) return { imdbId, youtubeId: official.source };
    } catch {
      /* fall through to KinoCheck */
    }
    try {
      return { imdbId, youtubeId: await resolveViaKinocheck(item, imdbId) };
    } catch {
      return { imdbId, youtubeId: null };
    }
  })();
  resolving.set(key, task);
  task.finally(() => resolving.delete(key));
  return task;
}

function run(cmd, args, timeout) {
  return runProc(cmd, args, { timeout, maxBuffer: 1024 * 1024 * 16, lane: 'media' })
    .catch((err) => {
      throw new Error(String(err.stderr || err.message).trim());
    });
}

function trailerKey(item) {
  if (item.isSeries && item.seriesTitle) return `series:${normalizeTitle(item.seriesTitle)}`;
  return `item:${item.id}`;
}

/* Cinemeta has a trailer for most titles; the rest go through a YouTube search.
 * The year narrows the search so a remake does not win. */
function searchQuery(item) {
  const title = String(item.seriesTitle || item.title || '').trim();
  const year = Number(item.year) > 1900 ? ` ${item.year}` : '';
  return `${title}${year} official trailer`;
}

async function download(item, youtubeId) {
  const file = path.join(trailerDir, `${hashFor(trailerKey(item))}.mp4`);
  const temp = file.replace(/\.mp4$/, '.part');
  // A known id goes straight to the video; otherwise yt-dlp searches YouTube
  // and takes the first hit that looks like a trailer rather than an episode.
  const url = youtubeId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`
    : `ytsearch5:${searchQuery(item)}`;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=android,ios',
    ...(youtubeId ? [] : ['--ignore-errors', '--match-filter', 'duration > 20 & duration < 900']),
    '-f', `bestvideo[height<=${TRAILER_HEIGHT}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${TRAILER_HEIGHT}][ext=mp4]/best[height<=${TRAILER_HEIGHT}]`,
    '--merge-output-format', 'mp4',
    '-o', temp,
    url,
  ];
  await run(ytDlp, args, 180000);
  await fsp.rename(temp, file);
  const stat = await fsp.stat(file);
  if (stat.size < 200 * 1024) throw new Error('trailer file is too small');
  return { file, size: stat.size };
}

/* Netflix gives a direct signed MP4, so no yt-dlp step is needed. Download to
 * the same `.part` name and rename only once the whole file is on disk, so a
 * broken transfer never replaces a good trailer. */
async function downloadDirect(item, url) {
  const file = path.join(trailerDir, `${hashFor(trailerKey(item))}.mp4`);
  const temp = file.replace(/\.mp4$/, '.part');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`netflix clip HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || '');
  if (type && !type.startsWith('video/')) throw new Error(`netflix clip is ${type}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 200 * 1024) throw new Error('netflix clip is too small');
  await fsp.writeFile(temp, buffer);
  await fsp.rename(temp, file);
  return { file, size: buffer.length };
}

/* One download at a time: trailers are a background nicety, not playback.
 * The queue holds the work itself, so yt-dlp runs for one title at a time. */
const queue = [];
const queued = new Map();
let active = 0;

function pump() {
  if (active >= 1) return;
  /* Offline: the queue waits. A trailer is a nicety, every way to fetch one
   * leaves the machine, and the switch turning back on is what restarts it. */
  if (isOffline()) return;
  const next = queue.shift();
  if (!next) return;
  active += 1;
  next.work().finally(() => { active -= 1; pump(); });
}

/** Called when offline mode turns off, so queued trailers start again. */
export function resumeTrailerQueue() {
  pump();
}

export function warmTrailer(item) {
  if (!item || isOffline()) return null;
  const key = trailerKey(item);
  if (queued.has(key)) return queued.get(key);

  const existing = trailerReady(item);
  const row = rowFor(key);
  // A trailer already known to come from Netflix (or from the fallback chain)
  // is final. Rows from older builds have no source yet: give Netflix one try,
  // then keep the file and remember that it is the fallback copy.
  if (existing && row?.source) return null;

  const title = item.seriesTitle || item.title;
  const work = async () => {
    if (existing) {
      const netflix = await netflixTrailer(item);
      if (netflix?.videoUrl) {
        try {
          const { file, size } = await downloadDirect(item, netflix.videoUrl);
          writeRow({
            id: key,
            imdbId: row?.imdb_id || '',
            youtubeId: '',
            title,
            path: file,
            size,
            status: 'ready',
            source: 'netflix',
          });
          return file;
        } catch {
          /* keep the trailer that already works */
        }
      }
      writeRow({
        id: key,
        imdbId: row?.imdb_id || '',
        youtubeId: row?.youtube_id || '',
        title,
        path: existing.path,
        size: existing.size,
        status: 'ready',
        source: 'cache',
      });
      return existing.path;
    }

    // Netflix's own billboard clip first: no YouTube step, one direct MP4.
    const netflix = await netflixTrailer(item);
    if (netflix?.videoUrl) {
      writeRow({ id: key, imdbId: '', youtubeId: '', title, status: 'pending', source: 'netflix' });
      try {
        const { file, size } = await downloadDirect(item, netflix.videoUrl);
        writeRow({
          id: key,
          imdbId: '',
          youtubeId: '',
          title,
          path: file,
          size,
          status: 'ready',
          source: 'netflix',
        });
        return file;
      } catch {
        /* fall through to Cinemeta */
      }
    }

    const resolved = await resolveTrailer(item);
    const youtubeId = resolved?.youtubeId || null;
    const imdbId = resolved?.imdbId || null;
    writeRow({ id: key, imdbId, youtubeId, title, status: 'pending', source: 'cinemeta' });
    try {
      const { file, size } = await download(item, youtubeId);
      writeRow({
        id: key,
        imdbId,
        youtubeId,
        title,
        path: file,
        size,
        status: 'ready',
        source: 'cinemeta',
      });
      return file;
    } catch (err) {
      writeRow({
        id: key,
        imdbId,
        youtubeId,
        title,
        status: 'failed',
        error: err?.message || String(err),
        source: 'cinemeta',
      });
      return null;
    }
  };

  const task = new Promise((resolve) => {
    queue.push({ work: async () => resolve(await work()) });
  });
  queued.set(key, task);
  task.finally(() => { queued.delete(key); });
  pump();
  return task;
}

function trailerReady(item) {
  if (!item) return null;
  const row = rowFor(trailerKey(item));
  if (!row || row.status !== 'ready' || !row.path) return null;
  try {
    if (fs.statSync(row.path).size > 200 * 1024) return { path: row.path, youtubeId: row.youtube_id, size: Number(row.size) || 0 };
  } catch {
    /* file vanished; rebuild next time */
  }
  return null;
}

export function trailerPathFor(item) {
  const ready = trailerReady(item);
  return ready ? ready.path : null;
}

export function trailerStatus(item) {
  const ready = trailerReady(item);
  if (ready) {
    const row = rowFor(trailerKey(item));
    return { ...ready, status: 'ready', source: row?.source || '', version: row?.fetched_at || 0 };
  }
  const key = trailerKey(item);
  const row = rowFor(key);
  if (!row) return { status: queued.has(key) ? 'pending' : 'none' };
  return { status: row.status, youtubeId: row.youtube_id, error: row.error, source: row.source || '' };
}

/* Warm the billboard trailer for one item per series, newest titles first. */
export function warmTrailers(items) {
  if (isOffline() || !Array.isArray(items)) return;
  const seen = new Set();
  const picks = [];
  for (const item of items) {
    if (!item || item.durationSec < 90) continue;
    const key = item.seriesKey || `item:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(item);
  }
  picks
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, 30)
    .forEach((item) => {
      if (playbackActive()) return;
      warmTrailer(item);
    });
}
