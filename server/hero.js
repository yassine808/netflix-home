import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import ffmpegPath from 'ffmpeg-static';

/**
 * Hero cache: one still frame + one short preview clip per title, built once
 * with ffmpeg and indexed in SQLite. The home page then loads its backdrop and
 * its "intro" preview straight from disk instead of seeking a multi-GB file.
 */

const CLIP_SECONDS = 12;
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;

/* createRequire keeps this synchronous, so the cache is ready before the first
 * library scan. A plain dynamic import would need top-level await, which the
 * single-file bundle cannot use. */
let DatabaseSync = null;
try {
  const nodeRequire = createRequire(process.execPath);
  ({ DatabaseSync } = nodeRequire('node:sqlite'));
} catch {
  console.warn('node:sqlite is unavailable; hero previews will be generated on demand without a cache index');
}

let db = null;
let heroDir = null;
let enabled = true;

function exec(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });
}

function hashFor(id) {
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 20);
}

/* Same moment the player used to seek to, so the preview feels unchanged. */
export function heroStart(item) {
  const duration = Number(item.durationSec) || 0;
  if (duration < 90) return 20;
  return Math.min(Math.max(20, duration * 0.12), Math.max(20, duration - 80));
}

export function initHero(cacheDir) {
  heroDir = path.join(cacheDir, 'hero');
  try {
    fs.mkdirSync(heroDir, { recursive: true });
    if (!DatabaseSync) throw new Error('sqlite missing');
    db = new DatabaseSync(path.join(cacheDir, 'library.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS hero (
      id TEXT PRIMARY KEY,
      source_size INTEGER NOT NULL,
      source_mtime INTEGER NOT NULL,
      start_sec REAL NOT NULL,
      image_path TEXT NOT NULL,
      video_path TEXT NOT NULL,
      built_at INTEGER NOT NULL
    )`);
  } catch (err) {
    enabled = false;
    db = null;
    console.warn('hero cache disabled:', err?.message || String(err));
  }
}

function rowFor(id) {
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM hero WHERE id = ?').get(id) || null;
  } catch {
    return null;
  }
}

function readFresh(item) {
  const row = rowFor(item.id);
  if (!row) return null;
  if (Number(row.source_size) !== Number(item.size) || Number(row.source_mtime) !== Number(item.mtime)) return null;
  try {
    if (fs.statSync(row.image_path).size > 1000 && fs.statSync(row.video_path).size > 5000) {
      return {
        image: row.image_path,
        video: row.video_path,
        startSec: Number(row.start_sec),
        builtAt: Number(row.built_at),
      };
    }
  } catch {
    /* files were removed; rebuild */
  }
  return null;
}

function writeRow(item, start, image, video) {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO hero (id, source_size, source_mtime, start_sec, image_path, video_path, built_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_size = excluded.source_size,
        source_mtime = excluded.source_mtime,
        start_sec = excluded.start_sec,
        image_path = excluded.image_path,
        video_path = excluded.video_path,
        built_at = excluded.built_at`)
      .run(item.id, Number(item.size) || 0, Number(item.mtime) || 0, start, image, video, Date.now());
  } catch {
    /* index is best effort */
  }
}

async function build(item, full) {
  const hash = hashFor(item.id);
  const image = path.join(heroDir, `${hash}.jpg`);
  const video = path.join(heroDir, `${hash}.mp4`);
  const start = heroStart(item);
  const filter = `scale=${IMAGE_WIDTH}:${IMAGE_HEIGHT}:force_original_aspect_ratio=increase,crop=${IMAGE_WIDTH}:${IMAGE_HEIGHT}`;

  await exec(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', full,
    '-frames:v', '1', '-vf', filter, '-q:v', '3', '-y', image,
  ], 60000);

  try {
    await exec(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(CLIP_SECONDS), '-i', full,
      '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart', '-y', video,
    ], 180000);
  } catch {
    // Some files have no audio stream; a silent clip is still useful.
    await exec(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(CLIP_SECONDS), '-i', full,
      '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
      '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', '-y', video,
    ], 180000);
  }

  writeRow(item, start, image, video);
  return { image, video, startSec: start };
}

/* One limiter for both on-demand requests and the background warm-up, so a
 * hero request never waits behind a full library warm-up. */
const building = new Map();
const waiters = [];
const MAX_BUILDS = 2;
let activeBuilds = 0;

function acquire() {
  if (activeBuilds < MAX_BUILDS) {
    activeBuilds += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else activeBuilds -= 1;
}

function startBuild(item, full) {
  if (!enabled) return Promise.resolve(null);
  if (building.has(item.id)) return building.get(item.id);
  const task = (async () => {
    const cached = readFresh(item);
    if (cached) return cached;
    await acquire();
    try {
      return await build(item, full);
    } catch (err) {
      console.warn(`hero build failed for ${item.fileName}: ${err?.message || String(err)}`);
      return null;
    } finally {
      release();
    }
  })();
  building.set(item.id, task);
  task.finally(() => building.delete(item.id));
  return task;
}

/* Build one hero asset, waiting for it when the request needs it now. */
export function ensureHero(item, full) {
  return startBuild(item, full);
}

/* Background warm-up: one clip per title, lowest episode first. */
export function warmHeroes(items, root) {
  if (!enabled || !Array.isArray(items) || !root) return;
  const picks = new Map();
  for (const item of items) {
    if (!item || item.durationSec < 90) continue;
    const group = item.seriesKey || `item:${item.id}`;
    const previous = picks.get(group);
    if (!previous || (item.season || 0) < (previous.season || 0)
      || ((item.season || 0) === (previous.season || 0) && (item.episode || 0) < (previous.episode || 0))) {
      picks.set(group, item);
    }
  }
  for (const item of picks.values()) {
    if (readFresh(item)) continue;
    startBuild(item, path.resolve(root, item.relPath)).catch(() => {});
  }
}

export function heroReady(item) {
  return readFresh(item);
}
