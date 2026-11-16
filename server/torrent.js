import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { run, spawnNice, spawnMedia } from './proc.js';

const ffprobePath = ffprobeStatic.path;

/**
 * BitTorrent acquisition layer.
 *
 * A magnet download has three phases:
 *
 *   1. metadata  - aria2c fetches only the .torrent, then `--show-files` turns
 *                  that into the numbered file table the UI picks an episode
 *                  from. No payload is transferred.
 *   2. download  - aria2c downloads exactly one file index.
 *   3. remux     - one ffmpeg pass copies (or transcodes) the video, keeps an
 *                  AAC track as it is and re-encodes the rest to AAC 5.1/stereo,
 *                  so browsers can play the result. Subtitle streams are pulled
 *                  out as sidecar WebVTT files.
 *
 * aria2c is bundled next to the EXE; ffmpeg/ffprobe come from the same static
 * packages the Castle downloader uses. Every child goes through proc.js, so it
 * runs below normal priority and never competes with playback.
 */

/* aria2c writes its console progress with \r; nothing here parses it. File
 * size polling is steadier across versions than the text output. */
const MAX_CAPTURE = 64 * 1024;
const METADATA_TIMEOUT_MS = 120000;
const SHOW_FILES_TIMEOUT_MS = 30000;
/* aria2c reports per-piece completion, so a slow swarm that keeps delivering
 * pieces never looks stalled; this only catches a download that has gone
 * quiet altogether. */
const STALL_TIMEOUT_MS = 180000;
/* A swarm that averages less than this, measured over a moving window after a
 * warm-up, is not going to finish tonight: the episode is handed to the next
 * release instead of crawling for hours behind a bar that barely moves. The
 * numbers are short on purpose - a dead release wasted 6 minutes before it was
 * abandoned, and with a long queue that is the difference between a night of
 * downloads and a week of them. Pieces already fetched are kept, so a release
 * that looked slow and is tried again does not start from zero. */
const SLOW_SPEED_BYTES_PER_SEC = 120 * 1024;
const SLOW_WINDOW_MS = 120000;
const SLOW_WARMUP_MS = 90000;
const SLOW_REMAINING_BYTES = 300 * 1024 * 1024;
const RPC_TIMEOUT_MS = 4000;

/* VIDEO_COPY=1 keeps the source video stream instead of re-encoding it. A
 * Chromium browser on a machine with HEVC hardware decode plays an HEVC Main10
 * MP4 as it is, so the whole remux becomes a container write: measured 0.2 s
 * for 90 s of 1080p against 5.7 s for the transcode. It is off by default
 * because a browser without HEVC decode shows a black frame and there is no
 * second copy to fall back on. */
const VIDEO_COPY = /^(1|true|yes|on)$/i.test(String(process.env.VIDEO_COPY || '').trim());

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.divx',
]);

const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

/* Public trackers, used for both the metadata request and the payload. A
 * magnet without `tr=` relies on DHT alone, which is unreliable behind NAT. */
export const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.tamersunion.org:443/announce',
];

/* ISO 639-1 -> English name + every tag spelling that shows up in release
 * metadata (639-2/B, 639-2/T, legacy ffmpeg aliases). */
const LANG_TABLE = [
  ['en', 'English', ['eng']],
  ['ja', 'Japanese', ['jpn']],
  ['ko', 'Korean', ['kor']],
  ['zh', 'Chinese', ['zho', 'chi', 'cmn', 'yue', 'mandarin', 'cantonese']],
  ['pt', 'Portuguese', ['por']],
  ['es', 'Spanish', ['spa']],
  ['fr', 'French', ['fra', 'fre']],
  ['de', 'German', ['deu', 'ger']],
  ['it', 'Italian', ['ita']],
  ['ru', 'Russian', ['rus']],
  ['ar', 'Arabic', ['ara']],
  ['hi', 'Hindi', ['hin']],
  ['th', 'Thai', ['tha']],
  ['vi', 'Vietnamese', ['vie']],
  ['id', 'Indonesian', ['ind']],
  ['ms', 'Malay', ['msa', 'may']],
  ['tl', 'Filipino', ['fil', 'tagalog', 'tgl']],
  ['nl', 'Dutch', ['nld', 'dut']],
  ['pl', 'Polish', ['pol']],
  ['sv', 'Swedish', ['swe']],
  ['da', 'Danish', ['dan']],
  ['no', 'Norwegian', ['nor', 'nob', 'nb']],
  ['fi', 'Finnish', ['fin']],
  ['cs', 'Czech', ['ces', 'cze']],
  ['sk', 'Slovak', ['slk', 'slo']],
  ['hu', 'Hungarian', ['hun']],
  ['ro', 'Romanian', ['ron', 'rum']],
  ['bg', 'Bulgarian', ['bul']],
  ['uk', 'Ukrainian', ['ukr']],
  ['el', 'Greek', ['ell', 'gre']],
  ['he', 'Hebrew', ['heb']],
  ['tr', 'Turkish', ['tur']],
  ['fa', 'Persian', ['fas', 'per', 'farsi']],
  ['ur', 'Urdu', ['urd']],
  ['ta', 'Tamil', ['tam']],
  ['te', 'Telugu', ['tel']],
  ['bn', 'Bengali', ['ben']],
  ['ml', 'Malayalam', ['mal']],
  ['mr', 'Marathi', ['mar']],
  ['pa', 'Punjabi', ['pan']],
  ['gu', 'Gujarati', ['guj']],
  ['kn', 'Kannada', ['kan']],
  ['si', 'Sinhala', ['sin']],
  ['my', 'Burmese', ['mya', 'bur']],
  ['km', 'Khmer', ['khm']],
  ['lo', 'Lao', ['lao']],
  ['sr', 'Serbian', ['srp']],
  ['hr', 'Croatian', ['hrv']],
  ['bs', 'Bosnian', ['bos']],
  ['sl', 'Slovenian', ['slv']],
  ['sq', 'Albanian', ['sqi', 'alb']],
  ['mk', 'Macedonian', ['mkd', 'mac']],
  ['lt', 'Lithuanian', ['lit']],
  ['lv', 'Latvian', ['lav']],
  ['et', 'Estonian', ['est']],
  ['is', 'Icelandic', ['isl', 'ice']],
  ['ca', 'Catalan', ['cat']],
  ['gl', 'Galician', ['glg']],
  ['eu', 'Basque', ['eus', 'baq']],
  ['af', 'Afrikaans', ['afr']],
  ['sw', 'Swahili', ['swa']],
  ['am', 'Amharic', ['amh']],
  ['az', 'Azerbaijani', ['aze']],
  ['kk', 'Kazakh', ['kaz']],
  ['uz', 'Uzbek', ['uzb']],
  ['hy', 'Armenian', ['hye', 'arm']],
  ['ka', 'Georgian', ['kat', 'geo']],
  ['mn', 'Mongolian', ['mon']],
  ['ne', 'Nepali', ['nep']],
  ['be', 'Belarusian', ['bel']],
  ['eo', 'Esperanto', ['epo']],
];

const LANG_BY_KEY = new Map();
const LANG_NAMES = new Map();
for (const [iso, name, aliases] of LANG_TABLE) {
  LANG_NAMES.set(iso, name);
  for (const key of [iso, name.toLowerCase(), ...aliases]) LANG_BY_KEY.set(key, iso);
}

function lastLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() || '';
}

function basename(value) {
  return path.basename(String(value || '').replace(/\\/g, '/'));
}

function isVideoName(name) {
  return VIDEO_EXTS.has(path.extname(String(name || '')).toLowerCase());
}

/* Same shape as the helper in downloads.js: Windows needs the whole tree, not
 * just the first process, because aria2c forks nothing but ffmpeg may. */
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

/**
 * Spawn a child through proc.js and collect its output. The caller may pass
 * `onSpawn` to attach abort listeners before the first byte arrives, and
 * `signal` so a pause or a cancel kills the child instead of letting it run
 * until its own timeout (a magnet metadata fetch can sit there for 120 s).
 */
function runCapture(cmd, args, { timeout = 0, onSpawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnNice(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const onAbort = () => {
      killTree(child);
      finish(reject, abortError());
    };
    if (signal) {
      if (signal.aborted) {
        killTree(child);
        resolve({ code: null, stdout: '', stderr: '' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-MAX_CAPTURE);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_CAPTURE);
    });
    child.once('error', (err) => finish(reject, err));
    child.once('close', (code) => finish(resolve, { code, stdout, stderr }));

    if (timeout > 0) {
      timer = setTimeout(() => {
        killTree(child);
        finish(reject, new Error(`aria2c timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }

    if (typeof onSpawn === 'function') {
      try {
        onSpawn(child);
      } catch {
        /* the caller's listener is optional */
      }
    }
  });
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Locate aria2c: explicit override, bundled app cache, repo bin, then PATH. */
export function aria2cPath() {
  const override = process.env.ARIA2C_PATH;
  if (override) return override;

  const root = process.env.LIBRARY_ROOT || '';
  if (root) {
    const cached = path.join(root, '.cache', 'app', 'bin', 'aria2c.exe');
    if (isFile(cached)) return cached;
  }

  const bundled = path.join(process.cwd(), 'bin', 'aria2c.exe');
  if (isFile(bundled)) return bundled;

  return 'aria2c';
}

/* The parser for `aria2c --show-files`:
 *
 *     1|./Show/Show - S01E01.mkv
 *      |703MiB (737,524,676)
 *
 * The index is the value `--select-file` expects later. */
function parseShowFiles(text) {
  const files = [];
  let current = null;
  const push = () => {
    if (current && current.path) files.push(current);
    current = null;
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const head = /^\s*(\d+)\|(.*)$/.exec(line);
    if (head) {
      push();
      current = { index: Number(head[1]), path: head[2].trim(), size: 0 };
      continue;
    }
    if (!current) continue;

    if (!line.trim()) {
      push();
      continue;
    }

    const exact = /\(([\d,]+)(?:\s*bytes)?\)/i.exec(line);
    if (exact) {
      current.size = Number(exact[1].replace(/,/g, '')) || 0;
      continue;
    }
    // Older builds print only the human-readable size.
    const scaled = /(\d+(?:\.\d+)?)\s*([KMGT])i?B/i.exec(line);
    if (scaled) {
      const power = ['', 'K', 'M', 'G', 'T'].indexOf(scaled[2].toUpperCase());
      current.size = Math.round(Number(scaled[1]) * 1024 ** power) || 0;
    }
  }
  push();

  return files.sort((a, b) => a.index - b.index);
}

async function newestTorrent(dir, known) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const torrents = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.torrent')) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      torrents.push({ file, name, mtime: stat.mtimeMs, fresh: !known.has(name) });
    } catch {
      /* vanished while listing */
    }
  }
  torrents.sort((a, b) => (Number(b.fresh) - Number(a.fresh)) || (b.mtime - a.mtime));
  return torrents.length ? torrents[0].file : null;
}

/**
 * A pause keeps the .torrent aria2c saved, so resuming must not spend two
 * minutes asking the swarm for metadata it already has. The saved name is the
 * info hash (40 hex chars), which the magnet carries; a single .torrent in the
 * folder is accepted too, for base32 magnets whose stored name is hex.
 */
async function savedTorrent(dir, link) {
  const names = (await fsp.readdir(dir).catch(() => []))
    .filter((name) => name.toLowerCase().endsWith('.torrent'));
  if (!names.length) return null;
  const hash = /urn:btih:([a-z0-9]+)/i.exec(link)?.[1]?.toLowerCase() || '';
  if (hash) {
    const hit = names.find((name) => name.toLowerCase() === `${hash}.torrent`);
    if (hit) return path.join(dir, hit);
    /* Base32 magnets name the same torrent by its hex hash on disk. */
    if (/^[a-z2-7]{32}$/i.test(hash) && names.length === 1) {
      const only = path.join(dir, names[0]);
      return isFile(only) ? only : null;
    }
  }
  return null;
}

/**
 * Phase 1: fetch only the torrent metadata and return the numbered file table.
 * `dir` belongs to the caller; the .torrent aria2c writes is left in place.
 */
export async function fetchTorrentFiles(magnet, { dir, signal } = {}) {
  const link = String(magnet || '').trim();
  if (!link) throw new Error('a magnet link is required');
  if (!dir) throw new Error('a download directory is required');
  if (signal?.aborted) throw abortError();

  await fsp.mkdir(dir, { recursive: true });
  const known = new Set(
    (await fsp.readdir(dir).catch(() => [])).filter((name) => name.toLowerCase().endsWith('.torrent')),
  );

  /* Reuse the saved metadata when this transfer already fetched it. */
  let torrent = await savedTorrent(dir, link);
  if (!torrent) {
    const args = [
      '--bt-metadata-only=true',
      '--bt-save-metadata=true',
      `--dir=${dir}`,
      '--seed-time=0',
      `--bt-tracker=${TRACKERS.join(',')}`,
      link,
    ];

    const meta = await runCapture(aria2cPath(), args, { timeout: METADATA_TIMEOUT_MS, signal });
    if (signal?.aborted) throw abortError();
    torrent = await newestTorrent(dir, known);

    if (meta.code !== 0) {
      throw new Error(lastLine(meta.stderr) || `aria2c exited with code ${meta.code}`);
    }
  }
  if (!torrent) throw new Error('aria2c did not write a .torrent file');

  const listing = await runCapture(aria2cPath(), ['--show-files', torrent], {
    timeout: SHOW_FILES_TIMEOUT_MS,
    signal,
  });
  if (signal?.aborted) throw abortError();
  if (listing.code !== 0) {
    throw new Error(lastLine(listing.stderr) || `aria2c --show-files exited with code ${listing.code}`);
  }

  return parseShowFiles(listing.stdout);
}

/**
 * Pick the file the episode refers to. Exact name first, then a punctuation
 * insensitive name, then the single file whose SxxExx / NxNN tag matches.
 */
export function matchEpisodeFile(files, fileName, { season = 0, episode = 0 } = {}) {
  const list = Array.isArray(files) ? files.filter((file) => file && file.path) : [];
  const target = basename(fileName);
  if (!target) return null;

  const wanted = target.toLowerCase();
  const exact = list.find((file) => basename(file.path).toLowerCase() === wanted);
  if (exact) return exact;

  const loose = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const needle = loose(target);
  if (needle) {
    const near = list.find((file) => loose(basename(file.path)) === needle);
    if (near) return near;
  }

  const seasonNo = Number(season) || 0;
  const episodeNo = Number(episode) || 0;
  if (seasonNo > 0 && episodeNo > 0) {
    const tag = new RegExp(
      `(?:s0*${seasonNo}[\\s._-]*e0*${episodeNo}(?!\\d)|(?<!\\d)0*${seasonNo}x0*${episodeNo}(?!\\d))`,
      'i',
    );
    const hits = list.filter((file) => isVideoName(file.path) && tag.test(basename(file.path)));
    if (hits.length === 1) return hits[0];
  }

  return null;
}

function targetPath(dir, relative) {
  const cleaned = String(relative || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
  return path.join(dir, cleaned);
}

function abortError() {
  const err = new Error('download aborted');
  err.aborted = true;
  return err;
}

/* A free loopback port for aria2's JSON-RPC server. Binding and closing is the
 * cheapest way to let the OS pick one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * One JSON-RPC call against the aria2 instance that belongs to this download.
 * Returns null for every transport hiccup: aria2 exits as soon as the file is
 * complete, so the last polls always fail and that is expected.
 */
async function aria2Rpc(port, token, method, params = []) {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'progress', method, params: [`token:${token}`, ...params] }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.result ?? null;
}

/**
 * Bytes of the selected file that aria2 has actually written and verified,
 * plus its current speed and state. `stat.size` cannot be used for this:
 * BitTorrent writes pieces out of order, so the file reaches its final size
 * long before the download is done.
 *
 * A magnet gets two downloads inside aria2: the metadata blob first, then the
 * real file. Only an entry whose on-disk path is our target counts. A finished
 * download leaves `tellActive` for `tellStopped`, so both lists are checked;
 * with RPC enabled aria2c may keep running with an empty queue.
 */
const STATUS_FIELDS = [
  'gid', 'status', 'completedLength', 'totalLength', 'downloadSpeed',
  'errorCode', 'errorMessage', 'files',
];

function matchStatus(items, target, active) {
  const wanted = path.resolve(target);
  for (const item of Array.isArray(items) ? items : []) {
    const files = Array.isArray(item.files) ? item.files : [];
    const entry = files.find((file) => {
      if (!file?.path) return false;
      try {
        return path.resolve(String(file.path)) === wanted;
      } catch {
        return false;
      }
    });
    if (!entry) continue;
    return {
      gid: String(item.gid || ''),
      completed: Number(entry.completedLength) || 0,
      length: Number(entry.length) || 0,
      speed: active ? Number(item.downloadSpeed) || 0 : 0,
      status: String(item.status || (active ? 'active' : '')),
      errorCode: Number(item.errorCode) || 0,
      errorMessage: String(item.errorMessage || ''),
    };
  }
  return null;
}

async function torrentProgress(port, token, target, gid = '') {
  const active = await aria2Rpc(port, token, 'aria2.tellActive', [STATUS_FIELDS]);
  const hit = matchStatus(active, target, true);
  if (hit) return hit;

  /* Between "all pieces arrived" and "download stopped" aria2 finalizes the
   * control file and may briefly leave both lists. The GID from an earlier
   * poll keeps the status readable through that window. */
  if (gid) {
    const one = await aria2Rpc(port, token, 'aria2.tellStatus', [gid, STATUS_FIELDS]);
    const single = one ? matchStatus([one], target, false) : null;
    if (single) return single;
  }

  const stopped = await aria2Rpc(port, token, 'aria2.tellStopped', [0, 50, STATUS_FIELDS]);
  return matchStatus(stopped, target, false);
}

/**
 * Phase 2: download one file from the torrent. Resolves with its on-disk path
 * and size; aborting kills the aria2c tree and rejects with `.aborted = true`.
 */
export async function downloadTorrentFile({
  magnet, file, dir, total = 0, onProgress, signal, limitKbps = 0,
} = {}) {
  const link = String(magnet || '').trim();
  if (!link) throw new Error('a magnet link is required');
  if (!file || !Number.isInteger(Number(file.index)) || Number(file.index) < 1) {
    throw new Error('a torrent file entry with a valid index is required');
  }
  if (!dir) throw new Error('a download directory is required');
  if (signal?.aborted) throw abortError();

  const index = Number(file.index);
  const target = targetPath(dir, file.path);
  const expected = Number(total) || Number(file.size) || 0;
  const progress = (bytes, size, speed) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ bytes, total: size, speed: Number(speed) || 0 });
    } catch {
      /* a progress callback must never fail the transfer */
    }
  };

  /* aria2 runs a private JSON-RPC server on loopback so this process can read
   * the bytes it has really verified. A random port and secret keep it out of
   * reach of anything else on the machine. */
  const port = await freePort();
  const token = crypto.randomUUID();

  /* `limitKbps` is a number or a function, so the queue can hand over a share
   * of the speed cap that shrinks as soon as another transfer starts. aria2
   * reads the value in KiB/s; 0 means "no cap at all". */
  const readLimit = () => {
    let value = limitKbps;
    try {
      if (typeof value === 'function') value = value();
    } catch {
      value = 0;
    }
    const kbps = Math.round(Number(value) || 0);
    return kbps > 0 ? kbps : 0;
  };
  let appliedLimit = readLimit();

  const args = [
    `--dir=${dir}`,
    `--select-file=${index}`,
    '--seed-time=0',
    '--file-allocation=none',
    /* aria2 stops at 55 peers by default, and on a 19-seeder release that cap
     * is worth a few percent: the same 376 MB file took 48.6 s at 200 peers
     * against 52.2 s at the default, and 70.8 s with `prealloc` (the whole file
     * written before a piece arrives). Measurements in benchmark/aria2.csv. */
    '--bt-max-peers=200',
    '--disk-cache=64M',
    '--summary-interval=0',
    '--console-log-level=warn',
    '--auto-file-renaming=false',
    '--enable-rpc=true',
    `--rpc-listen-port=${port}`,
    '--rpc-listen-all=false',
    `--rpc-secret=${token}`,
    `--bt-tracker=${TRACKERS.join(',')}`,
    ...(appliedLimit ? [`--max-download-limit=${appliedLimit}K`] : []),
    link,
  ];

  let child = null;
  let poller = null;
  let stallReason = '';
  let rpcSeen = false;
  let rpcError = '';
  let finished = false;
  let misses = 0;
  let gid = '';
  let lastBytes = -1;
  let lastAdvance = Date.now();
  const startedAt = Date.now();
  const samples = [];
  const onAbort = () => killTree(child);

  const checkSwarm = (status) => {
    const now = Date.now();
    samples.push({ at: now, bytes: status.completed });
    while (samples.length && now - samples[0].at > SLOW_WINDOW_MS) samples.shift();

    if (now - lastAdvance > STALL_TIMEOUT_MS) {
      stallReason = `the torrent sent no data for ${Math.round(STALL_TIMEOUT_MS / 60000)} minutes`;
      return true;
    }

    /* Piece granularity means a healthy transfer still advances in steps;
       judge it on the last few minutes, never the last few seconds. */
    const span = samples.length > 1 ? (now - samples[0].at) / 1000 : 0;
    if (now - startedAt < SLOW_WARMUP_MS || span < (SLOW_WINDOW_MS / 1000) * 0.9) return false;
    const remaining = (status.length || expected || 0) - status.completed;
    if (remaining <= SLOW_REMAINING_BYTES) return false;

    const rate = (status.completed - samples[0].bytes) / span;
    if (rate >= SLOW_SPEED_BYTES_PER_SEC) return false;
    stallReason = `the swarm is too slow (${Math.max(0, Math.round(rate / 1024))} KB/s) and has no healthy peers`;
    return true;
  };

  try {
    const result = await runCapture(aria2cPath(), args, {
      onSpawn: (handle) => {
        child = handle;
        if (signal) {
          if (signal.aborted) killTree(handle);
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        const tick = async () => {
          /* The cap can change mid-transfer: another download started, or the
           * number was edited in Settings. aria2 applies it live, so no
           * restart of the swarm is needed. */
          const wantedLimit = readLimit();
          if (wantedLimit !== appliedLimit) {
            const changed = await aria2Rpc(port, token, 'aria2.changeGlobalOption', [{
              'max-download-limit': wantedLimit > 0 ? `${wantedLimit}K` : '0',
            }]).catch(() => null);
            if (changed) appliedLimit = wantedLimit;
          }
          const status = await torrentProgress(port, token, target, gid).catch(() => null);
          if (status) {
            rpcSeen = true;
            misses = 0;
            if (status.gid) gid = status.gid;
            if (status.status === 'error' || status.errorCode) {
              rpcError = status.errorMessage || `aria2 reported error ${status.errorCode}`;
              killTree(handle);
              return;
            }
            if (status.completed > lastBytes) {
              lastBytes = status.completed;
              lastAdvance = Date.now();
            }
            progress(status.completed, status.length || expected || status.completed, status.speed);
            /* aria2c with RPC enabled can stay alive with an empty queue, so
             * process exit is not a completion signal. The per-file byte count
             * is: once every piece overlapping the file is verified, stop the
             * client instead of waiting for it to close on its own. */
            if (finished || status.status === 'complete'
              || (status.length > 0 && status.completed >= status.length)) {
              finished = true;
              killTree(handle);
              return;
            }
            if (checkSwarm(status)) killTree(handle);
            return;
          }
          /* Before the RPC server answers, the file size is the only signal.
           * Once it has, an unanswered poll means aria2 is busy, and a busy
           * disk makes that last a long time: a spinning G: drive answered
           * nothing for 60 seconds during a library scan, and killing the
           * client after 20 misses turned a healthy transfer into a retry.
           * A transfer that really died is caught by the byte-progress stall
           * check above, so wait a full minute here. */
          if (rpcSeen) {
            misses += 1;
            if (misses >= 60) killTree(handle);
            return;
          }
          try {
            const stat = await fsp.stat(target);
            progress(stat.size, expected || stat.size, 0);
          } catch {
            /* aria2c has not created the file yet */
          }
        };
        poller = setInterval(tick, 1000);
        tick();
      },
    });

    if (signal?.aborted) throw abortError();
    if (rpcError) throw new Error(rpcError);
    if (stallReason) throw new Error(stallReason);

    const stat = await fsp.stat(target).catch(() => null);
    if (!finished && result.code !== 0) {
      throw new Error(lastLine(result.stderr) || `aria2c exited with code ${result.code}`);
    }
    if (!stat || !stat.size) throw new Error('aria2c did not produce the selected file');
    /* Pieces are written out of order, so the size alone is not proof; the
     * RPC completion flag is. A short file means the transfer stopped early. */
    if (expected && stat.size < expected) {
      throw new Error(`aria2c stopped at ${Math.round(stat.size / 1048576)} MB of ${Math.round(expected / 1048576)} MB`);
    }

    await fsp.rm(`${target}.aria2`, { force: true }).catch(() => {});
    progress(stat.size, stat.size, 0);
    return { path: target, bytes: stat.size };
  } catch (err) {
    if (signal?.aborted && !err?.aborted) throw abortError();
    throw err;
  } finally {
    if (poller) clearInterval(poller);
    if (signal) signal.removeEventListener('abort', onAbort);
    // A child that is still running after an error must not keep writing.
    if (child && child.exitCode === null) killTree(child);
  }
}

/**
 * Probe with ffprobe. Returns the video stream, every audio stream and the
 * text subtitle streams; image subtitles (PGS/VobSub) are unusable as WebVTT.
 */
export async function probeMedia(file) {
  const source = String(file || '');
  if (!source) throw new Error('a media file is required');

  const raw = await run(ffprobePath, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    source,
  ], { lane: 'probe', timeout: 60000 });

  const data = JSON.parse(raw);
  const streams = Array.isArray(data.streams) ? data.streams : [];

  const videoStream = streams.find((stream) => (
    stream.codec_type === 'video' && Number(stream.disposition?.attached_pic) !== 1
  ));

  const video = videoStream ? {
    index: Number(videoStream.index) || 0,
    codec: videoStream.codec_name || '',
    width: Number(videoStream.width) || 0,
    height: Number(videoStream.height) || 0,
    pixFmt: videoStream.pix_fmt || '',
    bitRate: Number(videoStream.bit_rate) || 0,
  } : null;

  const audio = streams
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream) => ({
      index: Number(stream.index) || 0,
      codec: stream.codec_name || '',
      channels: Number(stream.channels) || 0,
      lang: String(stream.tags?.language || '').toLowerCase(),
      title: String(stream.tags?.title || ''),
      bitRate: Number(stream.bit_rate) || 0,
      default: Number(stream.disposition?.default) === 1,
    }));

  const subtitles = streams
    .filter((stream) => stream.codec_type === 'subtitle' && TEXT_SUB_CODECS.has(stream.codec_name))
    .map((stream) => {
      const title = String(stream.tags?.title || '');
      return {
        index: Number(stream.index) || 0,
        codec: stream.codec_name || '',
        lang: String(stream.tags?.language || '').toLowerCase(),
        title,
        forced: Number(stream.disposition?.forced) === 1 || /forced/i.test(title),
        sdh: /sdh|hearing|closed caption/i.test(title),
      };
    });

  let sizeBytes = Number(data.format?.size) || 0;
  if (!sizeBytes) {
    const stat = await fsp.stat(source).catch(() => null);
    sizeBytes = stat?.size || 0;
  }

  return {
    durationSec: Number(data.format?.duration) || 0,
    sizeBytes,
    video,
    audio,
    subtitles,
  };
}

/** Map a language name or 2/3-letter tag to its ISO 639-1 code, or ''. */
export function toIso2(codeOrName) {
  const raw = String(codeOrName || '').trim().toLowerCase();
  if (!raw) return '';

  const direct = LANG_BY_KEY.get(raw);
  if (direct) return direct;

  // "Brazilian Portuguese", "Spanish (Latin America)", "pt-BR", "English SDH".
  for (const word of raw.split(/[^a-z0-9]+/).filter(Boolean)) {
    const hit = LANG_BY_KEY.get(word);
    if (hit) return hit;
  }
  return '';
}

function langOf(track) {
  return toIso2(track?.lang) || toIso2(track?.title);
}

/**
 * Choose the streams worth keeping: an h264 video stream, the original
 * language plus English audio, and one text subtitle per language.
 */
export function pickTracks(probe, { originalLanguage = '', copyVideo = false, mkv = true } = {}) {
  if (!probe || !probe.video) {
    return { error: 'no-video', reason: 'the file has no video stream' };
  }

  const warnings = [];

  /* `copyVideo` is the browser itself saying it decodes HEVC in hardware. That
   * turns the remux into a container copy: the same 30 min episode takes about
   * 30 s instead of 140 s on the same disk, because the GPU is out of the
   * picture entirely. VIDEO_COPY=1 forces the same thing from the environment
   * and, for an expert, for every non-h264 codec. */
  // probe.video is a single stream; keep its shape so remuxToMp4 can read .index.
  const keepSource = probe.video.codec !== 'h264'
    && (VIDEO_COPY || (copyVideo && probe.video.codec === 'hevc'));
  const video = probe.video.codec === 'h264' || keepSource
    ? { ...probe.video }
    : { ...probe.video, transcode: true };
  if (video.transcode) warnings.push(`video is ${probe.video.codec || 'unknown'}; transcode to h264 is required`);
  if (keepSource) warnings.push(`video stays ${probe.video.codec}; the browser has to decode it in hardware`);

  const audio = Array.isArray(probe.audio) ? probe.audio : [];
  if (!audio.length) {
    return { error: 'no-english-audio', reason: 'the file has no audio tracks' };
  }

  const wanted = toIso2(originalLanguage);
  let original = wanted ? audio.find((track) => langOf(track) === wanted) : null;
  if (wanted && !original) {
    /* A release whose tracks are tagged but none of them is the original
     * language is a dub-only file: never install it, however good the rest of
     * the release looks. Untagged files still fall back to the first track,
     * because there is nothing to match against. */
    if (audio.some((track) => langOf(track))) {
      return {
        error: 'no-original-audio',
        reason: `the file has no ${originalLanguage} audio track`,
      };
    }
    warnings.push(`no ${originalLanguage} audio track found; using the first track`);
  }

  let english = audio.find((track) => langOf(track) === 'en') || null;

  if (!original) {
    original = audio[0];
    if (audio.length >= 2 && !english) {
      english = audio[1];
      warnings.push('no English audio tag found; assuming the second track is English');
    }
  }

  // The original is English: one track is enough.
  const originalIsEnglish = langOf(original) === 'en';
  if (originalIsEnglish) english = null;

  if (!english && !originalIsEnglish && audio.length > 1) {
    return {
      error: 'no-english-audio',
      reason: 'the file has no English audio track; only the original would be playable',
    };
  }

  const selected = [{ ...original, role: 'original' }];
  if (english && english !== original) selected.push({ ...english, role: 'english' });

  const byLang = new Map();
  for (const track of Array.isArray(probe.subtitles) ? probe.subtitles : []) {
    const lang = String(track.lang || '').toLowerCase();
    if (!lang || lang === 'und') continue;
    const iso = toIso2(lang) || lang;
    const rank = (track.sdh ? 2 : 0) + (track.forced ? 1 : 0);
    const current = byLang.get(iso);
    if (!current || rank < current.rank) byLang.set(iso, { track, rank });
  }
  const subtitles = [...byLang.values()].map((entry) => entry.track);
  /* A release without embedded text subtitles is no longer a reason to throw it
   * away: English subtitles are fetched separately (subs.js) once the episode
   * is installed, so rejecting the file only burned an attempt and, when every
   * release for the episode was like this, lost the episode entirely. */

  /* `direct` is the answer to "does this file need converting at all". The
   * release's own .mkv plays in Chromium when the browser opens Matroska
   * (`mkv`, the client's own canPlayType probe), the video needs no transcode
   * and the first audio track is AAC: measured in Brave, an HEVC+AAC .mkv
   * shows a frame after 1.03 s and seeks to 15:00 in 1.21 s, while the same
   * file went through a 6.8 s remux only to produce something the browser
   * already had. E-AC3/AC-3 is the one thing that cannot pass through:
   * Chromium reports `canPlayType('audio/mp4; codecs="ec-3"')` as empty and
   * decodes 0 bytes. */
  return {
    video,
    audio: selected,
    subtitles,
    warnings,
    direct: mkv
      && !video.transcode
      && (!selected.length || String(selected[0].codec || '').toLowerCase() === 'aac')
      /* The first audio stream is the one every player starts with. A release
       * that lists a dub first (Italian track 1, English track 2) must be
       * remuxed so the original language becomes track 1 - and the dub is
       * dropped on the way - instead of being kept as-is and playing the dub. */
      && selected[0]?.index === probe.audio[0]?.index,
  };
}

/* ---------- video encoder choice ---------- */

/* Re-encoding an HEVC or AV1 release to H.264 is the slow phase of a download,
 * and the encoder is not what costs the minutes: the CPU spends most of them
 * decoding 10-bit HEVC a frame at a time. A hardware decoder keeps the frames
 * on the GPU, a `scale_*` filter converts 10-bit to the 8-bit format the
 * encoder wants without a trip through system memory, and the same file
 * finishes in a fraction of the time. Measured on this desktop (i5-10400F,
 * RTX 3070) with a 90 s 1080p HEVC Main10 clip:
 *
 *   CPU decode + h264_nvenc p4 ....... 19.9 s
 *   NVDEC + h264_nvenc p4 ............ 11.9 s
 *   NVDEC + h264_nvenc p1 ............. 4.2 s
 *
 * `decode` runs before `-i`, `filter` replaces the implied format conversion.
 * Each candidate is proved against a 10-bit HEVC sample, because a decoder that
 * cannot open it must lose here and not halfway through a download. libx264 is
 * always the fallback, and VIDEO_ENCODER=<name> forces one.
 */
const VIDEO_ENCODERS = [
  {
    name: 'h264_nvenc',
    decode: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
    filter: 'scale_cuda=format=nv12',
    args: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
  },
  {
    name: 'h264_qsv',
    decode: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'],
    filter: 'scale_qsv=format=nv12',
    args: ['-c:v', 'h264_qsv', '-global_quality', '22', '-preset', 'veryfast'],
  },
  {
    name: 'h264_amf',
    args: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'libx264',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
  },
];

let encoderChoice = null;

/* A 10-bit HEVC sample is the honest test: the decoder, the GPU format
 * conversion and the encoder all have to survive the kind of file a release
 * actually ships. Built once per process, in the temp folder, and deleted. */
async function encoderSample() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'netflix-encoder-')).catch(() => '');
  if (!dir) return null;
  const file = path.join(dir, 'sample.mp4');
  const built = await runCapture(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=0.4,format=yuv420p10le',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-f', 'mp4', file,
  ], { timeout: 30000 }).catch(() => null);
  return built?.code === 0 ? { dir, file } : null;
}

async function videoEncoder() {
  if (encoderChoice) return encoderChoice;
  const wanted = String(process.env.VIDEO_ENCODER || '').trim().toLowerCase();
  const list = wanted
    ? [...VIDEO_ENCODERS.filter((entry) => entry.name === wanted), ...VIDEO_ENCODERS]
    : VIDEO_ENCODERS;

  const sample = await encoderSample();
  const tried = new Set();
  for (const entry of list) {
    if (tried.has(entry.name)) continue;
    tried.add(entry.name);
    /* Without a sample there is nothing to decode, so only the encoder is
     * proved and a bad `decode` list becomes a full remux failure. */
    const source = sample ? ['-i', sample.file] : ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=0.4'];
    const filter = sample && entry.filter ? ['-vf', entry.filter] : [];
    const probe = await runCapture(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      ...(sample ? entry.decode || [] : []),
      ...source, ...filter,
      ...entry.args, '-an', '-frames:v', '5', '-f', 'null', '-',
    ], { timeout: 30000 }).catch(() => null);
    if (probe?.code === 0) {
      encoderChoice = entry;
      console.log(`[torrent] video encoder: ${entry.name}${entry.decode ? ' (hardware decode)' : ''}`);
      break;
    }
  }
  if (sample) await fsp.rm(sample.dir, { recursive: true, force: true }).catch(() => {});

  if (!encoderChoice) encoderChoice = VIDEO_ENCODERS[VIDEO_ENCODERS.length - 1];
  return encoderChoice;
}

/**
 * Phase 3a: one ffmpeg pass to a browser-friendly MP4. h264 is copied, any
 * other codec is re-encoded 8-bit 4:2:0; audio becomes AAC 5.1 when the source
 * is multichannel, stereo otherwise.
 */
export async function remuxToMp4({ input, output, video, audio, onProgress } = {}) {
  const source = String(input || '');
  const target = String(output || '');
  if (!source || !target) throw new Error('input and output are required');
  if (!video || !Number.isInteger(Number(video.index))) throw new Error('a video stream is required');

  const tracks = (Array.isArray(audio) ? audio : [])
    .filter((track) => Number.isInteger(Number(track?.index)) && Number(track.index) >= 0);

  const encoder = video.transcode ? await videoEncoder() : null;

  /* What the muxer needs per track, worked out once so the single pass and the
   * parallel audio path cannot disagree about bitrate, language or disposition. */
  const plan = tracks.map((track) => {
    const channels = Number(track.channels) || 2;
    const rawLang = String(track.lang || '').trim().toLowerCase();
    return {
      track,
      surround: channels > 2,
      lang: /^[a-z]{2,3}$/.test(rawLang) ? rawLang : (toIso2(rawLang) || 'und'),
      copyable: String(track.codec || '').toLowerCase() === 'aac' && channels >= 1 && channels <= 6,
      bitrate: channels > 2 ? '448k' : '192k',
      channels: channels > 2 ? '6' : '2',
    };
  });

  const buildArgs = (videoArgs, { decode = [], filter = '' } = {}) => {
    const args = [
      '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      ...decode,
      '-i', source,
      '-map', `0:${Number(video.index)}`,
    ];
    if (filter) args.push('-vf', filter);
    args.push(...videoArgs);

    plan.forEach((entry, position) => {
      /* An AAC track is already what the player wants, and the native AAC
       * encoder is single-threaded: re-encoding 5.1 costs about as much as the
       * hardware video encode does. Copy it and keep the original layout. */
      args.push('-map', `0:${Number(entry.track.index)}`);
      if (entry.copyable) {
        args.push(`-c:a:${position}`, 'copy');
      } else {
        args.push(
          `-c:a:${position}`, 'aac',
          /* `twoloop` (the default) is the most accurate quantiser and also the
           * slowest thing left in the pipeline once the video is copied: 180 s
           * of one 5.1 track takes 17.05 s against 7.23 s with `fast`, same
           * AAC-LC, same 445 kb/s, same file size. Measured on a real E-AC3
           * 640 kb/s 5.1 track from an Erai-raws release. */
          `-aac_coder:a:${position}`, 'fast',
          `-b:a:${position}`, entry.bitrate,
          `-ac:a:${position}`, entry.channels,
        );
      }
      args.push(`-metadata:s:a:${position}`, `language=${entry.lang}`);
      if (entry.track.title) args.push(`-metadata:s:a:${position}`, `title=${entry.track.title}`);
      args.push(`-disposition:a:${position}`, position === 0 ? 'default' : '0');
    });

    args.push(
      '-sn', '-dn',
      '-map_chapters', '-1',
      /* No `+faststart`. It does not stream the moov atom first, it rewrites
       * the whole output once the mux is done: 10-15 s of extra read and write
       * on the library disk for a 1 GB episode, measured 33.0/28.0 s down to
       * 18.3/17.3 s without it. Nothing here needs it - the server answers
       * Range requests, and Chromium reads a moov at the end with one tail
       * request (`bytes=<size>-`) before playback. */
      '-f', 'mp4',
      target,
    );
    return args;
  };

  // The progress blocks only carry time; the duration comes from one probe.
  let durationSec = 0;
  try {
    durationSec = (await probeMedia(source)).durationSec;
  } catch {
    /* progress and the parallel split are both optional */
  }

  /* How much data one extra pass has to demux. Matroska interleaves audio and
   * video, so every ffmpeg reading a slice still walks the whole file; six
   * slices of a 2.8 GB release are six scans of it. On the download queue the
   * disk is also busy writing three torrents, and the split then loses its
   * edge: the 59 min x265 season-pack episode took 381 s for its six audio
   * slices against 144 s for one sequential pass over the same file. Small
   * sources still split, because there the reads are cheap and one AAC
   * encoder is the real limit. */
  let sourceBytes = 0;
  try {
    sourceBytes = (await fsp.stat(source)).size;
  } catch {
    sourceBytes = 0;
  }
  const SPLIT_SOURCE_LIMIT = 500 * 1024 * 1024;

  const emit = (sec) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ sec, durationSec });
    } catch {
      /* ignore a broken callback */
    }
  };

  const runOnce = (args) => {
    const child = spawnMedia(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let pending = '';

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const micro = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (micro) {
          emit(Number(micro[1]) / 1e6);
          continue;
        }
        const clock = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(line);
        if (clock) {
          emit(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
        }
      }
    });

    const done = new Promise((resolve, reject) => {
      let settled = false;
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      child.once('close', (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      });
    });

    return done.then((code) => ({ code, stderr }));
  };

  /* One AAC encoder thread is the whole remux once the video is copied. Split
   * every re-encoded track into pieces, encode the pieces at the same time and
   * join them with a stream copy: the 26 min 5.1 track of a real release took
   * 62.3 s in one pass and 17.9 s as six pieces, and the join does not move the
   * timeline (25:42.09 in, 25:42.09 out). The pieces come from the same source
   * with their own `-ss`, so the work lands on several cores instead of one. */
  const parallelAudio = async (seconds) => {
    const work = plan.filter((entry) => !entry.copyable);
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const perTrack = Math.max(2, Math.min(4, Math.floor(cpus / Math.max(1, work.length))));
    const slice = seconds / perTrack;
    const dir = path.join(path.dirname(target), `.remux-${process.pid}`);
    await fsp.mkdir(dir, { recursive: true });
    let finished = 0;
    const total = work.length * perTrack;

    try {
      const running = [];
      work.forEach((entry, slot) => {
        for (let i = 0; i < perTrack; i += 1) {
          const chunk = path.join(dir, `a${slot}-${i}.m4a`);
          running.push(runOnce([
            '-y', '-loglevel', 'error', '-nostats',
            '-ss', (i * slice).toFixed(3), '-t', slice.toFixed(3),
            '-i', source,
            '-map', `0:${Number(entry.track.index)}`,
            '-c:a:0', 'aac', '-aac_coder:a:0', 'fast',
            '-b:a:0', entry.bitrate, '-ac:a:0', entry.channels,
            '-f', 'mp4', chunk,
          ]).then((result) => {
            if (result.code !== 0) throw new Error(lastLine(result.stderr) || `ffmpeg exited with code ${result.code}`);
            finished += 1;
            emit(seconds * 0.9 * (finished / total));
          }));
        }
      });
      await Promise.all(running);

      const lists = [];
      work.forEach((entry, slot) => {
        const list = path.join(dir, `a${slot}.txt`);
        const files = [];
        for (let i = 0; i < perTrack; i += 1) {
          files.push(`file '${path.join(dir, `a${slot}-${i}.m4a`).replace(/\\/g, '/')}'`);
        }
        fs.writeFileSync(list, `${files.join('\n')}\n`);
        lists.push(list);
      });

      const args = ['-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', source];
      for (const list of lists) args.push('-f', 'concat', '-safe', '0', '-i', list);
      args.push('-map', `0:${Number(video.index)}`);
      let input = 1;
      plan.forEach((entry) => {
        if (entry.copyable) {
          args.push('-map', `0:${Number(entry.track.index)}`);
        } else {
          args.push('-map', `${input}:a:0`);
          input += 1;
        }
      });
      args.push('-c', 'copy');
      if (video.codec === 'hevc') args.push('-tag:v', 'hvc1');
      plan.forEach((entry, position) => {
        args.push(`-metadata:s:a:${position}`, `language=${entry.lang}`);
        if (entry.track.title) args.push(`-metadata:s:a:${position}`, `title=${entry.track.title}`);
        args.push(`-disposition:a:${position}`, position === 0 ? 'default' : '0');
      });
      args.push('-sn', '-dn', '-map_chapters', '-1', '-f', 'mp4', target);

      const result = await runOnce(args);
      if (result.code !== 0) throw new Error(lastLine(result.stderr) || `ffmpeg exited with code ${result.code}`);
      emit(seconds);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  try {
    const hw = encoder ? { decode: encoder.decode, filter: encoder.filter } : {};
    /* A copied HEVC stream has to be tagged `hvc1`: the `hev1` default is
     * accepted by ffmpeg but Chromium refuses to play it. */
    const videoArgs = encoder
      ? [...encoder.args]
      : ['-c:v', 'copy', ...(video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])];

    /* A video transcode already keeps every core busy and the GPU is the
     * ceiling, so splitting only helps the copy case. Anything unexpected
     * falls back to the single pass instead of losing the download. */
    if (!video.transcode && durationSec > 0 && plan.some((entry) => !entry.copyable)
      && (!sourceBytes || sourceBytes <= SPLIT_SOURCE_LIMIT)) {
      try {
        await parallelAudio(durationSec);
        const stat = await fsp.stat(target).catch(() => null);
        if (!stat || !stat.size) throw new Error('ffmpeg produced an empty file');
        return { bytes: stat.size };
      } catch (err) {
        console.warn(`[torrent] parallel audio failed (${err.message}); remuxing in one pass`);
        await fsp.rm(target, { force: true }).catch(() => {});
        emit(0);
      }
    }

    let result = await runOnce(buildArgs(videoArgs, hw));

    /* A hardware encoder can refuse the session (driver reset, too many
     * sessions, an unsupported source depth). Losing a whole download and
     * moving to the next release is a terrible outcome for that, so the same
     * file gets one more pass on the CPU. */
    if (result.code !== 0 && encoder && encoder.name !== 'libx264') {
      console.warn(`[torrent] ${encoder.name} failed (${lastLine(result.stderr) || 'unknown'}); retrying with libx264`);
      await fsp.rm(target, { force: true }).catch(() => {});
      emit(0);
      result = await runOnce(buildArgs(VIDEO_ENCODERS[VIDEO_ENCODERS.length - 1].args));
    }

    if (result.code !== 0) throw new Error(lastLine(result.stderr) || `ffmpeg exited with code ${result.code}`);

    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || !stat.size) throw new Error('ffmpeg produced an empty file');

    return { bytes: stat.size };
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Phase 3b: pull every text subtitle stream out as `<outStem>.<iso2>.vtt`.
 * One broken track is skipped; the caller always gets the tracks that worked.
 */
export async function extractSubtitles({ input, outStem, subtitles } = {}) {
  const source = String(input || '');
  const stem = String(outStem || '');
  if (!source || !stem) throw new Error('input and outStem are required');

  const wanted = [];
  for (const track of Array.isArray(subtitles) ? subtitles : []) {
    const index = Number(track?.index);
    if (!Number.isInteger(index) || index < 0) continue;

    const iso = toIso2(track.lang);
    if (!iso) continue;
    if (wanted.some((entry) => entry.iso === iso)) continue;

    wanted.push({ track, iso, index, file: `${stem}.${iso}.vtt` });
  }
  if (!wanted.length) return [];

  /* One ffmpeg pass writes every track. A European season pack carries 30+
   * languages, and starting a process per track made the subtitle stage the
   * slowest part of a finished download; one pass demuxes the file once.
   * `subs` is its own lane: demuxing text is I/O, not decode, so it never has
   * to wait behind a remux and three downloads can finish at once. */
  const batch = ['-y', '-v', 'error', '-i', source];
  for (const entry of wanted) batch.push('-map', `0:${entry.index}`, '-c:s', 'webvtt', entry.file);
  const batchOk = await run(ffmpegPath, batch, { lane: 'subs', timeout: 90000 })
    .then(() => true)
    .catch(() => false);

  const written = [];
  for (const entry of wanted) {
    let body = '';
    try {
      body = await fsp.readFile(entry.file, 'utf8');
    } catch {
      body = '';
    }

    /* The batch cannot say which track broke and ffmpeg aborts the run on a bad
     * stream, so a missing file gets one solo retry - English only. Retrying
     * all 30 languages is what held finished episodes at 97 % for minutes. */
    if (body.length < 20 || !body.includes('-->')) {
      await fsp.rm(entry.file, { force: true }).catch(() => {});
      if (entry.iso !== 'en') continue;
      const solo = await run(ffmpegPath, [
        '-y', '-v', 'error',
        '-i', source,
        '-map', `0:${entry.index}`,
        '-c:s', 'webvtt',
        entry.file,
      ], { lane: 'subs', timeout: 20000 }).then(() => true).catch(() => false);
      if (!solo) continue;
      try {
        body = await fsp.readFile(entry.file, 'utf8');
      } catch {
        continue;
      }
      if (body.length < 20 || !body.includes('-->')) {
        await fsp.rm(entry.file, { force: true }).catch(() => {});
        continue;
      }
    }

    written.push({
      lang: entry.iso,
      label: String(entry.track.title || '') || LANG_NAMES.get(entry.iso) || entry.iso.toUpperCase(),
      path: entry.file,
      cues: (body.match(/-->/g) || []).length,
    });
  }

  /* ffmpeg writes the tracks in order and stops at a track with no packets
   * ("Output file #3 does not contain any stream"), so a failed batch still
   * leaves most of its files on disk. The loop above already kept those and
   * retried the missing ones one at a time; say how many needed that instead
   * of calling a mostly successful pass a failure. */
  if (!batchOk && written.length < wanted.length) {
    console.warn(`[torrent] subtitle batch wrote ${written.length} of ${wanted.length} tracks; retried the rest one at a time`);
  }
  return written;
}
