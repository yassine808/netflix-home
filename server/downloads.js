import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';

const IA = 'https://archive.org';
const SEARCH_URL = `${IA}/advancedsearch.php`;
const METADATA_URL = `${IA}/metadata/`;
const IMG_URL = `${IA}/services/img`;
const USER_AGENT = 'netflix-home/1.0 (local library downloader)';

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.divx',
]);

// Curated public-domain titles used when the archive.org search API is unavailable.
// Identifiers and file names were verified against the archive.org metadata API.
const FALLBACK_CATALOG = [
  {
    identifier: 'nosferatu-1922_202507',
    title: 'Nosferatu',
    year: 1922,
    creator: 'F. W. Murnau',
    file: 'Nosferatu (1922).mp4',
    size: 195241752,
  },
  {
    identifier: 'night-of-the-living-dead_202408',
    title: 'Night of the Living Dead',
    year: 1968,
    creator: 'George A. Romero',
    file: 'NIGHT OF THE LIVING DEAD.mp4',
    size: 558691964,
  },
  {
    identifier: 'HisGirlFriday',
    title: 'His Girl Friday',
    year: 1940,
    creator: 'Howard Hawks',
    file: 'MoviePowderPresentsHisGirlFriday.mp4',
  },
  {
    identifier: 'CarnivalOfSouls1962',
    title: 'Carnival of Souls',
    year: 1962,
    creator: 'Herk Harvey',
    file: 'Carnival_of_Souls.mp4',
  },
  {
    identifier: 'sherlockjr1924_201909',
    title: 'Sherlock Jr.',
    year: 1924,
    creator: 'Buster Keaton',
    file: 'Sherlock Jr. - Buster Keaton (1924) HD [720p].mp4',
  },
];

const jobs = new Map();
const queue = [];
let activeCount = 0;
const MAX_ACTIVE = 2;
let libraryRoot = '';
let onComplete = async () => {};

export function initDownloads({ root, onDownloadComplete }) {
  libraryRoot = root;
  onComplete = onDownloadComplete || (async () => {});
}

export function setDownloadsRoot(root) {
  libraryRoot = root;
}

function text(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return value == null ? '' : String(value);
}

function firstText(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  return value == null ? '' : String(value);
}

// Subtitles come from Castle as {language, url}. Keep only https .vtt tracks
// with a short language code, one per language.
const SUBTITLE_LANGS = new Set(['en', 'fr', 'ar', 'it']);

function normalizeSubtitleTracks(body) {
  const seen = new Set();
  const tracks = [];
  const push = (url, lang) => {
    const code = String(lang || '').toLowerCase();
    const link = String(url || '');
    if (!SUBTITLE_LANGS.has(code) || seen.has(code)) return;
    if (!/^https:\/\//i.test(link)) return;
    seen.add(code);
    tracks.push({ lang: code, url: link });
  };

  if (Array.isArray(body.subtitles)) {
    for (const entry of body.subtitles) push(entry?.url, entry?.language ?? entry?.lang);
  }
  // Back-compat with the single-track fields.
  push(body.subtitleUrl, body.subtitleLang);

  const order = ['en', 'fr', 'ar', 'it'];
  return tracks.sort((a, b) => order.indexOf(a.lang) - order.indexOf(b.lang));
}

function parseYear(value) {
  const match = text(value).match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function stripHtml(value) {
  return text(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function thumbFor(identifier) {
  return `${IMG_URL}/${encodeURIComponent(identifier)}`;
}

function detailsUrl(identifier) {
  return `${IA}/details/${encodeURIComponent(identifier)}`;
}

function encodeFileUrl(identifier, fileName) {
  const encoded = String(fileName)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${IA}/download/${encodeURIComponent(identifier)}/${encoded}`;
}

function isVideoName(name) {
  return VIDEO_EXTS.has(path.extname(String(name || '')).toLowerCase());
}

function cleanResult(doc, source) {
  const identifier = firstText(doc.identifier);
  const title = firstText(doc.title) || identifier;
  const year = parseYear(doc.year || doc.date);
  return {
    identifier,
    title,
    year,
    creator: firstText(doc.creator),
    downloads: Number(doc.downloads) || 0,
    thumb: thumbFor(identifier),
    url: detailsUrl(identifier),
    source,
  };
}

function assertIdentifier(identifier) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(identifier || ''))) {
    const err = new Error('invalid archive.org identifier');
    err.status = 400;
    throw err;
  }
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

export async function searchCatalog(query, page = 1) {
  const q = String(query || '').trim();
  if (!q) {
    const err = new Error('q is required');
    err.status = 400;
    throw err;
  }

  const params = new URLSearchParams();
  params.set('q', `title:(${q}) AND mediatype:movies`);
  for (const field of ['identifier', 'title', 'year', 'date', 'creator', 'downloads']) {
    params.append('fl[]', field);
  }
  params.set('rows', '24');
  params.set('page', String(Math.max(1, Number(page) || 1)));
  params.set('output', 'json');

  const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`archive.org search failed (HTTP ${res.status})`);
  const data = await res.json();
  const docs = data.response?.docs || [];
  return docs
    .map((doc) => cleanResult(doc, 'archive.org'))
    .filter((doc) => doc.identifier && doc.title);
}

export function fallbackCatalog() {
  return FALLBACK_CATALOG.map((item) => ({
    identifier: item.identifier,
    title: item.title,
    year: item.year || null,
    creator: item.creator || '',
    downloads: 0,
    thumb: thumbFor(item.identifier),
    url: detailsUrl(item.identifier),
    file: item.file,
    source: 'fallback',
  }));
}

export async function getCatalogItem(identifier) {
  const id = String(identifier || '').trim();
  assertIdentifier(id);

  try {
    const res = await fetch(`${METADATA_URL}${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`archive.org metadata failed (HTTP ${res.status})`);
    const data = await res.json();
    if (!data || !data.metadata || (data.is_dark === true)) {
      const err = new Error('item not found on archive.org');
      err.status = 404;
      throw err;
    }

    const meta = data.metadata;
    const files = (data.files || [])
      .filter((file) => file && isVideoName(file.name))
      .map((file) => ({
        name: file.name,
        size: Number(file.size) || 0,
        format: file.format || '',
        url: encodeFileUrl(id, file.name),
      }))
      .sort((a, b) => b.size - a.size);

    return {
      identifier: id,
      title: firstText(meta.title) || id,
      year: parseYear(meta.year || meta.date),
      creator: firstText(meta.creator),
      description: stripHtml(meta.description),
      thumb: thumbFor(id),
      url: detailsUrl(id),
      files,
      source: 'archive.org',
    };
  } catch (err) {
    const fallback = FALLBACK_CATALOG.find((item) => item.identifier === id);
    if (!fallback) throw err;
    return {
      identifier: id,
      title: fallback.title,
      year: fallback.year || null,
      creator: fallback.creator || '',
      description: '',
      thumb: thumbFor(id),
      url: detailsUrl(id),
      files: [
        {
          name: fallback.file,
          size: fallback.size || 0,
          format: 'MPEG4',
          url: encodeFileUrl(id, fallback.file),
        },
      ],
      source: 'fallback',
    };
  }
}

function allowedArchiveUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'archive.org' || host.endsWith('.archive.org');
}

export async function addDownload(body = {}) {
  if (!libraryRoot) throw new Error('downloads are not initialized');

  const collection = sanitizeSegment(body.collection || 'Downloads', 'Downloads');
  const specs = [];
  let writeMeta = false;
  let identifier = null;
  let catalogItem = null;

  if (body.url) {
    if (!allowedArchiveUrl(body.url)) {
      const err = new Error('only https archive.org download URLs are allowed');
      err.status = 400;
      throw err;
    }
    const pathname = new URL(body.url).pathname;
    const fileName = sanitizeFileName(decodeURIComponent(pathname));
    specs.push({
      url: body.url,
      fileName,
      title: text(body.title) || path.basename(fileName, path.extname(fileName)),
      year: parseYear(body.year),
      identifier: null,
      meta: null,
    });
    writeMeta = true;
  } else {
    identifier = String(body.identifier || '').trim();
    assertIdentifier(identifier);
    catalogItem = await getCatalogItem(identifier);

    const names = Array.isArray(body.files) && body.files.length
      ? body.files
      : body.file
        ? [body.file]
        : catalogItem.files.length === 1
          ? [catalogItem.files[0].name]
          : [];

    if (!names.length) {
      const err = new Error('this item has multiple video files; pass "file" or "files"');
      err.status = 400;
      err.files = catalogItem.files.map((file) => ({ name: file.name, size: file.size }));
      throw err;
    }

    for (const name of names) {
      const file = catalogItem.files.find((candidate) => candidate.name === name);
      if (!file) {
        const err = new Error(`file not found in item: ${name}`);
        err.status = 404;
        err.files = catalogItem.files.map((candidate) => candidate.name);
        throw err;
      }
      specs.push({
        url: file.url,
        fileName: sanitizeFileName(file.name),
        title: text(body.title) || catalogItem.title,
        year: parseYear(body.year) || catalogItem.year,
        identifier,
        meta: catalogItem,
      });
    }
    writeMeta = specs.length === 1;
  }

  const requestedFolder = body.folder ? sanitizeSegment(body.folder, '') : '';
  const autoFolder = !requestedFolder && specs.length > 1
    ? sanitizeSegment(body.title || 'Downloads', 'Downloads')
    : '';
  const folder = requestedFolder || autoFolder;
  const targetDir = folder
    ? path.join(libraryRoot, collection, folder)
    : path.join(libraryRoot, collection);
  await fsp.mkdir(targetDir, { recursive: true });

  const created = [];
  for (const spec of specs) {
    const dest = await uniquePath(targetDir, spec.fileName);
    const job = {
      id: crypto.randomUUID(),
      title: spec.title || path.basename(spec.fileName, path.extname(spec.fileName)),
      fileName: path.basename(dest),
      collection,
      identifier: spec.identifier,
      url: spec.url,
      dest,
      status: 'queued',
      bytes: 0,
      total: 0,
      speed: 0,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      controller: null,
      writeMeta,
      meta: spec.meta,
      poster: writeMeta ? catalogItem?.thumb || null : null,
    };
    jobs.set(job.id, job);
    queue.push(job);
    created.push(publicJob(job));
  }

  pump();
  return created;
}

export async function addSeriesDownload(body = {}) {
  const identifier = String(body.identifier || '').trim();
  assertIdentifier(identifier);

  const item = await getCatalogItem(identifier);
  const available = item.files.map((file) => file.name);
  if (!available.length) {
    const err = new Error('this item has no video files');
    err.status = 404;
    throw err;
  }

  let names = available;
  if (Array.isArray(body.files) && body.files.length) {
    names = body.files;
  }
  if (names.length > 100) {
    const err = new Error('too many files in one series request (max 100)');
    err.status = 400;
    throw err;
  }

  const title = text(body.title) || item.title;
  return addDownload({
    identifier,
    files: names,
    title,
    year: item.year,
    collection: body.collection || 'Series',
    folder: body.folder || title,
  });
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

  const dest = await uniquePath(targetDir, fileName);
  const job = {
    id: crypto.randomUUID(),
    kind: 'hls',
    title,
    fileName: path.basename(dest),
    collection,
    identifier: null,
    source: text(body.source) || 'castle',
    url,
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
    writeMeta: false,
    meta: null,
    poster: text(body.poster) || null,
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

export function getDownload(id) {
  const job = jobs.get(String(id));
  return job ? publicJob(job) : null;
}

export function cancelDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  if (job.status === 'queued') {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.status = 'cancelled';
    job.completedAt = Date.now();
  } else if (job.status === 'downloading' && job.controller) {
    job.status = 'cancelling';
    job.controller.abort();
  }
  return publicJob(job);
}

export function retryDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  if (job.status !== 'failed' && job.status !== 'cancelled') return publicJob(job);
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
    runJob(job)
      .catch(() => {})
      .finally(() => {
        activeCount--;
        pump();
      });
  }
}

async function fetchImage(url, dest) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return false;
    await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

async function writeSidecar(job) {
  if (!job.writeMeta) return;
  const stem = job.dest.slice(0, job.dest.length - path.extname(job.dest).length);
  const item = job.meta;

  if (job.poster) {
    await fetchImage(job.poster, `${stem}-poster.jpg`).catch(() => {});
  }

  const escape = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const title = item?.title || job.title;
  const year = item?.year || null;
  const plot = item?.description || '';
  const director = item?.creator || '';
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<movie>',
    `  <title>${escape(title)}</title>`,
    year ? `  <year>${year}</year>` : null,
    plot ? `  <plot>${escape(plot)}</plot>` : null,
    director ? `  <director>${escape(director)}</director>` : null,
    '</movie>',
    '',
  ].filter(Boolean).join('\n');

  await fsp.writeFile(`${stem}.nfo`, xml, 'utf8').catch(() => {});
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
  if (!job.subtitles?.length) return;
  const stem = job.dest.slice(0, job.dest.length - path.extname(job.dest).length);
  for (const track of job.subtitles) {
    try {
      const res = await fetch(track.url, {
        headers: { 'User-Agent': USER_AGENT, Referer: job.referer || 'https://api.hlowb.com/' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const body = await res.text();
      if (!/^\uFEFF?WEBVTT/.test(body.trimStart())) continue;
      await fsp.writeFile(`${stem}.${track.lang}.vtt`, body, 'utf8');
    } catch {
      /* a missing subtitle should never fail the download */
    }
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
  args.push(
    '-i', job.url,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    part,
  );

  let child = null;
  let stderr = '';
  let timer = null;

  try {
    child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = null;
      await fsp.rm(part, { force: true }).catch(() => {});
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

async function runJob(job) {
  if (job.kind === 'hls') return runHlsJob(job);

  job.status = 'downloading';
  job.startedAt = Date.now();
  const controller = new AbortController();
  job.controller = controller;
  const part = `${job.dest}.part`;

  try {
    let existing = 0;
    try {
      existing = (await fsp.stat(part)).size;
    } catch {
      /* new download */
    }

    const headers = { 'User-Agent': USER_AGENT };
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    const res = await fetch(job.url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok && res.status !== 206) throw new Error(`download failed (HTTP ${res.status})`);
    if (existing > 0 && res.status !== 206) existing = 0;

    const length = Number(res.headers.get('content-length')) || 0;
    job.bytes = existing;
    job.total = existing + length;

    const out = fs.createWriteStream(part, { flags: existing > 0 ? 'a' : 'w' });
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      job.bytes += chunk.length;
      const elapsed = (Date.now() - job.startedAt) / 1000;
      job.speed = elapsed > 0 ? Math.round(job.bytes / elapsed) : 0;
    });

    await pipeline(body, out);

    if (job.total && job.bytes < job.total) {
      throw new Error(`incomplete download (${job.bytes} of ${job.total} bytes)`);
    }

    await fsp.rename(part, job.dest);
    const stat = await fsp.stat(job.dest);
    job.bytes = stat.size;
    job.total = stat.size;
    job.status = 'completed';
    job.completedAt = Date.now();
    job.speed = 0;

    await writeSidecar(job).catch(() => {});
    await onComplete(job).catch(() => {});
  } catch (err) {
    if (controller.signal.aborted) {
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = null;
      await fsp.rm(part, { force: true }).catch(() => {});
    } else {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = err?.message || String(err);
    }
  } finally {
    job.controller = null;
  }
}

export const DOWNLOAD_EXTENSIONS = [...VIDEO_EXTS];
