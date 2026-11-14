import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
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
  pump();
  return [publicJob(job)];
}

/* ---------- Torrentio releases (Castle metadata, BitTorrent video) ---------- */

const MAX_CANDIDATES = 4;

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

function qualityFromHeight(height) {
  const h = Number(height) || 0;
  if (h >= 2000) return '2160p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 400) return '480p';
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
  return { release: pool[0], candidates: pool.slice(0, MAX_CANDIDATES) };
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
    await removePart();
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
  job.progressValue = job.kind === 'torrent' ? 0 : undefined;
  job.attempt = 0;
  if (Array.isArray(job.failures)) job.failures.length = 0;
  queue.push(job);
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
  const startedAt = Date.now();
  let downloaded;
  try {
    downloaded = await downloadTorrentFile({
      magnet,
      file,
      dir,
      total: Number(file.size) || 0,
      signal: controller.signal,
      onProgress: ({ bytes, total }) => {
        job.bytes = bytes;
        if (total) job.total = total;
        const seconds = (Date.now() - startedAt) / 1000;
        job.speed = seconds > 0.5 ? Math.round(bytes / seconds) : 0;
        job.progressValue = job.total ? Math.min(0.8, (bytes / job.total) * 0.8) : 0;
      },
    });
  } catch (err) {
    if (controller.signal.aborted || job.status === 'paused') return 'aborted';
    return `${release.name}: ${err?.message || err}`;
  }
  job.speed = 0;
  job.bytes = downloaded.bytes;
  job.total = downloaded.bytes;

  job.stage = 'verifying';
  job.progressValue = 0.82;
  const probe = await probeMedia(downloaded.path);
  const picked = pickTracks(probe, { originalLanguage: job.originalLanguage });
  if (picked.error) return `${release.name}: ${picked.reason || picked.error}`;

  const quality = qualityFromHeight(probe.video?.height) || release.quality;
  job.quality = quality;
  job.fileName = sanitizeFileName(torrentFileName(job, quality));
  const dest = await uniquePath(job.targetDir, job.fileName);
  const part = `${dest}.part`;
  const stem = dest.slice(0, dest.length - path.extname(dest).length);
  const durationSec = Number(probe.durationSec) || 0;

  job.stage = 'remuxing';
  job.progressValue = 0.84;
  await fsp.rm(part, { force: true }).catch(() => {});
  try {
    await remuxToMp4({
      input: downloaded.path,
      output: part,
      video: picked.video,
      audio: picked.audio,
      onProgress: ({ sec } = {}) => {
        if (!durationSec || !Number.isFinite(sec)) return;
        job.progressValue = 0.84 + Math.min(0.12, (sec / durationSec) * 0.12);
      },
    });
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {});
    if (controller.signal.aborted) return 'aborted';
    return `${release.name}: remux failed (${err?.message || err})`;
  }

  job.stage = 'subtitles';
  job.progressValue = 0.97;
  const tracks = await extractSubtitles({
    input: downloaded.path,
    outStem: stem,
    subtitles: picked.subtitles,
  }).catch(() => []);
  job.subtitles = tracks.map((track) => track.lang);

  if (controller.signal.aborted) {
    await fsp.rm(part, { force: true }).catch(() => {});
    for (const track of tracks) await fsp.rm(track.path, { force: true }).catch(() => {});
    return 'aborted';
  }

  await fsp.rename(part, dest);
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
  const controller = new AbortController();
  job.controller = controller;
  const dir = torrentTempDir(job);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const failures = job.failures;

  try {
    for (let index = job.attempt || 0; index < job.candidates.length; index++) {
      if (controller.signal.aborted) return;
      job.attempt = index;
      const outcome = await attemptRelease(job, job.candidates[index], dir, controller);
      if (outcome === 'done') return;
      if (outcome === 'aborted') return;
      failures.push(outcome);
      await resetTorrentDir(dir);
    }
    const detail = failures.length ? `: ${failures[0]}` : '';
    throw new Error(`no Torrentio release had the original audio, English audio and subtitles${detail}`);
  } catch (err) {
    job.status = 'failed';
    job.stage = '';
    job.speed = 0;
    job.completedAt = Date.now();
    job.error = err?.message || String(err);
    if (job.dest) await fsp.rm(`${job.dest}.part`, { force: true }).catch(() => {});
  } finally {
    job.controller = null;
    /* A paused job keeps its partial torrent so aria2c can resume it. */
    if (job.status !== 'paused') await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

