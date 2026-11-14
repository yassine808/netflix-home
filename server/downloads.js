import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { spawnNice } from './proc.js';
import { ensureEnglishSubtitle, vttFromSubtitle } from './subs.js';
import { findReleases, rankReleases, magnetFor, releaseLabel } from './torrentio.js';
import {
  fetchTorrentFiles, matchEpisodeFile, downloadTorrentFile,
  probeMedia, pickTracks, remuxToMp4, extractSubtitles,
} from './torrent.js';
const USER_AGENT = 'netflix-home/1.0 (local library downloader)';

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.divx',
]);

const jobs = new Map();
const queue = [];
let activeCount = 0;
/* No concurrency cap: every queued episode starts at once, each with its own
 * aria2c swarm. The user asked for the queue to be unlimited. */
const MAX_ACTIVE = Number.POSITIVE_INFINITY;
let libraryRoot = '';
let onComplete = async () => {};
/* Returns the library item that already has this file name, or null. Downloads
 * use it so a title that is already on disk is never copied a second time. */
let findExisting = () => null;

/* ---------- crash-safe queue ---------- */

/* The job list lives on disk so a server crash (Windows update, power cut, a
 * killed process), a restart, or the offline switch never loses a transfer.
 * aria2c resumes from its own .aria2 control file; ffmpeg cannot, so HLS and
 * remux partial files are rebuilt from the start. */
const STATE_NAME = 'downloads.json';
const SAVE_DELAY_MS = 3000;
const HISTORY_LIMIT = 40;
let stateFile = '';
let saveTimer = null;

export function initDownloads({ root, onDownloadComplete, findDownload = null }) {
  libraryRoot = root;
  onComplete = onDownloadComplete || (async () => {});
  findExisting = typeof findDownload === 'function' ? findDownload : () => null;
  stateFile = path.join(root, '.cache', STATE_NAME);
}

/* Terminal jobs are history, not work: keep the last few so the download
 * sheet still lists what finished, and drop the rest. */
function trimHistory() {
  const terminal = [...jobs.values()]
    .filter((job) => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
    .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
  for (const job of terminal.slice(HISTORY_LIMIT)) jobs.delete(job.id);
}

function snapshot() {
  trimHistory();
  const list = [];
  for (const job of jobs.values()) {
    const copy = {};
    for (const [key, value] of Object.entries(job)) {
      /* Runtime handles cannot be serialized; everything else is plain data. */
      if (key === 'controller' || key === 'ffmpeg') continue;
      copy[key] = value;
    }
    list.push(copy);
  }
  return { version: 1, savedAt: Date.now(), jobs: list };
}

let saveBusy = false;
let saveAgain = false;

async function writeStateOnce() {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    await fsp.mkdir(path.dirname(stateFile), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(snapshot()), 'utf8');
    await fsp.rename(tmp, stateFile);
  } catch (err) {
    console.warn(`[download] could not save the queue: ${err?.message || err}`);
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/* Saves are serialized: two overlapping writes racing on the same temp name
 * made the losing rename fail with ENOENT. */
async function saveState() {
  if (!stateFile) return;
  if (saveBusy) {
    saveAgain = true;
    return;
  }
  saveBusy = true;
  try {
    do {
      saveAgain = false;
      await writeStateOnce();
    } while (saveAgain);
  } finally {
    saveBusy = false;
  }
}

function saveStateSync() {
  if (!stateFile) return;
  const tmp = `${stateFile}.${process.pid}.exit.tmp`;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snapshot()), 'utf8');
    fs.renameSync(tmp, stateFile);
  } catch {
    /* the drive may already be gone during shutdown */
  }
}

/* Progress ticks call this once a second; coalescing keeps the disk quiet. */
function scheduleSave(delay = SAVE_DELAY_MS) {
  if (!stateFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, delay);
  saveTimer.unref?.();
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveStateSync();
}

process.once('exit', flushSave);

/* Ctrl+C / taskkill on the server should stop the children it owns. A hard
 * crash cannot run this, which is why orphan cleanup also exists. */
function stopChildren() {
  for (const job of jobs.values()) {
    try { job.controller?.abort(); } catch { /* already gone */ }
    const child = job.ffmpeg;
    if (!child?.pid) continue;
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* best effort */
    }
  }
  flushSave();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopChildren();
    process.exit(0);
  });
}

async function readState() {
  if (!stateFile) return null;
  try {
    const raw = await fsp.readFile(stateFile, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.jobs)) return null;
    return data;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[download] ignoring an unreadable queue file: ${err?.message || err}`);
    }
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    /* EPERM means the process exists but belongs to another user. */
    return err?.code === 'EPERM';
  }
}

function listChildProcesses() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = "Get-CimInstance Win32_Process -Filter \"Name='aria2c.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'\" "
    + '| Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        resolve(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
      } catch {
        resolve([]);
      }
    });
  });
}

function killPid(pid) {
  return new Promise((resolve) => {
    try {
      const child = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * A crashed server leaves aria2c/ffmpeg running (Windows does not take children
 * down with the parent). They keep writing into a queue nobody owns, so a
 * process whose parent is gone and whose command line points inside the library
 * is killed before the queue is restored.
 */
async function killOrphans() {
  if (process.platform !== 'win32' || !libraryRoot) return 0;
  const rows = await listChildProcesses();
  const needle = libraryRoot.toLowerCase();
  let killed = 0;
  for (const row of rows) {
    const pid = Number(row?.ProcessId) || 0;
    if (!pid || pid === process.pid) continue;
    const command = String(row?.CommandLine || '').toLowerCase();
    if (!command.includes(needle)) continue;
    const parent = Number(row?.ParentProcessId) || 0;
    if (parent && isPidAlive(parent)) continue;
    if (await killPid(pid)) killed++;
  }
  return killed;
}

/**
 * Temp folders belong to a job id. Anything else is a leftover from a job that
 * finished, failed or was deleted while the process was down; it is removed
 * unless another live app still has it open.
 */
async function sweepTorrentTempDirs() {
  if (!libraryRoot) return 0;
  const base = path.join(libraryRoot, '.cache', 'torrent');
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return 0;
  }
  const keep = new Set();
  for (const job of jobs.values()) {
    if (job.kind !== 'torrent') continue;
    if (job.status === 'queued' || job.status === 'paused' || job.status === 'downloading') {
      keep.add(job.id.toLowerCase());
    }
  }
  /* Another live instance (the deployed EXE and its dev server can share the
   * library) may own a temp folder. Its child processes name the folder in
   * their command line; those are never touched. */
  for (const row of await listChildProcesses()) {
    if (!isPidAlive(Number(row?.ParentProcessId) || 0)) continue;
    const command = String(row?.CommandLine || '');
    const dir = /[\\/]\.cache[\\/]torrent[\\/]([^\\/"\s]+)/i.exec(command);
    if (dir) keep.add(dir[1].toLowerCase());
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name.toLowerCase())) continue;
    const dir = path.join(base, entry.name);
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        done = true;
        removed++;
      } catch {
        /* an open handle from a live process: try again, then leave it */
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (!done) console.warn(`[download] could not remove the leftover temp folder ${entry.name}`);
  }
  return removed;
}

/**
 * A finished job's file name is frozen at completion. If the file was renamed
 * on disk - by hand, or by a build that mislabelled the quality - the Finished
 * list would keep pointing at a file that does not exist. Adopt the one sibling
 * MP4 with the same title/episode stem so the drawer matches the library.
 */
async function adoptRenamedFile(job) {
  if (!job.dest) return false;
  const dir = path.dirname(job.dest);
  const base = path.basename(job.dest);
  const stem = (name) => name
    .replace(/\.mp4$/i, '')
    .replace(/\s+(?:2160p|1080p|720p|480p|sd)(?:\s+\(\d+\))?$/i, '');
  const key = stem(base);

  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return false;
  }
  const matches = names.filter((name) => /\.mp4$/i.test(name) && name !== base && stem(name) === key);
  if (matches.length !== 1) return false;

  const next = path.join(dir, matches[0]);
  const stat = await fsp.stat(next).catch(() => null);
  if (!stat?.isFile() || !stat.size) return false;

  job.dest = next;
  job.fileName = matches[0];
  job.bytes = stat.size;
  job.total = stat.size;
  const quality = /(2160p|1080p|720p|480p|sd)/i.exec(matches[0]);
  if (quality) job.quality = quality[1].toLowerCase();
  scheduleSave(0);
  console.log(`[download] ${job.title}: adopted renamed file ${matches[0]}`);
  return true;
}

/**
 * Rebuild the queue from disk. A job that was mid-transfer keeps its temp files
 * and is marked `resumed`, so one failed resume falls back to a clean start.
 * Offline boot leaves everything paused; nothing reaches the network.
 */
export async function startRestoredDownloads({ online = true } = {}) {
  if (!libraryRoot) return listDownloads();
  stateFile ||= path.join(libraryRoot, '.cache', STATE_NAME);

  const orphans = await killOrphans();
  if (orphans) console.log(`[download] stopped ${orphans} orphaned media process(es)`);

  const data = await readState();
  const restored = [];
  for (const raw of data?.jobs || []) {
    if (!raw || typeof raw !== 'object' || !raw.id) continue;
    const id = String(raw.id);
    if (jobs.has(id)) continue;
    const kind = raw.kind === 'torrent' ? 'torrent' : 'hls';
    const previous = String(raw.status || '');

    /* Cancelled jobs are deleted at the time they are cancelled; one saved by
     * a crash between those two steps is not worth keeping. */
    if (previous === 'cancelled') continue;

    const job = {
      ...raw,
      id,
      kind,
      controller: null,
      ffmpeg: null,
      speed: 0,
      failures: Array.isArray(raw.failures) ? raw.failures : [],
    };

    if (previous === 'completed' || previous === 'failed') {
      job.status = previous;
    } else if (previous === 'paused') {
      job.status = 'paused';
      job.resumed = kind === 'torrent';
    } else if (previous === 'downloading' || previous === 'queued' || previous === 'searching') {
      job.status = online ? 'queued' : 'paused';
      job.resumed = kind === 'torrent';
      job.error = null;
      if (kind === 'torrent') {
        job.stage = job.stage && job.stage !== 'done' ? job.stage : 'searching';
        job.progressValue = Math.min(0.8, Math.max(0, Number(job.progressValue) || 0));
      }
    } else {
      job.status = 'failed';
      job.error = job.error || 'the download was interrupted';
    }

    jobs.set(id, job);
    restored.push(job);
  }

  /* Renamed files are adopted before anything is resumed or swept. */
  for (const job of restored) {
    if (job.status !== 'completed') continue;
    await adoptRenamedFile(job);
  }

  /* ffmpeg output cannot be appended to, so a half-written MP4 is always
   * discarded. Torrent payloads keep aria2's control file and resume. */
  for (const job of restored) {
    if (job.status === 'queued' || job.status === 'paused') {
      /* The rename into the library is the last step of a job. A destination
       * that exists means the crash happened just before the status update, so
       * the episode is already installed — do not download it twice. */
      const installed = job.dest ? await fsp.stat(job.dest).catch(() => null) : null;
      if (installed?.isFile() && installed.size > 0) {
        job.status = 'completed';
        job.stage = 'done';
        job.error = null;
        job.progressValue = 1;
        job.part = '';
        job.bytes = installed.size;
        job.total = installed.size;
        job.speed = 0;
        job.completedAt = job.completedAt || Date.now();
        continue;
      }
    }
    const partial = job.part || (job.dest ? `${job.dest}.part` : '');
    if (partial) await fsp.rm(partial, { force: true }).catch(() => {});
    job.part = '';
    if (job.dest) await fsp.rm(`${job.dest}.part`, { force: true }).catch(() => {});
  }

  await sweepTorrentTempDirs();

  for (const job of restored) {
    if (job.status !== 'queued') continue;
    queue.push(job);
  }
  trimHistory();
  const restoredQueued = restored.filter((job) => job.status === 'queued').length;
  const restoredPaused = restored.filter((job) => job.status === 'paused').length;
  if (online) pump();
  scheduleSave(0);

  if (restored.length) {
    console.log(`[download] restored ${restored.length} job(s), ${restoredQueued} queued, ${restoredPaused} paused`);
  }
  return listDownloads();
}

function text(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return value == null ? '' : String(value);
}

// Subtitles come from Castle as {language, url}. Keep every language the
// service offers (original audio track + English and the rest), one per code.
function normalizeSubtitleTracks(body) {
  const seen = new Set();
  const tracks = [];
  const push = (url, lang, literal) => {
    const code = String(lang || '').toLowerCase().slice(0, 3);
    const link = String(url || '');
    if (!/^[a-z]{2,3}$/.test(code) || seen.has(code)) return;
    if (!literal && !/^https:\/\//i.test(link)) return;
    seen.add(code);
    tracks.push({ lang: code, url: link, text: literal ? String(literal) : '' });
  };

  if (Array.isArray(body.subtitles)) {
    for (const entry of body.subtitles) push(entry?.url, entry?.language ?? entry?.lang, entry?.text);
  }
  // Back-compat with the single-track fields.
  push(body.subtitleUrl, body.subtitleLang);

  // English first, everything else alphabetical so the original language is
  // still listed after it.
  return tracks.sort((a, b) => (a.lang === 'en' ? -1 : b.lang === 'en' ? 1 : a.lang.localeCompare(b.lang)));
}

function isVideoName(name) {
  return VIDEO_EXTS.has(path.extname(String(name || '')).toLowerCase());
}

function publicJob(job) {
  /* A torrent job runs in phases (fetch, download, verify, remux, subtitles),
   * so it reports its own 0..1 value; an HLS job keeps the byte ratio. */
  const progress = Number.isFinite(job.progressValue)
    ? Math.max(0, Math.min(1, job.progressValue))
    : (job.total ? Math.min(1, job.bytes / job.total) : 0);
  return {
    id: job.id,
    kind: job.kind || 'http',
    title: job.title,
    fileName: job.fileName,
    collection: job.collection,
    identifier: job.identifier,
    source: job.source || null,
    sourceLabel: job.sourceLabel || '',
    quality: job.quality || '',
    seeders: Number(job.seeders) || 0,
    stage: job.stage || '',
    release: job.release?.name || '',
    url: job.url,
    status: job.status,
    bytes: job.bytes,
    total: job.total,
    season: Number(job.season) || 0,
    episode: Number(job.episode) || 0,
    progress,
    speed: job.speed,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    destination: job.dest,
  };
}

function sanitizeSegment(value, fallback) {
  let out = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 90);
  if (!out) out = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `_${out}`;
  return out;
}

function sanitizeFileName(value) {
  const base = path.basename(String(value || '').replace(/\\/g, '/'));
  let name = base.replace(/[<>:"|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) name = 'video.mp4';
  if (!isVideoName(name)) name += '.mp4';
  return name;
}

const reservedPaths = new Set();

async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let n = 1; ; n++) {
    const key = candidate.toLowerCase();
    let taken = reservedPaths.has(key);
    if (!taken) {
      try {
        await fsp.access(candidate);
        taken = true;
      } catch {
        /* free */
      }
    }
    if (!taken) {
      reservedPaths.add(key);
      return candidate;
    }
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
}


/**
 * Queue an HLS (m3u8) download. Segments are remuxed to MP4 by ffmpeg, so the
 * finished file lands in the library exactly like an archive.org download.
 */
export async function addHlsDownload(body = {}) {
  if (!libraryRoot) throw new Error('downloads are not initialized');

  const url = String(body.url || '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const err = new Error('invalid download url');
    err.status = 400;
    throw err;
  }
  if (parsed.protocol !== 'https:') {
    const err = new Error('only https download urls are allowed');
    err.status = 400;
    throw err;
  }

  const collection = sanitizeSegment(body.collection || 'Downloads', 'Downloads');
  const title = text(body.title) || 'video';
  const fileName = sanitizeFileName(body.fileName || `${title}.mp4`);
  const folder = body.folder ? sanitizeSegment(body.folder, '') : '';
  const targetDir = folder
    ? path.join(libraryRoot, collection, folder)
    : path.join(libraryRoot, collection);
  await fsp.mkdir(targetDir, { recursive: true });

  const known = findExisting(fileName);
  if (known) {
    const already = [];
    already.skipped = [{ fileName, id: known.id, title: known.displayTitle || known.title }];
    return already;
  }

  const dest = await uniquePath(targetDir, fileName);
  const job = {
    id: crypto.randomUUID(),
    kind: 'hls',
    title,
    seriesTitle: text(body.seriesTitle) || title,
    fileName: path.basename(dest),
    collection,
    identifier: null,
    source: text(body.source) || 'castle',
    url,
    season: Number(body.season) || 0,
    episode: Number(body.episode) || 0,
    referer: text(body.referer) || '',
    dest,
    status: 'queued',
    bytes: 0,
    total: Math.max(0, Number(body.total) || 0),
    speed: 0,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    controller: null,
    ffmpeg: null,
    subtitles: normalizeSubtitleTracks(body),
    // Castle episode tracks: { index, language, code, iso, default }. Empty
    // means the source did not expose tracks, so every audio stream is kept.
    audioTracks: Array.isArray(body.audioTracks) ? body.audioTracks : [],
  };
  jobs.set(job.id, job);
  queue.push(job);
  scheduleSave(0);
  pump();
  return [publicJob(job)];
}

/* ---------- Torrentio releases (Castle metadata, BitTorrent video) ---------- */

const MAX_CANDIDATES = 4;
/* An episode above this is a multi-hour download on a home line; prefer any
 * normal-sized release that the ranking already finds acceptable. A movie is
 * naturally bigger, so it gets a wider band. */
const MAX_EPISODE_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_MOVIE_BYTES = 6 * 1024 * 1024 * 1024;

/* Torrentio tags most releases with the audio languages they ship. When the
 * indexer lists languages for this title but English is never among them, the
 * show simply has no English audio there (Thai-only rips, for example) and
 * Castle's HLS dub is the better answer. Releases with no tag at all stay in
 * the pool and are verified by ffprobe after the download. */
function hasEnglish(release) {
  const declared = Array.isArray(release.languages) ? release.languages : [];
  return declared.includes('en');
}

function declaresLanguages(release) {
  return Array.isArray(release.languages) && release.languages.length > 0;
}

function pad2(value) {
  return String(Math.max(0, Number(value) || 0)).padStart(2, '0');
}

/* Same naming pattern the Castle download uses, so one series never ends up
 * with two files for the same episode. */
function torrentFileName(job, quality) {
  if (job.season > 0) {
    return `${job.seriesTitle} S${pad2(job.season)}E${pad2(job.episode)} ${quality}.mp4`;
  }
  return `${job.seriesTitle}${job.year ? ` (${job.year})` : ''} ${quality}.mp4`;
}

/* A widescreen master is often 1920x960 (2:1) or 1920x800; the height alone
 * would class those as 720p. Width decides the class, height only breaks ties. */
function qualityFromHeight(height, width = 0) {
  const h = Number(height) || 0;
  const w = Number(width) || 0;
  if (h >= 2000 || w >= 3400) return '2160p';
  if (h >= 1000 || w >= 1800) return '1080p';
  if (h >= 700 || w >= 1200) return '720p';
  if (h >= 400 || w >= 700) return '480p';
  return 'sd';
}

/**
 * What a click would actually download, without downloading it: the ranked
 * release list, the English gate and the winning candidate. The download sheet
 * shows the same numbers, so its quality label cannot drift from the job.
 * Returns null when Torrentio has nothing usable (Castle is the fallback).
 */
export async function planTorrentRelease({ imdbId, season = 0, episode = 0, originalLanguage = '' } = {}) {
  if (!/^tt\d{4,10}$/.test(String(imdbId || '').trim())) return null;

  const streams = await findReleases({ imdbId: String(imdbId).trim(), isSeries: Number(season) > 0, season, episode });
  if (!streams.length) return null;
  const ranked = rankReleases(streams, { originalLanguage: text(originalLanguage) });
  if (!ranked.length) return null;

  /* Prefer releases that ship English; untagged ones stay as fallbacks, in the
   * ranked order. When every tagged release is a different language (Thai-only,
   * Polish lektor), hand the episode to Castle instead of downloading a guess. */
  if (!ranked.some(hasEnglish) && ranked.some(declaresLanguages)) return null;
  const pool = ranked.filter((release) => hasEnglish(release) || !declaresLanguages(release));
  if (!pool.length) return null;

  /* 1080p is the floor (rankReleases already dropped everything lower), and a
   * sane file size beats a 29 GiB season pack: the click should fetch one
   * episode, not hours of someone else's season. A giant 1080p still stays
   * ahead of any pack, because a pack is the less predictable download. */
  const limit = Number(season) > 0 ? MAX_EPISODE_BYTES : MAX_MOVIE_BYTES;
  const hd = pool.filter((release) => release.quality === '1080p' || release.quality === '2160p');
  if (!hd.length) return null;
  const saneSize = (release) => !release.sizeBytes || release.sizeBytes <= limit;
  const single = hd.filter((release) => !release.moviePack);
  const packs = hd.filter((release) => release.moviePack);

  /* A "263 movies" torrent is never a good first pick: its pieces are shaped
   * for a collection and the peers for one film are a thin slice of the swarm.
   * Movie packs stay at the back as last-resort fallbacks. */
  const ordered = [
    ...single.filter(saneSize),
    ...single.filter((release) => !saneSize(release)),
    ...packs.filter(saneSize),
    ...packs.filter((release) => !saneSize(release)),
  ];

  return { release: ordered[0], candidates: ordered.slice(0, MAX_CANDIDATES) };
}

/**
 * Queue a torrent download: Torrentio lists the releases, the healthiest H.264
 * 1080p one is fetched with aria2c, then remuxed to a browser-friendly MP4 with
 * the original audio + English and every embedded subtitle as a .vtt sidecar.
 *
 * Returns null when Torrentio has nothing usable, so the caller can fall back
 * to the Castle HLS download. Returns { skipped } when the file is already in
 * the library.
 */
export async function addTorrentDownload(body = {}) {
  if (!libraryRoot) throw new Error('downloads are not initialized');

  const imdbId = String(body.imdbId || '').trim();
  if (!/^tt\d{4,10}$/.test(imdbId)) return null;

  const season = Number(body.season) || 0;
  const episode = Number(body.episode) || 0;
  const isSeries = season > 0;
  const seriesTitle = text(body.seriesTitle) || text(body.title) || 'video';
  const title = isSeries ? `${seriesTitle} S${pad2(season)}E${pad2(episode)}` : seriesTitle;

  const plan = await planTorrentRelease({
    imdbId,
    season,
    episode,
    originalLanguage: text(body.originalLanguage),
  });
  if (!plan) return null;
  const candidates = plan.candidates;

  const collection = sanitizeSegment(body.collection || 'Downloads', 'Downloads');
  const folder = body.folder ? sanitizeSegment(body.folder, '') : '';
  const targetDir = folder
    ? path.join(libraryRoot, collection, folder)
    : path.join(libraryRoot, collection);
  await fsp.mkdir(targetDir, { recursive: true });

  const top = candidates[0];
  const fileName = sanitizeFileName(torrentFileName({ seriesTitle, season, episode, year: body.year }, top.quality));
  const known = findExisting(fileName);
  if (known) {
    return {
      count: 0,
      jobs: [],
      skipped: [{ fileName, id: known.id, title: known.displayTitle || known.title }],
      source: 'torrentio',
      quality: top.quality,
      seeders: top.seeders,
      release: top.name,
    };
  }
  // The file name carries the final height, which is only known after probing;
  // reserve the download-library path lazily in the job.
  const job = {
    id: crypto.randomUUID(),
    kind: 'torrent',
    title,
    seriesTitle,
    fileName,
    collection,
    folder,
    identifier: imdbId,
    source: 'torrentio',
    url: '',
    season,
    episode,
    year: Number(body.year) || 0,
    originalLanguage: text(body.originalLanguage),
    poster: text(body.poster),
    targetDir,
    dest: '',
    status: 'queued',
    stage: 'searching',
    bytes: 0,
    total: Number(top.sizeBytes) || 0,
    speed: 0,
    error: null,
    progressValue: 0,
    quality: top.quality,
    seeders: top.seeders,
    sourceLabel: releaseLabel(top),
    release: top,
    candidates,
    attempt: 0,
    failures: [],
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    controller: null,
    ffmpeg: null,
    subtitles: [],
  };
  jobs.set(job.id, job);
  queue.push(job);
  scheduleSave(0);
  pump();
  return {
    count: 1,
    jobs: [publicJob(job)],
    source: 'torrentio',
    quality: top.quality,
    seeders: top.seeders,
    release: top.name,
    candidates: candidates.map((entry) => releaseLabel(entry)),
  };
}

function torrentTempDir(job) {
  return path.join(libraryRoot, '.cache', 'torrent', job.id);
}

export function listDownloads() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicJob);
}

export async function cancelDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  const part = job.dest ? `${job.dest}.part` : '';
  const removePart = async () => {
    if (part) await fsp.rm(part, { force: true }).catch(() => {});
    if (job.kind === 'torrent') await fsp.rm(torrentTempDir(job), { recursive: true, force: true }).catch(() => {});
  };

  // A cancelled job is gone for good: drop it from the list right away and
  // delete the partial file so nothing is left behind.
  if (job.status === 'queued' || job.status === 'paused') {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    jobs.delete(job.id);
    scheduleSave(0);
    await removePart();
    return { id: job.id, status: 'cancelled', removed: true };
  }

  if (job.status === 'downloading') {
    job.status = 'cancelled';
    job.completedAt = Date.now();
    jobs.delete(job.id);
    scheduleSave(0);
    try { job.controller?.abort(); } catch { /* already gone */ }
    if (job.ffmpeg) killTree(job.ffmpeg);
    // The writer may still hold the file open on Windows; the abort handler
    // retries the delete once the stream closes.
    await removePart();
    return { id: job.id, status: 'cancelled', removed: true };
  }

  return publicJob(job);
}

/**
 * Offline mode: stop every transfer without losing progress. Partial files
 * stay on disk and the jobs wait in "paused" until internet comes back.
 */
export function pauseDownloads() {
  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      job.status = 'paused';
      job.speed = 0;
    } else if (job.status === 'downloading') {
      job.status = 'paused';
      job.speed = 0;
      try { job.controller?.abort(); } catch { /* already gone */ }
      if (job.ffmpeg) killTree(job.ffmpeg);
    }
  }
  scheduleSave(0);
  return listDownloads();
}

export function resumeDownloads() {
  for (const job of [...jobs.values()]) {
    if (job.status !== 'paused') continue;
    job.status = 'queued';
    job.error = null;
    job.speed = 0;
    queue.push(job);
  }
  scheduleSave(0);
  pump();
  return listDownloads();
}

/**
 * Stop one transfer, keeping its partial payload. aria2c resumes from its
 * control file when the job is resumed; a half-written ffmpeg MP4 is rebuilt.
 */
export function pauseDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  if (job.status === 'queued') {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.status = 'paused';
    job.speed = 0;
    scheduleSave(0);
    return publicJob(job);
  }
  if (job.status !== 'downloading') return publicJob(job);

  job.status = 'paused';
  job.speed = 0;
  try { job.controller?.abort(); } catch { /* already gone */ }
  if (job.ffmpeg) killTree(job.ffmpeg);
  scheduleSave(0);
  return publicJob(job);
}

/** Put a paused job back at the end of the queue; it starts immediately. */
export function resumeDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  if (job.status !== 'paused') return publicJob(job);
  job.status = 'queued';
  job.error = null;
  job.speed = 0;
  queue.push(job);
  scheduleSave(0);
  pump();
  return publicJob(job);
}

export function retryDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  if (job.status !== 'failed' && job.status !== 'cancelled' && job.status !== 'paused') {
    return publicJob(job);
  }
  job.status = 'queued';
  job.error = null;
  job.bytes = 0;
  job.total = 0;
  job.speed = 0;
  job.startedAt = null;
  job.completedAt = null;
  job.progressValue = job.kind === 'torrent' ? 0 : undefined;
  job.attempt = 0;
  if (Array.isArray(job.failures)) job.failures.length = 0;
  job.resumed = false;
  queue.push(job);
  scheduleSave(0);
  pump();
  return publicJob(job);
}

function pump() {
  while (activeCount < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    activeCount++;
    const task = job.kind === 'torrent' ? runTorrentJob(job) : runHlsJob(job);
    task
      .catch(() => {})
      .finally(() => {
        activeCount--;
        pump();
      });
  }
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* best effort */
    }
  }
}

async function saveSubtitle(job) {
  if (!job.subtitles?.length) {
    if (job.kind === 'hls') {
      await ensureEnglishSubtitle(job.dest, {
        seriesTitle: job.seriesTitle || job.title,
        title: job.title,
        season: job.season,
        episode: job.episode,
        isSeries: Number(job.season) > 0,
      }).catch(() => {});
    }
    return;
  }
  const stem = job.dest.slice(0, job.dest.length - path.extname(job.dest).length);
  let wroteEnglish = false;
  for (const track of job.subtitles) {
    try {
      let body;
      if (track.text) {
        body = vttFromSubtitle(track.text);
      } else {
        const res = await fetch(track.url, {
          headers: { 'User-Agent': USER_AGENT, Referer: job.referer || 'https://api.hlowb.com/' },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) continue;
        const raw = await res.text();
        if (!/^\uFEFF?WEBVTT/.test(raw.trimStart()) && !/-->/.test(raw)) continue;
        body = vttFromSubtitle(raw);
      }
      if (!body || body.length < 20) continue;
      await fsp.writeFile(`${stem}.${track.lang}.vtt`, body, 'utf8');
      if (track.lang === 'en') wroteEnglish = true;
    } catch {
      /* a missing subtitle should never fail the download */
    }
  }
  if (!wroteEnglish) {
    await ensureEnglishSubtitle(job.dest, {
      seriesTitle: job.seriesTitle || job.title,
      title: job.title,
      season: job.season,
      episode: job.episode,
      isSeries: Number(job.season) > 0,
    }).catch(() => {});
  }
}

async function runHlsJob(job) {
  job.status = 'downloading';
  job.startedAt = Date.now();
  scheduleSave(0);
  const controller = new AbortController();
  job.controller = controller;
  const part = `${job.dest}.part`;

  await fsp.rm(part, { force: true }).catch(() => {});

  const args = ['-y', '-loglevel', 'error'];
  if (job.referer) args.push('-headers', `Referer: ${job.referer}\r\n`);
  // Castle muxes every dub into the same HLS stream. Map only the selected
  // languages (original + English); without track data keep every audio
  // rendition, because ffmpeg would otherwise drop all but the first one.
  const audioTracks = (Array.isArray(job.audioTracks) ? job.audioTracks : [])
    .filter((track) => Number.isInteger(Number(track?.index)) && Number(track.index) >= 0);
  args.push('-i', job.url, '-map', '0:v:0');
  if (audioTracks.length) {
    audioTracks.forEach((track, position) => {
      args.push('-map', `0:a:${Number(track.index)}?`);
      args.push(`-metadata:s:a:${position}`, `language=${track.iso || track.code || 'und'}`);
      args.push(`-metadata:s:a:${position}`, `title=${track.language || `Audio ${position + 1}`}`);
      args.push(`-disposition:a:${position}`, position === 0 ? 'default' : '0');
    });
  } else {
    args.push('-map', '0:a?');
    args.push('-disposition:a:0', 'default');
  }
  args.push(
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    part,
  );

  let child = null;
  let stderr = '';
  let timer = null;

  try {
    child = spawnNice(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    job.ffmpeg = child;
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    timer = setInterval(async () => {
      try {
        const stat = await fsp.stat(part);
        job.bytes = stat.size;
        const elapsed = (Date.now() - job.startedAt) / 1000;
        job.speed = elapsed > 0 ? Math.round(stat.size / elapsed) : 0;
        scheduleSave();
      } catch {
        /* file not created yet */
      }
    }, 1000);

    const onAbort = () => killTree(child);
    controller.signal.addEventListener('abort', onAbort);

    const code = await new Promise((resolve) => {
      child.on('error', (err) => {
        stderr = `${stderr}\n${err.message}`;
        resolve(-1);
      });
      child.on('close', resolve);
    });

    controller.signal.removeEventListener('abort', onAbort);

    if (controller.signal.aborted) {
      if (job.status === 'paused') {
        job.speed = 0;
        scheduleSave(0);
        return;
      }
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = null;
      await fsp.rm(part, { force: true }).catch(() => {});
      jobs.delete(job.id);
      scheduleSave(0);
      return;
    }

    if (code !== 0) {
      const line = stderr.split('\n').map((value) => value.trim()).filter(Boolean).pop();
      throw new Error(line || `ffmpeg exited with code ${code}`);
    }

    const stat = await fsp.stat(part);
    if (!stat.size) throw new Error('ffmpeg produced an empty file');

    await fsp.rename(part, job.dest);
    job.bytes = stat.size;
    job.total = stat.size;
    job.speed = 0;
    job.status = 'completed';
    job.completedAt = Date.now();
    await saveSubtitle(job).catch(() => {});
    await onComplete(job).catch(() => {});
    scheduleSave(0);
  } catch (err) {
    /* Killing ffmpeg makes it exit non-zero; that is a pause, not a failure. */
    if (job.status === 'paused') {
      job.speed = 0;
      await fsp.rm(part, { force: true }).catch(() => {});
      scheduleSave(0);
      return;
    }
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = err?.message || String(err);
    await fsp.rm(part, { force: true }).catch(() => {});
    scheduleSave(0);
  } finally {
    if (timer) clearInterval(timer);
    job.controller = null;
    job.ffmpeg = null;
  }
}

async function resetTorrentDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
}

/**
 * One candidate release, start to finish. Returns 'done' when the episode is
 * installed, 'aborted' when the job was paused or cancelled, or a short failure
 * string so the caller can try the next release.
 */
async function attemptRelease(job, release, dir, controller) {
  job.release = release;
  job.quality = release.quality;
  job.seeders = release.seeders;
  job.sourceLabel = releaseLabel(release);
  job.stage = 'metadata';
  job.progressValue = 0.01;
  job.bytes = 0;
  job.total = Number(release.sizeBytes) || 0;
  job.speed = 0;
  scheduleSave(0);

  const magnet = magnetFor(release);
  let file = null;
  try {
    const files = await fetchTorrentFiles(magnet, { dir });
    file = matchEpisodeFile(files, release.fileName, { season: job.season, episode: job.episode });
  } catch (err) {
    if (controller.signal.aborted) return 'aborted';
    return `${release.name}: ${err?.message || err}`;
  }
  if (!file) return `${release.name}: episode file is not in this torrent`;

  job.stage = 'downloading';
  job.total = Number(file.size) || job.total;
  scheduleSave(0);
  let downloaded;
  try {
    downloaded = await downloadTorrentFile({
      magnet,
      file,
      dir,
      total: Number(file.size) || 0,
      signal: controller.signal,
      onProgress: ({ bytes, total, speed }) => {
        job.bytes = bytes;
        if (total) job.total = total;
        /* aria2 reports the live transfer rate; a zero means it is waiting on
         * peers, which is worth showing instead of a stale average. */
        job.speed = Number(speed) || 0;
        job.progressValue = job.total ? Math.min(0.8, (bytes / job.total) * 0.8) : 0;
        scheduleSave();
      },
    });
  } catch (err) {
    if (controller.signal.aborted || job.status === 'paused') return 'aborted';
    return `${release.name}: ${err?.message || err}`;
  }
  job.speed = 0;
  job.bytes = downloaded.bytes;
  job.total = downloaded.bytes;
  scheduleSave(0);

  job.stage = 'verifying';
  job.progressValue = 0.82;
  scheduleSave(0);
  const probe = await probeMedia(downloaded.path);
  const picked = pickTracks(probe, { originalLanguage: job.originalLanguage });
  if (picked.error) return `${release.name}: ${picked.reason || picked.error}`;

  const quality = qualityFromHeight(probe.video?.height, probe.video?.width) || release.quality;
  job.quality = quality;
  job.fileName = sanitizeFileName(torrentFileName(job, quality));
  const dest = await uniquePath(job.targetDir, job.fileName);
  const part = `${dest}.part`;
  const stem = dest.slice(0, dest.length - path.extname(dest).length);
  const durationSec = Number(probe.durationSec) || 0;

  job.stage = 'remuxing';
  job.progressValue = 0.84;
  job.part = part;
  scheduleSave(0);
  await fsp.rm(part, { force: true }).catch(() => {});
  const remuxStartedAt = Date.now();
  try {
    await remuxToMp4({
      input: downloaded.path,
      output: part,
      video: picked.video,
      audio: picked.audio,
      onProgress: ({ sec } = {}) => {
        if (!durationSec || !Number.isFinite(sec)) return;
        job.progressValue = 0.84 + Math.min(0.12, (sec / durationSec) * 0.12);
        scheduleSave();
      },
    });
  } catch (err) {
    job.part = '';
    await fsp.rm(part, { force: true }).catch(() => {});
    if (controller.signal.aborted) return 'aborted';
    return `${release.name}: remux failed (${err?.message || err})`;
  }

  /* One line per job so the launcher log answers "why was that slow". */
  {
    const seconds = (Date.now() - remuxStartedAt) / 1000;
    const speed = durationSec ? `${(durationSec / Math.max(seconds, 0.001)).toFixed(1)}x realtime` : 'duration unknown';
    console.log(`[download] ${job.title}: remuxed ${(durationSec / 60).toFixed(0)} min to H.264 in ${seconds.toFixed(1)} s (${speed})`);
  }

  job.stage = 'subtitles';
  job.progressValue = 0.97;
  scheduleSave(0);
  const tracks = await extractSubtitles({
    input: downloaded.path,
    outStem: stem,
    subtitles: picked.subtitles,
  }).catch(() => []);
  job.subtitles = tracks.map((track) => track.lang);

  if (controller.signal.aborted) {
    job.part = '';
    await fsp.rm(part, { force: true }).catch(() => {});
    for (const track of tracks) await fsp.rm(track.path, { force: true }).catch(() => {});
    return 'aborted';
  }

  await fsp.rename(part, dest);
  job.part = '';
  const stat = await fsp.stat(dest);
  job.dest = dest;
  job.fileName = path.basename(dest);
  job.bytes = stat.size;
  job.total = stat.size;
  job.speed = 0;
  job.progressValue = 1;
  job.stage = 'done';
  job.status = 'completed';
  job.completedAt = Date.now();
  scheduleSave(0);

  if (!tracks.some((track) => track.lang === 'en')) {
    await ensureEnglishSubtitle(dest, {
      seriesTitle: job.seriesTitle || job.title,
      title: job.title,
      season: job.season,
      episode: job.episode,
      isSeries: job.season > 0,
    }).catch(() => {});
  }
  await onComplete(job).catch(() => {});
  return 'done';
}

async function runTorrentJob(job) {
  job.status = 'downloading';
  job.startedAt = Date.now();
  job.error = null;
  const controller = new AbortController();
  job.controller = controller;
  scheduleSave(0);
  const dir = torrentTempDir(job);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const failures = Array.isArray(job.failures) ? job.failures : (job.failures = []);
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  /* A transfer restored after a crash is attempted once with its old pieces.
   * If that cannot finish, the same release gets one clean start. */
  const resumed = Boolean(job.resumed);
  job.resumed = false;
  let wipedIndex = -1;
  let firstAttempt = true;

  try {
    for (let index = Math.max(0, Number(job.attempt) || 0); index < candidates.length; index++) {
      if (controller.signal.aborted) return;
      job.attempt = index;
      const outcome = await attemptRelease(job, candidates[index], dir, controller);
      if (outcome === 'done') return;
      if (outcome === 'aborted') return;

      const retrySame = job.stage === 'downloading' || (firstAttempt && resumed);
      firstAttempt = false;
      failures.push(outcome);
      console.warn(`[download] ${job.title}: ${outcome} — trying the next release`);

      /* Resume can fail for reasons the crash left behind: a corrupt .aria2
       * control file, a piece half-written to disk, a deleted temp folder.
       * Wipe the leftovers and give this release one fresh attempt before
       * falling through to the next candidate. */
      if (retrySame && wipedIndex !== index) {
        wipedIndex = index;
        console.warn(`[download] ${job.title}: restarting this release from a clean folder`);
        job.bytes = 0;
        job.total = Number(candidates[index]?.sizeBytes) || 0;
        job.progressValue = 0.01;
        scheduleSave(0);
        await resetTorrentDir(dir);
        index--;
        continue;
      }
      await resetTorrentDir(dir);
    }
    const detail = failures.length ? `: ${failures[failures.length - 1]}` : '';
    throw new Error(failures.length
      ? `all ${failures.length} release(s) failed${detail}`
      : 'no Torrentio release had the original audio, English audio and subtitles');
  } catch (err) {
    if (job.status === 'paused') {
      job.stage = '';
      job.speed = 0;
      scheduleSave(0);
      return;
    }
    job.status = 'failed';
    job.stage = '';
    job.speed = 0;
    job.completedAt = Date.now();
    job.error = err?.message || String(err);
    if (job.dest) await fsp.rm(`${job.dest}.part`, { force: true }).catch(() => {});
    scheduleSave(0);
  } finally {
    job.controller = null;
    /* An interrupted remux leaves an unplayable MP4 that cannot be resumed. */
    if (job.part) {
      await fsp.rm(job.part, { force: true }).catch(() => {});
      job.part = '';
    }
    /* A paused job keeps its partial torrent so aria2c can resume it. */
    if (job.status !== 'paused') await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    scheduleSave(0);
  }
}

