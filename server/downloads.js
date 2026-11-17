import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { spawnNice } from './proc.js';
import { ensureEnglishSubtitle, retimeEnglishSidecar, vttFromSubtitle } from './subs.js';
import { getDownloadMaxActive, getDownloadLimitMBps, getTorrentQuality, getDownloadStagingDir } from './settings.js';
import { findReleases, rankReleases, magnetFor, releaseLabel } from './torrentio.js';
import {
  fetchTorrentFiles, matchEpisodeFile, downloadTorrentFile,
  probeMedia, pickTracks, remuxToMp4, extractSubtitles, toIso2, timelineIsBroken,
} from './torrent.js';
const USER_AGENT = 'netflix-home/1.0 (local library downloader)';

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.divx',
]);

const jobs = new Map();
const queue = [];
let activeCount = 0;
/* How many transfers run at once comes from Settings (`downloadMaxActive`).
 * Every running job is its own aria2c swarm, and 41 of them at once made this
 * process answer /api/downloads in 46-82 s, so the queue is capped and the
 * extra jobs wait in "queued" until a slot frees up. */
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
/* Finished rows get a second, append-only record. downloads.json is rewritten
 * from memory on every save, so one process that came up with a half-empty job
 * map (or a stray "Cancel all" on a finished card) erased the history while the
 * files sat in the library untouched. The journal is never rewritten, so the
 * rows can be put back. */
const FINISHED_NAME = 'completed.jsonl';
const SAVE_DELAY_MS = 3000;
const HISTORY_LIMIT = 40;
let stateFile = '';
let finishedFile = '';
let saveTimer = null;

export function initDownloads({ root, onDownloadComplete, findDownload = null }) {
  libraryRoot = root;
  onComplete = onDownloadComplete || (async () => {});
  findExisting = typeof findDownload === 'function' ? findDownload : () => null;
  stateFile = path.join(root, '.cache', STATE_NAME);
  finishedFile = path.join(root, '.cache', FINISHED_NAME);
}

/* Terminal jobs are history, not work: keep the last few so the download
 * sheet still lists what finished, and drop the rest. */
function trimHistory() {
  const terminal = [...jobs.values()]
    .filter((job) => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
    .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
  const dropped = terminal.slice(HISTORY_LIMIT);
  for (const job of dropped) jobs.delete(job.id);
  for (const job of dropped) journalFinished({ id: job.id, removed: true });
  /* Finished rows disappearing from the drawer with no explanation is how a
   * "the app lost my downloads" report starts; say it out loud. */
  if (dropped.length) console.log(`[download] trimmed ${dropped.length} finished row(s) from the history (${HISTORY_LIMIT} kept)`);
}

/* ---------- finished-download journal ---------- */

function journalFinished(entry) {
  if (!finishedFile || !entry?.id) return;
  try {
    fs.mkdirSync(path.dirname(finishedFile), { recursive: true });
    fs.appendFileSync(finishedFile, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* History is a convenience; it must never be a reason a download fails. */
  }
}

function rememberFinished(job) {
  journalFinished({
    id: job.id,
    title: job.title,
    dest: job.dest,
    fileName: job.fileName,
    collection: job.collection,
    identifier: job.identifier,
    poster: job.poster,
    source: job.source,
    sourceLabel: job.sourceLabel,
    quality: job.quality,
    season: job.season,
    episode: job.episode,
    bytes: job.bytes,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
  });
}

/* Replay: a later line for the same id wins, `removed` erases it. */
async function readFinished() {
  if (!finishedFile) return [];
  let raw = '';
  try {
    raw = await fsp.readFile(finishedFile, 'utf8');
  } catch {
    return [];
  }
  const alive = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry?.id) continue;
    if (entry.removed) alive.delete(String(entry.id));
    else alive.set(String(entry.id), entry);
  }
  return [...alive.values()];
}

/* The journal only grows while it is replayed; compact it once it is big. */
async function compactFinished(entries) {
  if (!finishedFile) return;
  const stat = await fsp.stat(finishedFile).catch(() => null);
  if (!stat || stat.size < 512 * 1024) return;
  const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  const tmp = `${finishedFile}.tmp`;
  try {
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, finishedFile);
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

function snapshot() {
  trimHistory();
  const list = [];
  for (const job of jobs.values()) {
    const copy = {};
    for (const [key, value] of Object.entries(job)) {
      /* Runtime handles cannot be serialized; everything else is plain data.
       * `slot` is live queue accounting: a restored job takes a fresh slot when
       * it starts, and a stale `true` would make takeSlot() skip it. */
      if (key === 'controller' || key === 'ffmpeg' || key === 'slot') continue;
      copy[key] = value;
    }
    /* Position in the waiting line, so a promoted job comes back in front. */
    copy.queuePos = queue.indexOf(job);
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
  /* Two homes now: the old one beside the library and, when a scratch folder is
   * configured, that one. Leftovers in either are still leftovers. */
  const bases = new Set([path.join(libraryRoot, '.cache', 'torrent')]);
  if (getDownloadStagingDir()) bases.add(stagingBase());
  const keep = new Set();
  for (const job of jobs.values()) {
    if (job.kind !== 'torrent') continue;
    if (job.status === 'queued' || job.status === 'paused' || job.status === 'downloading') {
      keep.add(job.id.toLowerCase());
    }
  }
  /* Another live instance (the deployed EXE and its dev server can share the
   * library) may own a temp folder. Its child processes name the folder - and
   * the folder is the job id - so any command line carrying that id keeps it. */
  const commands = (await listChildProcesses())
    .filter((row) => isPidAlive(Number(row?.ParentProcessId) || 0))
    .map((row) => String(row?.CommandLine || '').toLowerCase());

  let removed = 0;
  for (const base of bases) {
    let entries;
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const id = entry.name.toLowerCase();
      if (!entry.isDirectory() || keep.has(id)) continue;
      if (commands.some((command) => command.includes(id))) continue;
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
  rememberFinished(job);
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

  /* Put back finished rows the queue file lost. The file is rewritten from
   * memory, so a process that came up without them (or a stray group "Cancel
   * all" on a finished card) erased the drawer history while the episodes
   * stayed on disk. The journal is append-only; a tombstone is written when a
   * row is removed on purpose, so this never resurrects a dismissed row. */
  finishedFile ||= path.join(libraryRoot, '.cache', FINISHED_NAME);
  const journal = await readFinished();
  for (const entry of journal) {
    const id = String(entry.id);
    if (jobs.has(id)) continue;
    const dest = String(entry.dest || '');
    const stat = dest ? await fsp.stat(dest).catch(() => null) : null;
    if (!stat?.isFile() || !stat.size) continue;
    const job = {
      ...entry,
      id,
      kind: 'torrent',
      status: 'completed',
      stage: 'done',
      dest,
      bytes: stat.size,
      total: stat.size,
      progressValue: 1,
      speed: 0,
      error: null,
      controller: null,
      ffmpeg: null,
      failures: [],
      completedAt: Number(entry.completedAt) || stat.mtimeMs,
      createdAt: Number(entry.createdAt) || stat.mtimeMs,
      restoredFromJournal: true,
    };
    jobs.set(id, job);
    restored.push(job);
  }
  const recovered = restored.filter((job) => job.restoredFromJournal).length;
  if (recovered) console.log(`[download] recovered ${recovered} finished row(s) from the journal`);
  await compactFinished(journal);

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
        rememberFinished(job);
        continue;
      }
    }
    const partial = job.part || (job.dest ? `${job.dest}.part` : '');
    if (partial) await fsp.rm(partial, { force: true }).catch(() => {});
    job.part = '';
    if (job.dest) await fsp.rm(`${job.dest}.part`, { force: true }).catch(() => {});
  }

  await sweepTorrentTempDirs();

  /* The saved state lists jobs in the order they were created, which is not the
   * order they were waiting in: a promoted job (POST /api/downloads/:id/first)
   * sat at the front of the queue but came back behind ninety older ones after
   * a restart. `queuePos` is written with each snapshot, so the waiting order
   * survives; a job without one keeps its saved position at the end. */
  const waiting = restored.filter((job) => job.status === 'queued');
  const pos = (job) => (Number.isInteger(job.queuePos) && job.queuePos >= 0 ? job.queuePos : Number.MAX_SAFE_INTEGER);
  waiting.sort((a, b) => pos(a) - pos(b));
  for (const job of waiting) {
    delete job.queuePos;
    queue.push(job);
  }
  trimHistory();
  const restoredQueued = restored.filter((job) => job.status === 'queued').length;
  const restoredPaused = restored.filter((job) => job.status === 'paused').length;
  if (online) pump();
  scheduleSave(0);

  if (restored.length) {
    const byStatus = {};
    for (const job of restored) byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    console.log(`[download] restored ${restored.length} job(s), ${restoredQueued} queued, ${restoredPaused} paused - ${JSON.stringify(byStatus)}`);
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
    /* The drawer heads every group with the show's own art, so the poster the
     * download was started with travels with the job. */
    poster: job.poster || '',
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
/* The two qualities the downloader understands. A 4K file is 4-7x the size of
 * a 1080p one on most swarms, so the choice is a setting, not a guess. */
const TORRENT_QUALITIES = new Set(['1080p', '2160p']);
/* An episode above this is a multi-hour download on a home line; prefer any
 * normal-sized release that the ranking already finds acceptable. A movie is
 * naturally bigger, so it gets a wider band. */
const MAX_EPISODE_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_MOVIE_BYTES = 6 * 1024 * 1024 * 1024;

/* Torrentio tags most releases with the audio languages they ship, and those
 * tags are the only thing known before the download starts. A tagged release
 * must list the show's original language and English; an untagged one is kept
 * and verified by ffprobe after the download. */
function declaresLanguages(release) {
  return Array.isArray(release.languages) && release.languages.length > 0;
}

function pad2(value) {
  return String(Math.max(0, Number(value) || 0)).padStart(2, '0');
}

/* Same naming pattern the Castle download uses, so one series never ends up
 * with two files for the same episode. */
function torrentFileName(job, quality, extension = '.mp4') {
  if (job.season > 0) {
    return `${job.seriesTitle} S${pad2(job.season)}E${pad2(job.episode)} ${quality}${extension}`;
  }
  return `${job.seriesTitle}${job.year ? ` (${job.year})` : ''} ${quality}${extension}`;
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
export async function planTorrentRelease({ imdbId, season = 0, episode = 0, originalLanguage = '', copyVideo = false, quality = '' } = {}) {
  if (!/^tt\d{4,10}$/.test(String(imdbId || '').trim())) return null;

  const streams = await findReleases({ imdbId: String(imdbId).trim(), isSeries: Number(season) > 0, season, episode });
  if (!streams.length) return null;
  /* The settings switch is a hard rule, not a preference: 1080p never takes a
   * 4K file and 2160p never takes a 1080p one. `quality` lets a caller (the
   * release inspector, a test) ask for one explicitly. */
  const wantedQuality = TORRENT_QUALITIES.has(quality) ? quality : getTorrentQuality();
  const ranked = rankReleases(streams, { originalLanguage: text(originalLanguage), copyVideo: copyVideo === true, quality: wantedQuality });
  if (!ranked.length) return null;

  /* The rule is hard on the *evidence*: a release that lists a language set
   * without the show's original audio or without English is never downloaded -
   * an Italian-only rip of a Thai show, or a French dub of a Korean show, would
   * only waste the download. Dual audio is the one exception, because its tag
   * list is unreliable (see below). Releases that declare nothing are kept
   * because Torrentio often has no tags at all (RARBG packs, for one); ffprobe
   * decides those after the download (pickTracks). Releases that do declare
   * both are tried first, since the evidence is already there. */
  const originalIso = toIso2(originalLanguage) || '';
  const contradicts = (release) => {
    const declared = Array.isArray(release.languages) ? release.languages : [];
    if (!declared.length) return false;
    /* A dual-audio release that declares English is kept even when it does not
     * name the original language. Anime rips tag only "en" for a file that
     * really carries jpn + eng, so the tag alone was throwing away the releases
     * whose audio is AAC - exactly the ones the browser can keep untouched
     * instead of paying a 200 s re-encode. pickTracks still rejects the file
     * after the probe when the original track is missing, and the job moves on
     * to the next candidate. A single-audio English dub of a non-English show
     * is still dropped here. */
    if (originalIso && !declared.includes(originalIso) && release.dualAudio !== true) return true;
    return !declared.includes('en');
  };
  const eligible = ranked.filter((release) => !contradicts(release));
  if (!eligible.length) {
    return {
      release: null,
      candidates: [],
      reason: `none of the ${ranked.length} release${ranked.length === 1 ? '' : 's'} carries the original audio and an English dub`,
    };
  }
  const declared = eligible.filter(declaresLanguages);
  const untagged = eligible.filter((release) => !declaresLanguages(release));
  const pool = [...declared, ...untagged];

  /* `wantedQuality` is the floor and the ceiling at once: a 1080p setting
   * keeps files small, a 2160p setting takes only 4K copies. A sane file size
   * still beats a 29 GiB season pack: the click should fetch one episode, not
   * hours of someone else's season. A giant file of the chosen quality still
   * stays ahead of any pack, because a pack is the less predictable download. */
  const limit = Number(season) > 0 ? MAX_EPISODE_BYTES : MAX_MOVIE_BYTES;
  const hd = pool.filter((release) => release.quality === wantedQuality);
  if (!hd.length) {
    return { release: null, candidates: [], reason: `no ${wantedQuality} release is left after the audio filter` };
  }
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
    copyVideo: body.copyVideo === true,
  });
  if (!plan) return null;
  const candidates = plan.candidates;
  if (!candidates.length) {
    /* Every release was filtered out before a download started: no original
     * audio, or no English dub. The caller turns this into an explicit
     * "unavailable" answer instead of queueing something that cannot satisfy
     * the rule. */
    return { count: 0, jobs: [], unavailable: plan.reason || 'no qualifying release', source: 'torrentio' };
  }

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

  /* The same episode must not be queued twice. A season row that was clicked
   * again, or a batch that was re-sent, used to add a second job for an episode
   * that was already waiting; both then downloaded the same release into two
   * folders and the drawer listed the episode twice. */
  const twin = [...jobs.values()].find((other) => (
    other.status !== 'cancelled'
    && other.status !== 'failed'
    && other.kind === 'torrent'
    && String(other.identifier || '') === String(imdbId || '')
    && Number(other.season) === season
    && Number(other.episode) === episode
  ));
  if (twin) {
    return {
      count: 0,
      jobs: [],
      skipped: [{ fileName: twin.fileName || fileName, id: twin.id, title: twin.title }],
      source: 'torrentio',
      quality: twin.quality || top.quality,
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
    /* The client decodes HEVC in hardware, so the remux can copy the video
     * instead of spending two minutes of GPU on it. `mkv` says it also opens
     * Matroska, which is what allows keeping the release file untouched. */
    copyVideo: body.copyVideo === true,
    mkv: body.mkv !== false,
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

/* ---------- transfer scratch folder ----------
 *
 * Everything a transfer writes (aria2 pieces, the remuxed copy, the HLS
 * capture) goes here first. Without a scratch folder that is `.cache\torrent`
 * beside the library: the finished file is then a rename onto itself and the
 * copy costs nothing. With one configured the swarm writes on that disk, and
 * the finished file is copied to the library once, paced, so a 4K release
 * cannot make the library drive unusable while someone is watching.
 */
function stagingBase() {
  const scratch = getDownloadStagingDir();
  if (!scratch) return path.join(libraryRoot, '.cache', 'torrent');
  return path.join(scratch, 'netflix-home');
}

function torrentTempDir(job) {
  if (job?.localStaging) return path.join(libraryRoot, '.cache', 'torrent', job.id);
  return path.join(stagingBase(), job.id);
}

/* Where an HLS capture is written before it is installed. */
function stagingPartFile(job) {
  if (job.localStaging || !getDownloadStagingDir()) return `${job.dest}.part`;
  return path.join(stagingBase(), `${job.id}.install.mp4`);
}

/* 32 MB/s is faster than any 4K playback reads and slow enough that the drive
 * still answers seeks, thumbnails and the library scan while the copy runs. */
const COPY_RATE_BYTES = 32 * 1024 * 1024;
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

/* Does the scratch drive hold this release (plus room for the remux)? A disk
 * that cannot take it falls back to the library temp folder instead of filling
 * up and failing the job halfway. */
async function stagingFits(neededBytes) {
  if (!(Number(neededBytes) > 0)) return true;
  try {
    const stat = await fsp.statfs(path.parse(stagingBase()).root || stagingBase());
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (!free) return true;
    return free > Number(neededBytes) * 1.1 + 512 * 1024 * 1024;
  } catch {
    return true;
  }
}

/* Install a finished file. Same volume: a rename, exactly as before. Across
 * volumes (scratch folder on another disk) a paced copy, reported as a stage so
 * the drawer says why the row is at 97% with no swarm left. */
async function slowMove(from, to, { onStart, onProgress } = {}) {
  try {
    await fsp.rename(from, to);
    return;
  } catch (err) {
    /* EXDEV is the honest cross-volume answer; Windows also refuses some
     * renames with EPERM when a share or the scanner holds the target. */
    if (err?.code !== 'EXDEV' && err?.code !== 'EPERM') throw err;
  }
  const total = (await fsp.stat(from)).size;
  await fsp.mkdir(path.dirname(to), { recursive: true });
  onStart?.();
  const reader = fs.createReadStream(from, { highWaterMark: COPY_CHUNK_BYTES });
  const writer = fs.createWriteStream(to, { highWaterMark: COPY_CHUNK_BYTES });
  const startedAt = Date.now();
  let moved = 0;
  try {
    for await (const chunk of reader) {
      if (!writer.write(chunk)) {
        await new Promise((resolve, reject) => {
          writer.once('drain', resolve);
          writer.once('error', reject);
        });
      }
      moved += chunk.length;
      onProgress?.(moved, total);
      /* Pace the copy: sleep whatever this chunk was faster than the cap. */
      const targetMs = (moved / COPY_RATE_BYTES) * 1000;
      const spentMs = Date.now() - startedAt;
      if (targetMs > spentMs) {
        await new Promise((resolve) => setTimeout(resolve, targetMs - spentMs));
      }
    }
    await new Promise((resolve, reject) => {
      writer.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    reader.destroy();
    writer.destroy();
    await fsp.rm(to, { force: true }).catch(() => {});
    throw err;
  }
  await fsp.rm(from, { force: true }).catch(() => {});
}

/* Marks the copy phase, so the drawer can label the pause between "swarm
 * finished" and "file is in the library". */
function copyStage(job) {
  return {
    onStart: () => {
      job.stage = 'moving';
      job.progressValue = 0.97;
      scheduleSave(0);
    },
    onProgress: (moved, total) => {
      if (total > 0) job.progressValue = 0.97 + Math.min(0.02, (moved / total) * 0.02);
      scheduleSave();
    },
  };
}

export function listDownloads() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicJob);
}

export function cancelDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;

  /* Deleting a multi-GB folder takes seconds and can fail while aria2c still
   * holds a handle, so it runs in the background: the caller and the UI get an
   * answer at once, which is what "cancel" has to feel like. Windows releases
   * the file a moment after the process is killed, hence the retries. */
  const removePart = async () => {
    // `job.part` can be an ffmpeg output that is not `<dest>.part`; both must go.
    const partials = new Set();
    if (job.dest) partials.add(`${job.dest}.part`);
    if (job.part) partials.add(String(job.part));
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        for (const partial of partials) await fsp.rm(partial, { force: true });
        if (job.kind === 'torrent') {
          await fsp.rm(torrentTempDir(job), { recursive: true, force: true });
        }
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  };

  /* A cancelled job is gone for good: drop it from the list right away. */
  const forget = () => {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.status = 'cancelled';
    job.completedAt = Date.now();
    job.speed = 0;
    jobs.delete(job.id);
    scheduleSave(0);
  };

  /* A failed transfer is unfinished: the X clears the bytes it left behind. */
  if (job.status === 'failed') {
    void removePart();
    forget();
    return { id: job.id, status: 'cancelled', removed: true };
  }

  /* A finished download is no longer a transfer. Removing its row keeps the
   * file and the library entry; only the notification goes away. */
  if (job.status === 'completed') {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    jobs.delete(job.id);
    journalFinished({ id: job.id, removed: true });
    console.log(`[download] removed the finished row for "${job.title || job.fileName || job.id}" (file kept)`);
    scheduleSave(0);
    return { id: job.id, status: job.status, removed: true, kept: true };
  }

  if (job.status === 'queued' || job.status === 'paused') {
    void removePart();
    forget();
    return { id: job.id, status: 'cancelled', removed: true };
  }

  if (job.status === 'downloading' || job.status === 'cancelling') {
    try { job.controller?.abort(); } catch { /* already gone */ }
    if (job.ffmpeg) killTree(job.ffmpeg);
    void removePart();
    forget();
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
 * Move a waiting job to the head of the queue. The shows Yassine asked for
 * should not wait behind a hundred season-pack episodes; a job that is already
 * running is left alone. Paused jobs stay paused.
 */
export function promoteDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  if (job.status !== 'queued') return publicJob(job);
  const index = queue.indexOf(job);
  if (index > 0) {
    queue.splice(index, 1);
    queue.unshift(job);
    scheduleSave(0);
  }
  pump();
  return publicJob(job);
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
  job.refreshCandidates = job.kind === 'torrent';
  if (Array.isArray(job.failures)) job.failures.length = 0;
  job.resumed = false;
  queue.push(job);
  scheduleSave(0);
  pump();
  return publicJob(job);
}

/* A slot is a *transfer*, not a whole job. The cap exists because every running
 * job is its own aria2c swarm, and a job that is only verifying, remuxing or
 * fetching subtitles holds no swarm. Releasing the slot the moment the file is
 * on disk lets the next queued episode start downloading instead of waiting out
 * a 200 s audio re-encode, and the remux itself is already serialized by the
 * media lane in proc.js. */
function takeSlot(job) {
  if (job.slot) return;
  job.slot = true;
  activeCount++;
}

function releaseSlot(job) {
  if (!job.slot) return;
  job.slot = false;
  activeCount = Math.max(0, activeCount - 1);
  pump();
}

function pump() {
  const cap = Math.max(1, getDownloadMaxActive());
  while (activeCount < cap && queue.length) {
    const job = queue.shift();
    takeSlot(job);
    const task = job.kind === 'torrent' ? runTorrentJob(job) : runHlsJob(job);
    task
      .catch(() => {})
      .finally(() => releaseSlot(job));
  }
}

/* Re-run the queue after the cap or the speed limit changed in Settings: a
 * higher cap starts the waiting jobs immediately, a lower one lets the running
 * transfers finish and starts nothing new until the count drops. */
export function applyDownloadLimits() {
  pump();
  return listDownloads();
}

/* Speed share for one torrent, in KiB/s: the configured cap (0 = unlimited)
 * divided by the torrents that are really transferring right now. Called from
 * each transfer's progress poll, so a job that finishes hands its share to the
 * survivors without a restart. */
function torrentLimitKbps() {
  const totalMBps = getDownloadLimitMBps();
  if (!(totalMBps > 0)) return 0;
  let transfers = 0;
  for (const job of jobs.values()) {
    if (job.status === 'downloading' && job.kind === 'torrent') transfers += 1;
  }
  const bytesPerSec = (totalMBps * 1024 * 1024) / Math.max(1, transfers);
  /* 32 KiB/s floor: a share smaller than that would stall the swarm long
   * enough for the slow-torrent check to give up on it. */
  return Math.max(32, Math.round(bytesPerSec / 1024));
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
  let englishFromText = false;
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
        /* Castle ships WebVTT; other providers also hand out SRT and the
         * SubStation Alpha files anime releases use. Only a payload that is
         * none of those is a bad link, not a subtitle. */
        const head = raw.replace(/^\uFEFF/, '').trimStart();
        if (!/^WEBVTT/.test(head) && !/-->/.test(head) && !/^\[Script Info\]/i.test(head) && !/^\s*Dialogue\s*:/im.test(head)) continue;
        body = vttFromSubtitle(raw);
      }
      if (!body || body.length < 20) continue;
      await fsp.writeFile(`${stem}.${track.lang}.vtt`, body, 'utf8');
      if (track.lang === 'en') {
        wroteEnglish = true;
        englishFromText = Boolean(track.text);
      }
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
  } else if (englishFromText) {
    /* The catalogue path fetches an English track before the video exists, so
     * it can only rank by length. Now the file is here: let the cut check pick
     * the track that is timed to this edit. */
    await ensureEnglishSubtitle(job.dest, {
      seriesTitle: job.seriesTitle || job.title,
      title: job.title,
      season: job.season,
      episode: job.episode,
      isSeries: Number(job.season) > 0,
    }, { force: true }).catch(() => {});
  }
}

/* ffmpeg honours HTTP_PROXY, and this machine's proxy truncates long HLS
 * segment connections: the muxer receives corrupt packets and dies partway
 * through a download. The CDN answers directly, so keep the proxy for every
 * other host and exempt this URL's domain for the child. */
function hlsEnv(url) {
  const env = { ...process.env };
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/^\d+(\.\d+){3}$/.test(host)) return env;
    const parts = host.split('.');
    const domain = parts.length > 2 ? parts.slice(-2).join('.') : host;
    const current = String(env.NO_PROXY || env.no_proxy || '');
    env.NO_PROXY = [current, host, domain].filter(Boolean).join(',');
    delete env.no_proxy;
  } catch {
    /* an unparsable URL still goes through the normal proxy path */
  }
  return env;
}

async function runHlsJob(job) {
  job.status = 'downloading';
  job.startedAt = Date.now();
  scheduleSave(0);
  const controller = new AbortController();
  job.controller = controller;
  if (getDownloadStagingDir() && !job.localStaging && !(await stagingFits(Number(job.total) || 0))) {
    job.localStaging = true;
    console.warn(`[download] ${job.title}: ${getDownloadStagingDir()} does not have room for this release; downloading beside the library instead`);
  }
  const part = stagingPartFile(job);
  job.part = part;

  await fsp.mkdir(path.dirname(part), { recursive: true }).catch(() => {});
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
    child = spawnNice(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: hlsEnv(job.url),
    });
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

    await slowMove(part, job.dest, copyStage(job));
    job.part = '';
    job.stage = 'done';
    job.bytes = stat.size;
    job.total = stat.size;
    job.speed = 0;
    job.status = 'completed';
    job.completedAt = Date.now();
    rememberFinished(job);
    scheduleSave(0);
    await onComplete(job).catch(() => {});
    /* Subtitles (and the English lookup behind them) are network work: the
     * episode is finished without them, so they never hold the row. */
    void saveSubtitle(job).catch(() => {});
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
  /* A resumed job keeps the bytes it already has. The folder still holds the
   * pieces and aria2 continues from its own control file, so zeroing these
   * numbers made a half-downloaded episode jump back to 0 %. */
  const resuming = job.release?.name === release.name && Number(job.bytes) > 0;
  job.release = release;
  job.quality = release.quality;
  job.seeders = release.seeders;
  job.sourceLabel = releaseLabel(release);
  job.stage = 'metadata';
  if (!resuming) {
    job.bytes = 0;
    job.progressValue = 0.01;
    job.total = Number(release.sizeBytes) || 0;
  }
  job.speed = 0;
  scheduleSave(0);

  const magnet = magnetFor(release);
  let file = null;
  try {
    const files = await fetchTorrentFiles(magnet, { dir, signal: controller.signal });
    file = matchEpisodeFile(files, release.fileName, { season: job.season, episode: job.episode });
  } catch (err) {
    if (controller.signal.aborted) return 'aborted';
    return `${release.name}: ${err?.message || err}`;
  }
  if (!file) return `${release.name}: episode file is not in this torrent`;

  job.stage = 'downloading';
  job.total = Number(file.size) || job.total;
  /* Bytes left over from a different file in this release cannot be shown
   * against this file's size. */
  if (Number(job.bytes) > job.total) job.bytes = 0;
  if (resuming && job.total) {
    job.progressValue = Math.min(0.8, (job.bytes / job.total) * 0.8);
  }
  scheduleSave(0);
  /* A retry after a failed remux starts a new transfer, and the slot was handed
   * back when the previous download finished. Re-taking it here (a no-op while
   * the job still holds one) keeps the swarm count honest. */
  takeSlot(job);
  let downloaded;
  try {
    downloaded = await downloadTorrentFile({
      magnet,
      file,
      dir,
      total: Number(file.size) || 0,
      signal: controller.signal,
      limitKbps: torrentLimitKbps,
      onProgress: ({ bytes, total, speed }) => {
        const size = Number(total) || job.total || 0;
        if (size > 0) job.total = size;
        /* Piece granularity can make aria2 report a little more than the file
         * holds; showing "11 GB of 2.3 GB" was the old bar doing exactly that. */
        job.bytes = size > 0 ? Math.min(Number(bytes) || 0, size) : (Number(bytes) || 0);
        /* aria2 reports the live transfer rate; a zero means it is waiting on
         * peers, which is worth showing instead of a stale average. */
        job.speed = Number(speed) || 0;
        job.progressValue = job.total ? Math.min(0.8, (job.bytes / job.total) * 0.8) : 0;
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
  /* The swarm is gone: this job is now pure local work (probe, remux, subtitles)
   * and must not keep the next episode waiting for a transfer slot. */
  releaseSlot(job);

  job.stage = 'verifying';
  job.progressValue = 0.82;
  scheduleSave(0);
  const probe = await probeMedia(downloaded.path);
  const picked = pickTracks(probe, {
    originalLanguage: job.originalLanguage,
    copyVideo: job.copyVideo === true,
    mkv: job.mkv !== false,
  });
  if (picked.error) return `${release.name}: ${picked.reason || picked.error}`;
  /* A copy keeps the release's packet timeline, and Chromium drops a fifth of
   * the frames on a timeline that repeats timestamps. Re-encoding rebuilds the
   * timeline from the decoded frames, so such a release is never installed as a
   * copy - it becomes a normal H.264 transcode instead. */
  if (!picked.video?.transcode && await timelineIsBroken(downloaded.path, probe.video?.hasBFrames)) {
    picked.video = { ...picked.video, transcode: true };
    picked.direct = false;
    picked.warnings = [...(picked.warnings || []), 'the release timeline repeats timestamps; re-encoding rebuilds it'];
  }
  /* An acceptance has a reason too ("untagged audio, taken as English"), and
   * the log is where a later "why did it keep that file" question gets answered. */
  if (picked.warnings?.length) {
    console.log(`[download] ${job.title}: ${picked.warnings.join('; ')}`);
  }

  const quality = qualityFromHeight(probe.video?.height, probe.video?.width) || release.quality;
  job.quality = quality;
  /* `direct` means the file already is what the browser wants: no video
   * transcode and the track it will play first is AAC. The container is kept,
   * so the "remux" below is a rename instead of a 6.8-28.6 s rewrite. */
  const direct = picked.direct === true;
  const extension = direct ? (path.extname(downloaded.path).toLowerCase() || '.mkv') : '.mp4';
  job.fileName = sanitizeFileName(torrentFileName(job, quality, extension));
  const dest = await uniquePath(job.targetDir, job.fileName);
  /* With a scratch folder the remux lands beside the downloaded pieces and the
   * finished file is copied to the library once; without one, next to its
   * destination like before. */
  const scratch = getDownloadStagingDir() && !job.localStaging;
  const part = scratch ? path.join(dir, `install${extension}`) : `${dest}.part`;
  const durationSec = Number(probe.durationSec) || 0;

  /* With the video copied the job only re-encodes the audio track: calling that
   * "Remuxing to MP4" made a pure container rewrite look like a video
   * transcode. The drawer names the phase that is really running. */
  job.stage = direct ? 'installing' : (picked.video?.transcode ? 'remuxing' : 'converting');
  job.progressValue = direct ? 0.97 : 0.84;
  job.part = part;
  scheduleSave(0);
  await fsp.rm(part, { force: true }).catch(() => {});
  const remuxStartedAt = Date.now();

  /* Embedded tracks have to be read from the downloaded file while it still
   * exists. The job deletes its torrent folder in `finally` as soon as the
   * episode is installed, so the old fire-and-forget pass ran against a folder
   * that was already gone: every remuxed episode reported "wrote 0 of 30" and
   * fell back to a single online English track. The demux runs beside the
   * remux (both only read the file) and the .vtt files are moved next to the
   * episode after it lands. A `direct` job keeps the source as the episode, so
   * its tracks are read from the installed file instead. */
  const subtitleWork = !direct && picked.subtitles?.length
    ? extractSubtitles({
      input: downloaded.path,
      outStem: path.join(dir, 'subs'),
      subtitles: picked.subtitles,
    }).catch(() => [])
    : null;

  try {
    if (!direct) {
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
    }
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
    console.log(direct
      ? `[download] ${job.title}: kept ${probe.video?.codec || 'video'}+aac as ${extension} in ${seconds.toFixed(1)} s (no conversion, ${speed})`
      : `[download] ${job.title}: remuxed ${(durationSec / 60).toFixed(0)} min to ${probe.video?.transcode ? 'H.264' : (probe.video?.codec || 'video').toUpperCase()} in ${seconds.toFixed(1)} s (${speed})`);
  }

  /* Install the episode before touching subtitles. A season pack carries 30+
   * subtitle tracks; one unreadable stream made the old extraction loop spend
   * up to a minute per track while the drawer sat at 97 % "Extracting
   * subtitles" on a video that was already whole. The episode is playable
   * without them, so it is completed here and the tracks follow in the
   * background (see finishSubtitles). */
  if (direct) await slowMove(downloaded.path, dest, copyStage(job));
  else await slowMove(part, dest, copyStage(job));
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
  rememberFinished(job);
  scheduleSave(0);
  await onComplete(job).catch(() => {});

  /* Embedded tracks live in the downloaded file, not in the MP4 that was just
   * written: a remux keeps video and audio only. The demux started before the
   * remux, so its files only need moving into the library here. */
  let tracks = [];
  if (subtitleWork) {
    const prepared = await subtitleWork;
    const stem = dest.slice(0, dest.length - path.extname(dest).length);
    for (const track of prepared) {
      const next = `${stem}.${track.lang}.vtt`;
      await fsp.rm(next, { force: true }).catch(() => {});
      const moved = await fsp.rename(track.path, next).then(() => true).catch(() => false);
      if (moved) tracks.push({ ...track, path: next });
    }
    job.subtitles = tracks.map((track) => track.lang);
    scheduleSave(0);
    if (tracks.length) {
      console.log(`[download] ${job.title}: ${tracks.length} subtitle track${tracks.length === 1 ? '' : 's'} written next to the episode`);
    } else if (picked.subtitles.length) {
      console.warn(`[download] ${job.title}: could not read the ${picked.subtitles.length} embedded subtitle track(s)`);
    }
  }
  void finishSubtitles(job, dest, picked.subtitles, subtitleWork ? tracks : null);
  return 'done';
}

/**
 * Subtitle tracks for an installed episode. `prepared` carries the tracks that
 * were already extracted from the source (remux jobs); without it the file is
 * read directly, which works because a `direct` job keeps the source as the
 * episode. Best effort: failures leave the video and the job as they were.
 */
async function finishSubtitles(job, dest, subtitles, prepared = null) {
  const stem = dest.slice(0, dest.length - path.extname(dest).length);
  let tracks = Array.isArray(prepared) ? prepared : [];
  if (!Array.isArray(prepared)) {
    try {
      tracks = await extractSubtitles({ input: dest, outStem: stem, subtitles });
    } catch {
      tracks = [];
    }
    job.subtitles = tracks.map((track) => track.lang);
    scheduleSave(0);
  }
  if (!tracks.some((track) => track.lang === 'en')) {
    /* Subtitles are the third half of the rule: embedded English, or an
     * OpenSubtitles track. A failed fetch is said out loud instead of being
     * swallowed - the episode is kept (the video and audio already passed),
     * but the drawer should not pretend an English track is there. */
    const added = await ensureEnglishSubtitle(dest, {
      /* The job already knows which title it downloaded: hand the id over so a
       * bare name like "Mousetrap" cannot resolve to another show. */
      imdbId: job.identifier,
      seriesTitle: job.seriesTitle || job.title,
      title: job.title,
      season: job.season,
      episode: job.episode,
      year: job.year,
      isSeries: job.season > 0,
    }).catch(() => false);
    if (!added) {
      console.warn(`[download] ${job.title}: no English subtitle track could be added; the episode plays without subtitles`);
    }
  }
  /* A release can carry an English track timed to a different cut than the
   * video it ships in - a 23.976 fps subtitle inside a 25 fps PAL transfer
   * drifts minutes by the end. The companion tracks of the same release are
   * timed for this file, so they measure the correction; a track that is
   * already right scores well where it stands and is left alone. Every
   * download goes through here, so no title needs a manual repair. */
  const fit = await retimeEnglishSidecar(stem, tracks, { full: dest }).catch(() => null);
  if (fit) {
    const shift = `${fit.offset >= 0 ? '+' : ''}${fit.offset.toFixed(1)} s`;
    console.log(`[subs] ${path.basename(dest)}: English track retimed to the video (x${fit.slope.toFixed(4)}, ${shift}, ${fit.hits}/${fit.total} cues match the ${fit.lang} track)`);
  }
}

async function runTorrentJob(job) {
  job.status = 'downloading';
  job.startedAt = Date.now();
  job.error = null;
  const controller = new AbortController();
  job.controller = controller;
  scheduleSave(0);
  /* A scratch disk that cannot hold this release would fail the job halfway
   * through. Take the library drive instead, out loud. */
  if (getDownloadStagingDir() && !job.localStaging && !(await stagingFits(Number(job.total) || 0))) {
    job.localStaging = true;
    console.warn(`[download] ${job.title}: ${getDownloadStagingDir()} does not have room for this release; downloading beside the library instead`);
  }
  const dir = torrentTempDir(job);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});

  /* Retry asks the ranking again: a release that was outside the old candidate
   * list (or a swarm that recovered since) deserves another look. */
  if (job.refreshCandidates) {
    job.refreshCandidates = false;
    const plan = await planTorrentRelease({
      imdbId: job.identifier,
      season: job.season,
      episode: job.episode,
      originalLanguage: job.originalLanguage,
      copyVideo: job.copyVideo === true,
    }).catch(() => null);
    if (plan?.candidates?.length) {
      job.candidates = plan.candidates;
      job.attempt = 0;
    }
  }

  const failures = Array.isArray(job.failures) ? job.failures : (job.failures = []);
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  /* A transfer restored after a crash is attempted once with its old pieces.
   * If that cannot finish, the same release gets one clean start. */
  const resumed = Boolean(job.resumed);
  job.resumed = false;
  let retriedIndex = -1;
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

      /* A failure inside the transfer is often transient: the client was
       * killed, the swarm hiccupped, the disk stalled. The first retry keeps
       * every verified piece and continues at the byte it stopped on. Only if
       * that fails again is the folder wiped and the release tried clean; after
       * that it moves on. Wiping on the first failure was what turned one bad
       * minute into an endless "restarting this release" loop. */
      /* aria2 refuses to touch a payload whose .aria2 control file is gone, and
       * a path it cannot open or create will fail the same way every time.
       * Those two go straight to the clean folder instead of burning a retry. */
      const needsClean = /control file\(\*\.aria2\) does not exist|Failed to open the file|Failed to make the directory/i.test(outcome);
      if (retrySame && !needsClean && retriedIndex !== index) {
        retriedIndex = index;
        if (Number(job.bytes) > 0) {
          console.warn(`[download] ${job.title}: retrying this release with its saved pieces`);
          index--;
          continue;
        }
      }
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
    /* A paused job stays paused and a cancelled one is already gone from the
     * list; neither may be rewritten as "failed" by the abort that stopped it. */
    if (job.status === 'paused') {
      job.stage = '';
      job.speed = 0;
      scheduleSave(0);
      return;
    }
    if (job.status === 'cancelled') return;
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

