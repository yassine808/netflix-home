import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import ffprobeStatic from 'ffprobe-static';

const CHAPTER_INTRO = /\b(intro|opening|opening credits|main title|recap)\b/i;
const chapterCache = new Map();

let cacheFile = null;
let markers = {};

export function initIntro(cacheDir) {
  cacheFile = path.join(cacheDir, 'intro.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    markers = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    markers = {};
  }
}

function keyFor(item) {
  return item.seriesKey || item.id;
}

function normalize(start, end, duration) {
  const startSec = Number(start);
  const endSec = Number(end);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
  if (startSec < 0 || endSec <= startSec + 2) return null;
  if (duration > 0 && endSec > duration + 1) return null;
  return { startSec: Math.round(startSec * 10) / 10, endSec: Math.round(endSec * 10) / 10 };
}

function readSidecar(full) {
  const dir = path.dirname(full);
  const stem = path.basename(full, path.extname(full));
  for (const name of [`${stem}.intro.json`, 'intro.json', 'movie.intro.json', 'series.intro.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const pair = data?.intro && typeof data.intro === 'object' ? data.intro : data;
      const value = normalize(pair?.startSec ?? pair?.start, pair?.endSec ?? pair?.end, 0);
      if (value) return value;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function probeChapters(item, full) {
  const key = `${item.id}:${item.mtime}`;
  if (chapterCache.has(key)) return chapterCache.get(key);
  const promise = new Promise((resolve) => {
    execFile(
      ffprobeStatic.path,
      ['-v', 'error', '-print_format', 'json', '-show_chapters', full],
      { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 * 4 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(stdout);
          resolve(Array.isArray(data.chapters) ? data.chapters : []);
        } catch {
          resolve([]);
        }
      },
    );
  });
  chapterCache.set(key, promise);
  return promise;
}

async function fromChapters(item, full) {
  const chapters = await probeChapters(item, full);
  for (const chapter of chapters) {
    const title = String(chapter?.tags?.title || chapter?.tags?.label || '');
    if (!CHAPTER_INTRO.test(title)) continue;
    const value = normalize(chapter.start_time, chapter.end_time, item.durationSec);
    if (value) return value;
  }
  return null;
}

function heuristic(item) {
  if (!item.isSeries) return null;
  const duration = Number(item.durationSec) || 0;
  if (duration < 300) return null;
  return { startSec: 0, endSec: Math.round(Math.min(90, duration * 0.1) * 10) / 10 };
}

export async function getIntroMarkers(item, full) {
  const sidecar = readSidecar(full);
  if (sidecar) return { ...sidecar, source: 'sidecar' };

  const saved = markers[keyFor(item)];
  if (saved) {
    const value = normalize(saved.startSec, saved.endSec, item.durationSec);
    if (value) return { ...value, source: 'cache' };
  }

  const chapters = await fromChapters(item, full);
  if (chapters) return { ...chapters, source: 'chapters' };

  const guess = heuristic(item);
  if (guess) return { ...guess, source: 'heuristic' };

  return { startSec: null, endSec: null, source: null };
}

export function saveIntroMarkers(item, startSec, endSec) {
  const value = normalize(startSec, endSec, item.durationSec);
  if (!value) return null;
  markers[keyFor(item)] = { ...value, updatedAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(markers, null, 2));
  } catch {
    /* keep the in-memory value for this run */
  }
  return { ...value, source: 'cache' };
}
