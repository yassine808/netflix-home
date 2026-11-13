import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const ffprobePath = ffprobeStatic.path;

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.divx',
]);

const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'recycler', 'node_modules',
  '.git', '.cache', 'lost+found', 'windows', 'program files',
  'program files (x86)', 'programdata', 'recovery', 'temp',
]);

const QUALITY_TAGS = /\b(2160p|1080p|720p|480p|360p|4k|uhd|hdr10?|dv|dolby\s?vision|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvdscr|hdrip|cam|ts|tc|remux|x264|x265|h264|h265|hevc|avc|10bit|8bit|aac\d?|ac3|eac3|dts(-hd)?|truehd|atmos|5\.1|7\.1|2\.0|proper|repack|extended|unrated|directors?\.?cut|imax|internal|multi|dual|subbed|dubbed)\b/gi;

let cacheDir;
let metaCache = {};
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

function execCapture(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, err });
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

export function parseFileName(fileName) {
  let base = fileName.replace(/\.[^.]+$/, '');

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

  return { title, year };
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

async function walk(dir, depth, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 8) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      await walk(full, depth + 1, out);
    } else if (entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
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

function safeJsonRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

async function saveMetaCache() {
  try {
    await fsp.writeFile(path.join(cacheDir, 'meta.json'), JSON.stringify(metaCache));
  } catch {
    /* cache is best effort */
  }
}

export async function scanLibrary(root) {
  if (scanning) return scanning;
  scanning = (async () => {
    const started = Date.now();
    const files = [];
    await walk(root, 0, files);

    const nextCache = {};
    const fresh = [];

    for (const filePath of files) {
      const rel = path.relative(root, filePath);
      let st;
      try {
        st = await fsp.stat(filePath);
      } catch {
        continue;
      }
      const prev = metaCache[rel];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        nextCache[rel] = prev;
      } else {
        fresh.push({ filePath, rel, st });
      }
    }

    const concurrency = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < fresh.length) {
        const job = fresh[cursor++];
        const probed = await probe(job.filePath);
        nextCache[job.rel] = { size: job.st.size, mtimeMs: job.st.mtimeMs, ...probed };
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, fresh.length) }, worker));
    metaCache = nextCache;

    const nextItems = [];
    const collectionsMap = new Map();

    for (const filePath of files) {
      const rel = path.relative(root, filePath);
      const meta = metaCache[rel];
      if (!meta) continue;
      const parsed = parseFileName(path.basename(filePath));
      const nfo = readNfo(filePath) || {};
      const item = {
        id: idFor(rel),
        relPath: rel,
        fileName: path.basename(filePath),
        title: nfo.title || parsed.title,
        year: nfo.year || parsed.year,
        plot: nfo.plot || null,
        genres: nfo.genres?.length ? nfo.genres : [],
        rating: nfo.rating || null,
        posterPath: findArtwork(filePath, 'poster'),
        backdropPath: findArtwork(filePath, 'backdrop'),
        collection: null,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        videoCodec: meta.videoCodec,
        audioCodec: meta.audioCodec,
        size: meta.size,
        mtime: Math.round(meta.mtimeMs),
      };
      item.collection = rel.includes(path.sep) ? rel.split(path.sep)[0] : 'Movies';
      nextItems.push(item);

      const list = collectionsMap.get(item.collection) || [];
      list.push(item);
      collectionsMap.set(item.collection, list);
    }

    nextItems.sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title));

    const collections = [...collectionsMap.entries()]
      .map(([name, list]) => ({
        name,
        count: list.length,
        items: list.sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title)).map((i) => i.id),
      }))
      .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));

    itemsById = new Map(nextItems.map((i) => [i.id, i]));
    library = {
      root,
      items: nextItems,
      collections,
      updatedAt: Date.now(),
      scannedInMs: Date.now() - started,
    };

    await saveMetaCache();
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

const thumbJobs = [];
let activeThumbs = 0;
const THUMB_CONCURRENCY = 2;

function thumbPathFor(id) {
  const hash = crypto.createHash('sha1').update(id).digest('hex');
  return path.join(cacheDir, 'thumbs', `${hash}.jpg`);
}

async function detectCrop(full, seek, item) {
  const { stderr } = await execCapture(ffmpegPath, [
    '-hide_banner', '-ss', String(seek), '-i', full,
    '-frames:v', '1', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-',
  ], 30000);
  const matches = [...(stderr || '').matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const w = Number(last[1]);
  const h = Number(last[2]);
  const x = Number(last[3]);
  const y = Number(last[4]);
  if (w < 120 || h < 90) return null;
  if (item.width && item.height && w * h >= item.width * item.height * 0.985) return null;
  return { w, h, x, y };
}

async function generateThumb(item, full, out) {
  const seek = Math.max(1, Math.min((item.durationSec || 60) * 0.22, 600));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const crop = await detectCrop(full, seek, item);
  const cropFilter = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  const filter = `${cropFilter}scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720`;
  try {
    await execFileP(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', full,
      '-frames:v', '1', '-vf', filter, '-q:v', '3', '-y', out,
    ], 45000);
  } catch {
    try {
      await execFileP(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', full,
        '-frames:v', '1', '-vf', filter, '-q:v', '3', '-y', out,
      ], 45000);
    } catch {
      return false;
    }
  }
  return true;
}

function pumpThumbs() {
  while (activeThumbs < THUMB_CONCURRENCY && thumbJobs.length) {
    const job = thumbJobs.shift();
    activeThumbs++;
    generateThumb(job.item, job.full, job.out)
      .then(job.resolve)
      .catch(() => job.resolve(false))
      .finally(() => {
        activeThumbs--;
        pumpThumbs();
      });
  }
}

export function ensureThumb(item, full) {
  const out = thumbPathFor(item.id);
  try {
    const st = fs.statSync(out);
    if (st.isFile() && st.size > 1000) return Promise.resolve(out);
  } catch {
    /* not generated yet */
  }
  return new Promise((resolve) => {
    thumbJobs.push({ item, full, out, resolve: (ok) => resolve(ok ? out : null) });
    pumpThumbs();
  });
}

export function artPath(kind, id) {
  const item = getItem(id);
  if (!item) return null;
  return kind === 'poster' ? item.posterPath : item.backdropPath;
}

export function initCache(dir) {
  cacheDir = dir;
  fs.mkdirSync(path.join(cacheDir, 'thumbs'), { recursive: true });
  metaCache = safeJsonRead(path.join(cacheDir, 'meta.json'));
}

export const VIDEO_EXTENSIONS = [...VIDEO_EXTS];
