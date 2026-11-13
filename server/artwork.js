/**
 * Official artwork cache.
 *
 * Library folders usually have no sidecar poster/fanart, so a card would fall
 * back to a frame sampled from the video. This module asks Cinemeta for the
 * title's own poster and backdrop, downloads them once into
 * `<library>/.cache/art`, and serves that file afterwards. Video frames are
 * only used when the internet is off and nothing was cached yet.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getItem } from './library.js';
import { resolveImdbId } from './imdb.js';
import { isOffline } from './settings.js';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const FIELDS = { poster: 'poster', backdrop: 'background' };

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

function cacheFile(id, kind) {
  return artDir ? path.join(artDir, `${hashFor(id)}-${kind}.jpg`) : null;
}

function existing(id, kind) {
  const file = cacheFile(id, kind);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size > 1024) return file;
  } catch {
    /* not cached yet */
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
      const file = cacheFile(artId, kind);
      await fsp.writeFile(file, buffer);
      failures.delete(key);
      return file;
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