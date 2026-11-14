/**
 * Picture cache: one good-looking still per title, stored in its own SQLite
 * database (`<library>\.cache\pictures.db`) with the JPEG next to it.
 *
 * Picking the frame matters. A single seek at a fixed point can land on a
 * black frame, a fade, or a title card — that is how a card ends up showing
 * the film's own title text. So several moments are sampled, each is scored by
 * edge density (scenes are busy, title cards and black frames are nearly
 * empty), and the best one is rendered.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { getDb } from './db.js';

const SAMPLES = 8;
const SAMPLE_FROM = 0.12;
const SAMPLE_TO = 0.82;

let db = null;
let pictureDir = null;

const jobs = [];
const pending = new Map();
const MAX_JOBS = 2;
let active = 0;

function hashFor(id) {
  return crypto.createHash('sha1').update(id).digest('hex');
}

export function initPictures(cacheDir) {
  pictureDir = path.join(cacheDir, 'pictures');
  fs.mkdirSync(pictureDir, { recursive: true });
  db = getDb();
  if (!db) return;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS picture (
      key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      width INTEGER NOT NULL,
      source_size INTEGER NOT NULL,
      source_mtime INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      seek_sec REAL NOT NULL,
      score REAL NOT NULL,
      built_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS picture_id ON picture(id)');
  } catch (err) {
    db = null;
    console.warn('picture cache disabled:', err?.message || String(err));
  }
}

function rowFor(key) {
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM picture WHERE key = ?').get(key) || null;
  } catch {
    return null;
  }
}

function saveRow(key, id, width, item, file, seek, score) {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO picture (key, id, width, source_size, source_mtime, file_path, seek_sec, score, built_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        source_size = excluded.source_size,
        source_mtime = excluded.source_mtime,
        file_path = excluded.file_path,
        seek_sec = excluded.seek_sec,
        score = excluded.score,
        built_at = excluded.built_at`)
      .run(key, id, width, Number(item.size) || 0, Number(item.mtime) || 0, file, seek, score, Date.now());
  } catch {
    /* index is best effort */
  }
}

function fresh(item, key) {
  const row = rowFor(key);
  if (!row) return null;
  if (Number(row.source_size) !== Number(item.size) || Number(row.source_mtime) !== Number(item.mtime)) return null;
  try {
    if (fs.statSync(row.file_path).size > 1000) {
      return { path: row.file_path, seekSec: Number(row.seek_sec), score: Number(row.score) };
    }
  } catch {
    /* file removed; rebuild */
  }
  return null;
}

function run(bin, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error(stderr?.trim() || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

/* Spread candidate moments across the middle of the film, away from the
 * opening title cards and the closing credits. */
function sampleTimes(item) {
  const duration = Number(item.durationSec) || 0;
  if (!Number.isFinite(duration) || duration < 20) return [1];
  if (duration < 120) return [duration * 0.3, duration * 0.5, duration * 0.7];
  const times = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = duration * (SAMPLE_FROM + ((SAMPLE_TO - SAMPLE_FROM) * i) / (SAMPLES - 1));
    times.push(Math.max(1, Math.min(t, duration - 5)));
  }
  return times;
}

/* Edge density of one frame, 0..~255. Scenes score high, title cards and black
 * frames score low. Metadata is printed to a temp file by ffmpeg itself. */
async function scoreFrame(full, seek) {
  const tmp = path.join(pictureDir, `score-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', full,
      '-frames:v', '1',
      '-vf', `scale=240:-2,format=gray,edgedetect=low=0.08:high=0.22,signalstats,metadata=print:file=${tmp}`,
      '-f', 'null', 'NUL',
    ], 45000);
    const text = await fsp.readFile(tmp, 'utf8').catch(() => '');
    const values = [...text.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    if (!values.length) return 0;
    return values[values.length - 1];
  } catch {
    return 0;
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/* Reuse the detected frame edges so a letterboxed transfer is not cut off. */
async function detectCrop(full, seek, item) {
  try {
    const { stderr } = await run(ffmpegPath, [
      '-hide_banner', '-ss', String(seek), '-i', full,
      '-frames:v', '1', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', 'NUL',
    ], 30000);
    const matches = [...(stderr || '').matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1];
    const w = Number(last[1]);
    const h = Number(last[2]);
    if (w < 120 || h < 90) return null;
    if (item.width && item.height && w * h >= item.width * item.height * 0.985) return null;
    return { w, h, x: Number(last[3]), y: Number(last[4]) };
  } catch {
    return null;
  }
}

async function build(item, full, width) {
  const key = `${item.id}#${width}`;
  let best = null;
  for (const seek of sampleTimes(item)) {
    const score = await scoreFrame(full, seek);
    if (!best || score > best.score) best = { seek, score };
  }
  if (!best) throw new Error('no frame could be sampled');

  const height = Math.round((width * 9) / 16);
  const crop = await detectCrop(full, best.seek, item);
  const cropFilter = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  const filter = `${cropFilter}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const file = path.join(pictureDir, `${hashFor(item.id)}-${width}.jpg`);
  const quality = width >= 1280 ? '3' : '4';

  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(best.seek), '-i', full,
    '-frames:v', '1', '-vf', filter, '-q:v', quality, '-y', file,
  ], 45000);

  saveRow(key, item.id, width, item, file, best.seek, best.score);
  return { path: file, seekSec: best.seek, score: best.score };
}

function pump() {
  while (active < MAX_JOBS && jobs.length) {
    const job = jobs.shift();
    active += 1;
    build(job.item, job.full, job.width)
      .then(job.resolve)
      .catch((err) => {
        console.warn(`picture build failed for ${job.item.fileName}: ${err?.message || String(err)}`);
        job.resolve(null);
      })
      .finally(() => {
        active -= 1;
        pending.delete(job.key);
        pump();
      });
  }
}

/* Cached still for one title at one width; builds it when missing. */
export function ensurePicture(item, full, width = 1280) {
  const key = `${item.id}#${width}`;
  const cached = fresh(item, key);
  if (cached) return Promise.resolve(cached.path);
  if (pending.has(key)) return pending.get(key);
  const promise = new Promise((resolve) => {
    jobs.push({ key, item, full, width, resolve: (result) => resolve(result?.path || null) });
    pump();
  });
  pending.set(key, promise);
  return promise;
}

export function pictureStats() {
  if (!db) return { count: 0 };
  try {
    return { count: db.prepare('SELECT COUNT(*) AS n FROM picture').get().n };
  } catch {
    return { count: 0 };
  }
}