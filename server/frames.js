import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const COLS = 10;
const TILE_W = 160;
const TILE_H = 90;
const MAX_FRAMES = 100;

let framesDir = null;
let active = 0;
const MAX_ACTIVE = 2;
const queue = [];
const inflight = new Map();

export function initFrames(cacheDir) {
  framesDir = path.join(cacheDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
}

function execFileP(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function frameCount(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MAX_FRAMES;
  if (durationSec < 200) return Math.max(10, Math.min(MAX_FRAMES, Math.floor(durationSec / 2)));
  return MAX_FRAMES;
}

function spritePathFor(item) {
  const hash = crypto.createHash('sha1')
    .update(`${item.id}:${item.mtime}:${Math.round(item.durationSec || 0)}`)
    .digest('hex');
  return path.join(framesDir, `${hash}.jpg`);
}

export function frameMeta(item) {
  const count = frameCount(item.durationSec);
  const rows = Math.max(1, Math.ceil(count / COLS));
  return {
    url: `/api/frames/${encodeURIComponent(item.id)}/sprite.jpg`,
    count,
    cols: COLS,
    rows,
    width: TILE_W,
    height: TILE_H,
    intervalSec: count > 0 && item.durationSec > 0 ? item.durationSec / count : 0,
    durationSec: item.durationSec || 0,
  };
}

export function spriteFile(item) {
  return spritePathFor(item);
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active += 1;
    generateSprite(job.item, job.full, job.out)
      .then(job.resolve)
      .catch(() => job.resolve(null))
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

async function generateSprite(item, full, out) {
  const duration = Number(item.durationSec) || 0;
  if (duration < 10) return null;
  const meta = frameMeta(item);
  const fps = meta.count / duration;
  const filter = [
    `fps=${fps.toFixed(6)}`,
    `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=increase`,
    `crop=${TILE_W}:${TILE_H}`,
    `tile=${meta.cols}x${meta.rows}`,
  ].join(',');
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await execFileP(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', full,
    '-vf', filter,
    '-frames:v', '1',
    '-q:v', '4',
    '-threads', '2',
    '-y', out,
  ], 180000);
  const st = await fsp.stat(out);
  return st.size > 1000 ? out : null;
}

export function ensureSprite(item, full) {
  const out = spritePathFor(item);
  try {
    const st = fs.statSync(out);
    if (st.isFile() && st.size > 1000) return Promise.resolve(out);
  } catch {
    /* not generated yet */
  }
  if (inflight.has(out)) return inflight.get(out);
  const promise = new Promise((resolve) => {
    queue.push({ item, full, out, resolve });
    pump();
  });
  inflight.set(out, promise);
  promise.then(() => inflight.delete(out), () => inflight.delete(out));
  return promise;
}
