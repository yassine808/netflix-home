import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveImdbId, normalizeTitle } from './imdb.js';
import { isOffline, getTmdbKey } from './settings.js';
import { getDb } from './db.js';
import { run as runProc, playbackActive } from './proc.js';

/**
 * Trailers: resolve the official trailer through TMDB (when an API key is set)
 * and fall back to Cinemeta (keyless). The YouTube id is downloaded once with
 * yt-dlp into <cache>\trailers and indexed in the shared catalog database.
 * The home billboard then plays the trailer instead of the generated clip.
 */

const CINEMETA = 'https://v3-cinemeta.strem.io';
const TMDB = 'https://api.themoviedb.org/3';
const TMDB_LANG = 'en-US';
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
      fetched_at INTEGER NOT NULL
    )`);
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
    db.prepare(`INSERT INTO trailers (id, imdb_id, youtube_id, title, path, size, status, error, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        imdb_id = excluded.imdb_id,
        youtube_id = excluded.youtube_id,
        title = excluded.title,
        path = excluded.path,
        size = excluded.size,
        status = excluded.status,
        error = excluded.error,
        fetched_at = excluded.fetched_at`)
      .run(entry.id, entry.imdbId || '', entry.youtubeId || '', entry.title || '',
        entry.path || '', Number(entry.size) || 0, entry.status || 'pending',
        entry.error || null, Date.now());
  } catch {
    /* index is best effort */
  }
}

async function fetchJson(url, timeout = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* Cinemeta lists official trailers per title; the first one is the main cut. */
async function resolveYoutubeId(item) {
  const imdbId = await resolveImdbId(item);
  if (!imdbId) return null;
  const type = item.isSeries ? 'series' : 'movie';
  const key = `${type}:${imdbId}`;
  if (resolving.has(key)) return resolving.get(key);
  const task = (async () => {
    let youtubeId = null;

    // TMDB first: official trailer/teaser, best metadata, needs a key.
    try {
      youtubeId = await resolveViaTmdb(item, imdbId);
    } catch {
      youtubeId = null;
    }
    if (youtubeId) return { imdbId, youtubeId };

    // Cinemeta stays as the keyless fallback.
    try {
      const data = await fetchJson(`${CINEMETA}/meta/${type}/${encodeURIComponent(imdbId)}.json`);
      const list = Array.isArray(data?.meta?.trailers) ? data.meta.trailers : [];
      const official = list.find((entry) => entry && entry.source && entry.type !== 'Teaser') || list[0];
      return { imdbId, youtubeId: official?.source || null };
    } catch {
      return { imdbId, youtubeId: null };
    }
  })();
  resolving.set(key, task);
  task.finally(() => resolving.delete(key));
  return task;
}

/* TMDB accepts a v3 key (32-char hex) as a query parameter or a v4 read token
 * (JWT) as a bearer header. Keep both working without asking which one it is. */
async function tmdbJson(pathname) {
  const key = getTmdbKey();
  if (!key) return null;
  const url = new URL(`${TMDB}${pathname}`);
  url.searchParams.set('language', TMDB_LANG);
  const headers = { accept: 'application/json' };
  if (key.includes('.')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

export async function validateTmdbKey(key) {
  const value = String(key || '').trim();
  if (!value) return false;
  const url = new URL(`${TMDB}/configuration`);
  const headers = { accept: 'application/json' };
  if (value.includes('.')) headers.authorization = `Bearer ${value}`;
  else url.searchParams.set('api_key', value);
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

function pickYoutubeTrailer(results) {
  const list = (Array.isArray(results) ? results : [])
    .filter((video) => video && video.site === 'YouTube' && video.key);
  const rank = (video) => (video.type === 'Trailer' ? 0 : video.type === 'Teaser' ? 1 : 2);
  list.sort((a, b) => rank(a) - rank(b)
    || Number(Boolean(b.official)) - Number(Boolean(a.official))
    || (Number(b.size) || 0) - (Number(a.size) || 0));
  return list[0] || null;
}

/* IMDb id -> TMDB id -> official YouTube trailer. */
async function resolveViaTmdb(item, imdbId) {
  if (!getTmdbKey()) return null;
  const found = await tmdbJson(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
  const hits = item.isSeries ? found?.tv_results : found?.movie_results;
  const id = hits?.[0]?.id;
  if (!id) return null;
  const videos = await tmdbJson(`/${item.isSeries ? 'tv' : 'movie'}/${id}/videos`);
  return pickYoutubeTrailer(videos?.results)?.key || null;
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

async function download(item, youtubeId) {
  const file = path.join(trailerDir, `${hashFor(trailerKey(item))}.mp4`);
  const temp = file.replace(/\.mp4$/, '.part');
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=android,ios',
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

/* One download at a time: trailers are a background nicety, not playback.
 * The queue holds the work itself, so yt-dlp runs for one title at a time. */
const queue = [];
const queued = new Map();
let active = 0;

function pump() {
  if (active >= 1) return;
  const next = queue.shift();
  if (!next) return;
  active += 1;
  next.work().finally(() => { active -= 1; pump(); });
}

export function warmTrailer(item) {
  if (!item || isOffline()) return null;
  const key = trailerKey(item);
  if (queued.has(key)) return queued.get(key);
  if (trailerReady(item)) return null;

  const work = async () => {
    const resolved = await resolveYoutubeId(item);
    if (!resolved?.youtubeId) {
      writeRow({ id: key, imdbId: resolved?.imdbId, status: 'missing' });
      return null;
    }
    writeRow({ id: key, imdbId: resolved.imdbId, youtubeId: resolved.youtubeId, title: item.seriesTitle || item.title, status: 'pending' });
    try {
      const { file, size } = await download(item, resolved.youtubeId);
      writeRow({
        id: key,
        imdbId: resolved.imdbId,
        youtubeId: resolved.youtubeId,
        title: item.seriesTitle || item.title,
        path: file,
        size,
        status: 'ready',
      });
      return file;
    } catch (err) {
      writeRow({
        id: key,
        imdbId: resolved.imdbId,
        youtubeId: resolved.youtubeId,
        title: item.seriesTitle || item.title,
        status: 'failed',
        error: err?.message || String(err),
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
  if (ready) return { ...ready, status: 'ready' };
  const key = trailerKey(item);
  const row = rowFor(key);
  if (!row) return { status: queued.has(key) ? 'pending' : 'none' };
  return { status: row.status, youtubeId: row.youtube_id, error: row.error };
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
