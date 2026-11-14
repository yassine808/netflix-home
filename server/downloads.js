import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { spawnNice } from './proc.js';
import { ensureEnglishSubtitle, vttFromSubtitle } from './subs.js';

const USER_AGENT = 'netflix-home/1.0 (local library downloader)';

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.divx',
]);

const jobs = new Map();
const queue = [];
let activeCount = 0;
const MAX_ACTIVE = 2;
let libraryRoot = '';
let onComplete = async () => {};
/* Returns the library item that already has this file name, or null. Downloads
 * use it so a title that is already on disk is never copied a second time. */
let findExisting = () => null;

export function initDownloads({ root, onDownloadComplete, findDownload = null }) {
  libraryRoot = root;
  onComplete = onDownloadComplete || (async () => {});
  findExisting = typeof findDownload === 'function' ? findDownload : () => null;
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
  return {
    id: job.id,
    kind: job.kind || 'http',
    title: job.title,
    fileName: job.fileName,
    collection: job.collection,
    identifier: job.identifier,
    source: job.source || null,
    url: job.url,
    status: job.status,
    bytes: job.bytes,
    total: job.total,
    season: Number(job.season) || 0,
    episode: Number(job.episode) || 0,
    progress: job.total ? Math.min(1, job.bytes / job.total) : 0,
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
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return [publicJob(job)];
}

export function listDownloads() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicJob);
}

export async function cancelDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  const part = `${job.dest}.part`;

  // A cancelled job is gone for good: drop it from the list right away and
  // delete the partial file so nothing is left behind.
  if (job.status === 'queued' || job.status === 'paused') {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    jobs.delete(job.id);
    await fsp.rm(part, { force: true }).catch(() => {});
    return { id: job.id, status: 'cancelled', removed: true };
  }

  if (job.status === 'downloading') {
    job.status = 'cancelled';
    job.completedAt = Date.now();
    jobs.delete(job.id);
    try { job.controller?.abort(); } catch { /* already gone */ }
    if (job.ffmpeg) killTree(job.ffmpeg);
    // The writer may still hold the file open on Windows; the abort handler
    // retries the delete once the stream closes.
    await fsp.rm(part, { force: true }).catch(() => {});
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
  pump();
  return listDownloads();
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
  queue.push(job);
  pump();
  return publicJob(job);
}

function pump() {
  while (activeCount < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    activeCount++;
    runHlsJob(job)
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
  const controller = new AbortController();
  job.controller = controller;
  const part = `${job.dest}.part`;

  await fsp.rm(part, { force: true }).catch(() => {});

  const args = ['-y', '-loglevel', 'error'];
  if (job.referer) args.push('-headers', `Referer: ${job.referer}\r\n`);
  // Map every audio rendition: dubs are muxed into the same HLS stream and
  // ffmpeg would otherwise keep only the first one.
  args.push(
    '-i', job.url,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c', 'copy',
    '-disposition:a:0', 'default',
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
        return;
      }
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = null;
      await fsp.rm(part, { force: true }).catch(() => {});
      jobs.delete(job.id);
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
  } catch (err) {
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = err?.message || String(err);
    await fsp.rm(part, { force: true }).catch(() => {});
  } finally {
    if (timer) clearInterval(timer);
    job.controller = null;
    job.ffmpeg = null;
  }
}

