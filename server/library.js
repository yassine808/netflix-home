import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { initPictures, ensurePicture } from './pictures.js';
import { getDb, transaction } from './db.js';

const ffprobePath = ffprobeStatic.path;

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.divx',
]);

const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'recycler', 'node_modules',
  '.git', '.cache', 'lost+found', 'windows', 'program files',
  'program files (x86)', 'programdata', 'recovery', 'temp',
  'public', 'server', 'app',
]);

const QUALITY_TAGS = /\b(2160p|1080p|720p|480p|360p|4k|uhd|hdr10?|dv|dolby\s?vision|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvdscr|hdrip|cam|ts|tc|remux|x264|x265|h264|h265|hevc|avc|10bit|8bit|aac\d?|ac3|eac3|dts(-hd)?|truehd|atmos|5\.1|7\.1|2\.0|proper|repack|extended|unrated|directors?\.?cut|imax|internal|multi|dual|subbed|dubbed)\b/gi;

let cacheDir;
let itemsById = new Map();
let library = { root: '', items: [], collections: [], updatedAt: 0 };
let scanning = null;

export function idFor(relPath) {
  return Buffer.from(relPath, 'utf8').toString('base64url');
}

function relFromId(id) {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function execFileP(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 32 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function titleCase(s) {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return s.toLowerCase().replace(/\b\w[\w'’]*/g, (word, offset) => {
    if (offset > 0 && small.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

const EPISODE_PATTERNS = [
  /\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i,
  /\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
];

export function parseFileName(fileName) {
  let base = fileName.replace(/\.[^.]+$/, '');

  let season = null;
  let episode = null;
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(base);
    if (!match) continue;
    const nextSeason = Number(match[1]);
    const nextEpisode = Number(match[2]);
    if (!(nextSeason > 0 && nextSeason < 100) || !(nextEpisode > 0 && nextEpisode < 1000)) continue;
    season = nextSeason;
    episode = nextEpisode;
    base = `${base.slice(0, match.index)} ${base.slice(match.index + match[0].length)}`;
    break;
  }

  let year = null;
  const yearMatch = base.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    base = `${base.slice(0, yearMatch.index)} ${base.slice(yearMatch.index + yearMatch[0].length)}`;
  }

  base = base.replace(/[[({][^\])}]*[\])}]/g, ' ');
  base = base.replace(/[._]+/g, ' ');

  const cut = base.search(QUALITY_TAGS);
  if (cut > 0) base = base.slice(0, cut);

  base = base.replace(/\s+/g, ' ').trim();
  let title = titleCase(base) || titleCase(fileName.replace(/\.[^.]+$/, ''));
  title = title.replace(/^[-–—\s]+|[-–—\s]+$/g, '');

  return { title, year, season, episode };
}

function readNfo(filePath) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const candidates = [`${stem}.nfo`, 'movie.nfo'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    try {
      const xml = fs.readFileSync(p, 'utf8');
      const grab = (tag) => {
        const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
        return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
      };
      const genres = [...xml.matchAll(/<genre[^>]*>([\s\S]*?)<\/genre>/gi)]
        .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
        .filter(Boolean);
      const plot = grab('plot') || grab('outline') || grab('tagline');
      if (!plot && !grab('title') && !genres.length) continue;
      return {
        title: grab('title'),
        year: Number(grab('year')) || null,
        plot,
        genres,
        rating: grab('mpaa') || grab('certification'),
        tmdbId: grab('tmdbid') || grab('imdbid'),
      };
    } catch {
      /* no nfo here */
    }
  }
  return null;
}

function findArtwork(filePath, kind) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const names = kind === 'poster'
    ? [`${stem}-poster.jpg`, `${stem}-poster.png`, 'poster.jpg', 'poster.png', 'folder.jpg', 'cover.jpg']
    : [`${stem}-fanart.jpg`, `${stem}-fanart.png`, `${stem}-backdrop.jpg`, 'fanart.jpg', 'backdrop.jpg', 'background.jpg'];
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/* Directory index. A launch reads each folder's listing (one readdir, no file
 * access) and trusts the saved sizes/mtimes for names that are still there, so
 * an untouched library costs no stat and no ffprobe per video. Directory mtimes
 * are only a hint because NTFS updates them lazily. */
function loadDirIndex() {
  const map = new Map();
  const db = getDb();
  if (!db) return map;
  try {
    for (const row of db.prepare('SELECT rel_path, mtime, entries FROM dirs').all()) {
      try {
        map.set(row.rel_path, {
          mtime: Number(row.mtime),
          raw: String(row.entries),
          entries: JSON.parse(row.entries),
        });
      } catch {
        /* damaged row: the directory will be read again */
      }
    }
  } catch {
    /* no index yet: full read */
  }
  return map;
}

async function walkIndexed(root) {
  const index = loadDirIndex();
  const files = [];
  const dirRows = [];
  const seen = new Set();
  let reusedDirs = 0;
  let changedDirs = 0;

  async function visit(rel, depth) {
    const full = rel ? path.join(root, rel) : root;
    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    seen.add(rel);
    const mtime = Math.round(st.mtimeMs);
    const hit = index.get(rel);
    // NTFS writes a directory's mtime lazily, so it cannot be trusted on its
    // own. The listing always comes from readdir; the index only supplies the
    // sizes and mtimes of files whose names are still there.
    const sameMtime = Boolean(hit) && hit.mtime === mtime;
    const cachedByName = new Map();
    if (hit) for (const entry of hit.entries) cachedByName.set(entry.n, entry);

    let entries;
    try {
      entries = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      return;
    }

    const rows = [];

    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (depth > 8) continue;
        if (SKIP_DIRS.has(name.toLowerCase())) continue;
        if (name.startsWith('.') || name.startsWith('$')) continue;
        rows.push({ n: name, d: 1 });
        await visit(rel ? path.join(rel, name) : name, depth + 1);
        continue;
      }
      if (!entry.isFile() || !VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue;

      const known = sameMtime ? cachedByName.get(name) : null;
      if (known && !known.d) {
        rows.push(known);
        files.push({
          rel: rel ? path.join(rel, name) : name,
          full: path.join(full, name),
          size: Number(known.s) || 0,
          mtime: Number(known.m) || 0,
        });
        continue;
      }

      let fst;
      try {
        fst = await fsp.stat(path.join(full, name));
      } catch {
        continue;
      }
      const size = fst.size;
      const fileMtime = Math.round(fst.mtimeMs);
      rows.push({ n: name, d: 0, s: size, m: fileMtime });
      files.push({ rel: rel ? path.join(rel, name) : name, full: path.join(full, name), size, mtime: fileMtime });
    }

    rows.sort((a, b) => a.n.localeCompare(b.n));
    const raw = JSON.stringify(rows);
    if (hit && hit.raw === raw && sameMtime) {
      reusedDirs++;
      return;
    }
    changedDirs++;
    dirRows.push({ rel, mtime, entries: raw });
  }

  await visit('', 0);
  return { files, dirRows, seen, known: new Set(index.keys()), reusedDirs, changedDirs };
}

async function probe(filePath) {
  try {
    const raw = await execFileP(ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ]);
    const data = JSON.parse(raw);
    const video = (data.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
    return {
      durationSec: Number(data.format?.duration) || 0,
      width: Number(video?.width) || 0,
      height: Number(video?.height) || 0,
      videoCodec: video?.codec_name || null,
      audioCodec: audio?.codec_name || null,
      bitrate: Number(data.format?.bit_rate) || 0,
    };
  } catch {
    return { durationSec: 0, width: 0, height: 0, videoCodec: null, audioCodec: null, bitrate: 0 };
  }
}

/* Rows already in catalog.db: reused when size + mtime still match, which
 * avoids both ffprobe and re-reading NFO files on every scan. */
function storedRows() {
  const map = new Map();
  const db = getDb();
  if (!db) return map;
  try {
    for (const row of db.prepare('SELECT rel_path, size, mtime, payload FROM items').all()) {
      map.set(row.rel_path, row);
    }
  } catch {
    /* an empty or broken table just means a full scan */
  }
  return map;
}

/* meta.json was the old probe cache. Read it once on upgrade so the first
 * scan after this change does not re-probe every file. */
function legacyProbeCache() {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

function collectionsFor(items) {
  const map = new Map();
  for (const item of items) {
    const list = map.get(item.collection) || [];
    list.push(item);
    map.set(item.collection, list);
  }
  return [...map.entries()]
    .map(([name, list]) => ({
      name,
      count: list.length,
      items: list.sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title)).map((i) => i.id),
    }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

export async function scanLibrary(root) {
  if (scanning) return scanning;
  scanning = (async () => {
    const started = Date.now();
    const { files, dirRows, seen, known, reusedDirs, changedDirs } = await walkIndexed(root);

    const stored = storedRows();
    const legacy = stored.size ? {} : legacyProbeCache();
    const entries = [];
    const jobs = [];
    const keep = new Set();

    for (const file of files) {
      const rel = file.rel;
      keep.add(rel);
      const size = file.size;
      const mtime = file.mtime;
      const row = stored.get(rel);
      if (row && Number(row.size) === size && Number(row.mtime) === mtime) {
        try {
          entries.push({ rel, item: JSON.parse(row.payload) });
          continue;
        } catch {
          /* payload damaged; rebuild below */
        }
      }
      const cached = legacy[rel];
      const probed = cached && cached.size === size && Math.round(cached.mtimeMs) === mtime ? cached : null;
      const entry = { rel, filePath: file.full, size, mtime, probed };
      entries.push(entry);
      if (!probed) jobs.push(entry);
    }

    const concurrency = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        job.probed = await probe(job.filePath);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

    const nextItems = [];
    const dirty = [];

    for (const entry of entries) {
      if (entry.item) {
        nextItems.push(entry.item);
        continue;
      }
      const { rel, filePath, size, mtime, probed } = entry;
      const parsed = parseFileName(path.basename(filePath));
      const nfo = readNfo(filePath) || {};
      const collection = rel.includes(path.sep) ? rel.split(path.sep)[0] : 'Movies';
      const isSeries = parsed.season != null && parsed.episode != null;
      const seriesTitle = isSeries ? parsed.title : null;
      const episodeLabel = isSeries
        ? `S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`
        : null;
      const title = isSeries ? seriesTitle : (nfo.title || parsed.title);
      const item = {
        id: idFor(rel),
        relPath: rel,
        fileName: path.basename(filePath),
        title,
        displayTitle: isSeries ? `${seriesTitle} · ${episodeLabel}` : title,
        isSeries,
        seriesTitle,
        seriesKey: isSeries ? idFor(seriesTitle.toLowerCase()) : null,
        season: isSeries ? parsed.season : null,
        episode: isSeries ? parsed.episode : null,
        episodeLabel,
        year: nfo.year || parsed.year,
        plot: nfo.plot || null,
        genres: nfo.genres?.length ? nfo.genres : [],
        rating: nfo.rating || null,
        posterPath: findArtwork(filePath, 'poster'),
        backdropPath: findArtwork(filePath, 'backdrop'),
        collection,
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        videoCodec: probed.videoCodec,
        audioCodec: probed.audioCodec,
        size,
        mtime,
      };
      nextItems.push(item);
      dirty.push(item);
    }

    nextItems.sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title));

    const db = getDb();
    const removed = [];
    for (const rel of stored.keys()) {
      if (!keep.has(rel)) removed.push(rel);
    }
    const changed = dirty.length > 0 || removed.length > 0 || dirRows.length > 0;
    if (db) {
      try {
        transaction(() => {
          const remove = db.prepare('DELETE FROM items WHERE rel_path = ?');
          for (const rel of removed) remove.run(rel);
          const upsert = db.prepare(`INSERT INTO items
            (id, rel_path, series_key, collection, size, mtime, payload, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              rel_path = excluded.rel_path,
              series_key = excluded.series_key,
              collection = excluded.collection,
              size = excluded.size,
              mtime = excluded.mtime,
              payload = excluded.payload,
              updated_at = excluded.updated_at`);
          const now = Date.now();
          for (const item of dirty) {
            upsert.run(item.id, item.relPath, item.seriesKey, item.collection,
              item.size, item.mtime, JSON.stringify(item), now);
          }

          if (dirRows.length) {
            const putDir = db.prepare(`INSERT INTO dirs (rel_path, mtime, entries, scanned_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(rel_path) DO UPDATE SET
                mtime = excluded.mtime,
                entries = excluded.entries,
                scanned_at = excluded.scanned_at`);
            for (const row of dirRows) putDir.run(row.rel, row.mtime, row.entries, now);
          }
          const dropDir = db.prepare('DELETE FROM dirs WHERE rel_path = ?');
          for (const rel of known) {
            if (!seen.has(rel)) dropDir.run(rel);
          }

          db.prepare(`INSERT INTO scan_state (root, root_mtime, item_count, last_scan, last_ms)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(root) DO UPDATE SET
              root_mtime = excluded.root_mtime,
              item_count = excluded.item_count,
              last_scan = excluded.last_scan,
              last_ms = excluded.last_ms`)
            .run(root, Math.round(Date.now() / 1000), nextItems.length, now, Date.now() - started);
        });
      } catch (err) {
        console.warn('catalog write failed:', err?.message || String(err));
      }
    }

    itemsById = new Map(nextItems.map((i) => [i.id, i]));
    const scanStats = {
      ms: Date.now() - started,
      files: files.length,
      dirs: seen.size,
      reusedDirs,
      readDirs: changedDirs,
      probed: jobs.length,
      changed,
    };
    library = {
      root,
      items: nextItems,
      collections: collectionsFor(nextItems),
      // An unchanged scan keeps the old timestamp, so the library ETag stays
      // stable and the browser answers from its cache instead of re-downloading.
      updatedAt: changed || !library.updatedAt ? Date.now() : library.updatedAt,
      scannedInMs: scanStats.ms,
      scan: scanStats,
    };

    return library;
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

export function isScanning() {
  return Boolean(scanning);
}

export function getLibrary() {
  return library;
}

export function getItem(id) {
  return itemsById.get(id) || null;
}

export function resolveItemFile(id) {
  const item = getItem(id);
  if (!item) return null;
  const rel = relFromId(id);
  if (!rel) return null;
  const root = library.root;
  const full = path.resolve(root, rel);
  if (!full.toLowerCase().startsWith(path.resolve(root).toLowerCase())) return null;
  return { item, full };
}

/* ---------- thumbnails ---------- */

/* Frame picking, the picture database (pictures.db) and the JPEG files all
 * live in pictures.js so a title's card image is chosen once and reused. */
export function ensureThumb(item, full, width = 1280) {
  return ensurePicture(item, full, width);
}

export function artPath(kind, id) {
  const item = getItem(id);
  if (!item) return null;
  return kind === 'poster' ? item.posterPath : item.backdropPath;
}

/* Last known library straight from catalog.db, so the first paint does not
 * wait for the folder walk. The normal scan still runs and replaces it. */
export function loadCachedLibrary() {
  const db = getDb();
  if (!db) return false;
  try {
    const rows = db.prepare('SELECT payload, updated_at FROM items ORDER BY mtime DESC').all();
    if (!rows.length) return false;
    const items = [];
    let updatedAt = 0;
    for (const row of rows) {
      try {
        items.push(JSON.parse(row.payload));
        updatedAt = Math.max(updatedAt, Number(row.updated_at) || 0);
      } catch {
        /* skip a damaged row; the scan rewrites it */
      }
    }
    if (!items.length) return false;
    itemsById = new Map(items.map((i) => [i.id, i]));
    library = {
      root: library.root,
      items,
      collections: collectionsFor(items),
      updatedAt,
      scannedInMs: 0,
      cached: true,
    };
    return true;
  } catch {
    return false;
  }
}

export function initCache(dir) {
  cacheDir = dir;
  fs.mkdirSync(path.join(cacheDir, 'thumbs'), { recursive: true });
  initPictures(cacheDir);
  loadCachedLibrary();
}

export const VIDEO_EXTENSIONS = [...VIDEO_EXTS];
