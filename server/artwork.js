/**
 * Official artwork cache.
 *
 * Library folders usually have no sidecar poster/fanart, so a card would fall
 * back to a frame sampled from the video. This module asks Cinemeta for the
 * title's own poster, backdrop, and logo wordmark, downloads them once into
 * `<library>/.cache/art`, and serves that file afterwards. Video frames are
 * only used when the internet is off and nothing was cached yet.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getItem } from './library.js';
import { resolveImdbId } from './imdb.js';
import { isOffline } from './settings.js';
import { getAsset, putAsset } from './db.js';
import { playbackActive } from './proc.js';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const FIELDS = { poster: 'poster', backdrop: 'background', logo: 'logo' };

let artDir = null;
const inflight = new Map();
const failures = new Map();
const FAIL_TTL = 10 * 60 * 1000;

export function initArtwork(cacheDir) {
  artDir = path.join(cacheDir, 'art');
  try {
    fs.mkdirSync(artDir, { recursive: true });
  } catch {
    artDir = null;
  }
}

function hashFor(id) {
  return crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 24);
}

function cacheFile(id, kind, ext) {
  return artDir ? path.join(artDir, `${hashFor(id)}-${kind}.${ext || (kind === 'logo' ? 'png' : 'jpg')}`) : null;
}

function mimeForExt(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/* A logo is a transparent wordmark, usually PNG; the extension decides the
 * content type the route sends back, so remember what was actually stored. */
function imageExt(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/* Cached artwork as { buffer, mime, etag } (or { path } for anything that was
 * too large for the database). Files written by older builds are imported once
 * into catalog.db instead of being re-downloaded. */
function existing(id, kind) {
  const row = getAsset(id, kind);
  if (row?.blob && row.blob.length > 1024) {
    return { buffer: Buffer.from(row.blob), mime: row.mime || 'image/jpeg', etag: row.etag };
  }
  if (row?.path) {
    try {
      if (fs.statSync(row.path).size > 1024) {
        return { path: row.path, mime: row.mime || 'image/jpeg', etag: row.etag };
      }
    } catch {
      /* file removed; look on disk again */
    }
  }
  const exts = kind === 'logo' ? ['png', 'jpg', 'webp'] : ['jpg'];
  for (const ext of exts) {
    const file = cacheFile(id, kind, ext);
    if (!file) break;
    try {
      if (fs.statSync(file).size <= 1024) continue;
      const buffer = fs.readFileSync(file);
      const saved = putAsset({ id, kind, mime: mimeForExt(ext), buffer, path: file });
      return { buffer, mime: mimeForExt(ext), etag: saved?.etag };
    } catch {
      /* not cached yet */
    }
  }
  return null;
}

async function resolveUrl(item, kind) {
  const imdbId = await resolveImdbId(item);
  if (!imdbId) return null;
  const type = item.isSeries ? 'series' : 'movie';
  const res = await fetch(`${CINEMETA}/meta/${type}/${encodeURIComponent(imdbId)}.json`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.meta || {};
  // A logo has no substitute: a poster stretched into the title slot looks
  // like a broken image, so the frontend keeps its text title instead.
  if (kind === 'logo') return String(meta.logo || '') || null;
  return String(meta[FIELDS[kind]] || meta.poster || meta.background || '') || null;
}

/* Returns a local JPEG path for the official artwork, or null when the lookup
 * is not possible (offline, unknown title) or still running. */
export async function officialArt(item, kind) {
  if (!item || !artDir) return null;
  // One copy per series, not per episode: the catalog art is the same image.
  const artId = item.seriesKey || item.id;
  const key = `${artId}:${kind}`;
  const cached = existing(artId, kind);
  if (cached) return cached;
  const attempt = inflight.get(key);
  if (attempt) return attempt;
  if (isOffline()) return null;
  const failedAt = failures.get(key);
  if (failedAt && Date.now() - failedAt < FAIL_TTL) return null;

  const task = (async () => {
    try {
      const url = await resolveUrl(item, kind);
      if (!url) {
        failures.set(key, Date.now());
        return null;
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        failures.set(key, Date.now());
        return null;
      }
      const type = String(res.headers.get('content-type') || '');
      if (type && !type.startsWith('image/')) {
        failures.set(key, Date.now());
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 1024) {
        failures.set(key, Date.now());
        return null;
      }
      const ext = imageExt(buffer) || (kind === 'logo' ? 'png' : 'jpg');
      const mime = mimeForExt(ext);
      const saved = putAsset({ id: artId, kind, mime, buffer });
      failures.delete(key);
      return { buffer, mime, etag: saved?.etag };
    } catch {
      failures.set(key, Date.now());
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/* File already on disk, without starting a download. */
export function cachedArt(id, kind) {
  return existing(id, kind);
}

/* Move artwork an older build left in `.cache/art` into catalog.db, so the
 * first card render does not pay for the import. Runs after each scan. */
export function warmArtwork(items) {
  const ids = new Set();
  for (const item of items || []) {
    const id = item.seriesKey || item.id;
    if (id) ids.add(id);
  }
  for (const id of ids) {
    if (playbackActive()) return;
    existing(id, 'poster');
    existing(id, 'backdrop');
    existing(id, 'logo');
  }
}