import fs from 'node:fs';
import path from 'node:path';
import ffprobeStatic from 'ffprobe-static';
import { resolveImdbId } from './imdb.js';
import { isOffline } from './settings.js';
import { getDb } from './db.js';
import { run } from './proc.js';

const CHAPTER_INTRO = /\b(intro|opening|opening credits|main title|recap)\b/i;
const chapterCache = new Map();

/* IntroDB (https://api.introdb.app) is a free, keyless, community-run database
 * of intro timestamps. It returns real start/end times for a series episode,
 * which is what the player needs to offer "Skip Intro" at the right moment. */
const INTRODB_BASE = 'https://api.introdb.app';
const INTRODB_TIMEOUT = 8000;
const lookupCache = new Map();

let cacheFile = null;
let markers = {};

export function initIntro(cacheDir) {
  cacheFile = path.join(cacheDir, 'intro.json');
  const db = getDb();
  if (db) {
    try {
      const rows = db.prepare('SELECT key, start_sec, end_sec, source, updated_at FROM intro').all();
      if (rows.length) {
        markers = {};
        for (const row of rows) {
          markers[row.key] = {
            startSec: Number(row.start_sec),
            endSec: Number(row.end_sec),
            source: row.source || 'cache',
            updatedAt: Number(row.updated_at) || 0,
          };
        }
        return;
      }
      // First start after the upgrade: import the old JSON file once.
      const legacy = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        markers = legacy;
        const insert = db.prepare(`INSERT OR IGNORE INTO intro (key, start_sec, end_sec, source, updated_at)
          VALUES (?, ?, ?, ?, ?)`);
        for (const [key, value] of Object.entries(legacy)) {
          if (!Number.isFinite(Number(value?.startSec)) || !Number.isFinite(Number(value?.endSec))) continue;
          insert.run(key, Number(value.startSec), Number(value.endSec), value.source || 'cache', Number(value.updatedAt) || Date.now());
        }
        return;
      }
    } catch {
      /* fall through to the JSON file */
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    markers = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    markers = {};
  }
}

/* Intro timings differ per episode, so cache them per episode rather than per
 * series: S01E01 can open with a cold open while S01E02 starts on the intro. */
function keyFor(item) {
  if (item.isSeries && item.season && item.episode) {
    return `${item.seriesKey || item.id}#s${item.season}e${item.episode}`;
  }
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
  const promise = run(
    ffprobeStatic.path,
    ['-v', 'error', '-print_format', 'json', '-show_chapters', full],
    { timeout: 30000, maxBuffer: 1024 * 1024 * 4, lane: 'probe' },
  ).then((stdout) => {
    try {
      const data = JSON.parse(stdout);
      return Array.isArray(data.chapters) ? data.chapters : [];
    } catch {
      return [];
    }
  }).catch(() => []);
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

async function fromIntroDb(item) {
  if (!item.isSeries || isOffline()) return null;
  const season = Number(item.season) || 0;
  const episode = Number(item.episode) || 0;
  if (!season || !episode) return null;

  const imdbId = await resolveImdbId(item);
  if (!imdbId) return null;

  const key = `${imdbId}:${season}x${episode}`;
  if (lookupCache.has(key)) return lookupCache.get(key);

  const promise = (async () => {
    try {
      const url = `${INTRODB_BASE}/intro?imdb_id=${encodeURIComponent(imdbId)}&season=${season}&episode=${episode}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(INTRODB_TIMEOUT),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const value = normalize(Number(data.start_ms) / 1000, Number(data.end_ms) / 1000, item.durationSec);
      // A start at zero means the submitted window covers the whole opening,
      // cold open included. Offering that would skip content before the intro.
      if (!value || value.startSec < 3) return null;
      if (Number(data.confidence) < 0.5) return null;
      return value;
    } catch {
      return null;
    }
  })();

  lookupCache.set(key, promise);
  return promise;
}

export async function getIntroMarkers(item, full) {
  const sidecar = readSidecar(full);
  if (sidecar) return { ...sidecar, source: 'sidecar' };

  const saved = markers[keyFor(item)];
  if (saved) {
    const value = normalize(saved.startSec, saved.endSec, item.durationSec);
    if (value) return { ...value, source: saved.source || 'cache' };
  }

  const chapters = await fromChapters(item, full);
  if (chapters) return { ...chapters, source: 'chapters' };

  const detected = await fromIntroDb(item);
  if (detected) {
    // Keep it on disk so an offline play still gets the same window.
    saveIntroMarkers(item, detected.startSec, detected.endSec, 'introdb');
    return { ...detected, source: 'introdb' };
  }

  // No reliable window: show no button rather than skipping the cold open.
  return { startSec: null, endSec: null, source: null };
}

export function saveIntroMarkers(item, startSec, endSec, source = 'cache') {
  const value = normalize(startSec, endSec, item.durationSec);
  if (!value) return null;
  const key = keyFor(item);
  const saved = { ...value, source, updatedAt: Date.now() };
  markers[key] = saved;
  const db = getDb();
  if (db) {
    try {
      db.prepare(`INSERT INTO intro (key, start_sec, end_sec, source, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          start_sec = excluded.start_sec,
          end_sec = excluded.end_sec,
          source = excluded.source,
          updated_at = excluded.updated_at`)
        .run(key, saved.startSec, saved.endSec, source, saved.updatedAt);
      return { ...value, source };
    } catch {
      /* keep the in-memory value for this run */
    }
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(markers, null, 2));
  } catch {
    /* keep the in-memory value for this run */
  }
  return { ...value, source };
}
