import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { run, spawnNice } from './proc.js';

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
 *   3. remux     - one ffmpeg pass copies (or transcodes) the video, re-encodes
 *                  every audio track to AAC 5.1/stereo and keeps only h264, so
 *                  browsers can play the result. Subtitle streams are pulled
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
 * `onSpawn` to attach abort listeners before the first byte arrives.
 */
function runCapture(cmd, args, { timeout = 0, onSpawn } = {}) {
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
      fn(value);
    };

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
 * Phase 1: fetch only the torrent metadata and return the numbered file table.
 * `dir` belongs to the caller; the .torrent aria2c writes is left in place.
 */
export async function fetchTorrentFiles(magnet, { dir } = {}) {
  const link = String(magnet || '').trim();
  if (!link) throw new Error('a magnet link is required');
  if (!dir) throw new Error('a download directory is required');

  await fsp.mkdir(dir, { recursive: true });
  const known = new Set(
    (await fsp.readdir(dir).catch(() => [])).filter((name) => name.toLowerCase().endsWith('.torrent')),
  );

  const args = [
    '--bt-metadata-only=true',
    '--bt-save-metadata=true',
    `--dir=${dir}`,
    '--seed-time=0',
    `--bt-tracker=${TRACKERS.join(',')}`,
    link,
  ];

  const meta = await runCapture(aria2cPath(), args, { timeout: METADATA_TIMEOUT_MS });
  const torrent = await newestTorrent(dir, known);

  if (meta.code !== 0) {
    throw new Error(lastLine(meta.stderr) || `aria2c exited with code ${meta.code}`);
  }
  if (!torrent) throw new Error('aria2c did not write a .torrent file');

  const listing = await runCapture(aria2cPath(), ['--show-files', torrent], {
    timeout: SHOW_FILES_TIMEOUT_MS,
  });
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

/**
 * Phase 2: download one file from the torrent. Resolves with its on-disk path
 * and size; aborting kills the aria2c tree and rejects with `.aborted = true`.
 */
export async function downloadTorrentFile({ magnet, file, dir, total = 0, onProgress, signal } = {}) {
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
  const progress = (bytes, size) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ bytes, total: size });
    } catch {
      /* a progress callback must never fail the transfer */
    }
  };

  const args = [
    `--dir=${dir}`,
    `--select-file=${index}`,
    '--seed-time=0',
    '--file-allocation=none',
    '--summary-interval=0',
    '--console-log-level=warn',
    '--auto-file-renaming=false',
    `--bt-tracker=${TRACKERS.join(',')}`,
    link,
  ];

  let child = null;
  let poller = null;
  const onAbort = () => killTree(child);

  try {
    const result = await runCapture(aria2cPath(), args, {
      onSpawn: (handle) => {
        child = handle;
        if (signal) {
          if (signal.aborted) killTree(handle);
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        const tick = async () => {
          try {
            const stat = await fsp.stat(target);
            progress(stat.size, expected || stat.size);
          } catch {
            /* aria2c has not created the file yet */
          }
        };
        poller = setInterval(tick, 1000);
        tick();
      },
    });

    if (signal?.aborted) throw abortError();

    const stat = await fsp.stat(target).catch(() => null);
    if (result.code !== 0) {
      throw new Error(lastLine(result.stderr) || `aria2c exited with code ${result.code}`);
    }
    if (!stat || !stat.size) throw new Error('aria2c did not produce the selected file');

    await fsp.rm(`${target}.aria2`, { force: true }).catch(() => {});
    progress(stat.size, stat.size);
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
export function pickTracks(probe, { originalLanguage = '' } = {}) {
  if (!probe || !probe.video) {
    return { error: 'no-video', reason: 'the file has no video stream' };
  }

  const warnings = [];

  // probe.video is a single stream; keep its shape so remuxToMp4 can read .index.
  const video = probe.video.codec === 'h264'
    ? { ...probe.video }
    : { ...probe.video, transcode: true };
  if (video.transcode) warnings.push(`video is ${probe.video.codec || 'unknown'}; transcode to h264 is required`);

  const audio = Array.isArray(probe.audio) ? probe.audio : [];
  if (!audio.length) {
    return { error: 'no-english-audio', reason: 'the file has no audio tracks' };
  }

  const wanted = toIso2(originalLanguage);
  let original = wanted ? audio.find((track) => langOf(track) === wanted) : null;
  if (wanted && !original) {
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
  if (!subtitles.length) {
    return { error: 'no-subtitles', reason: 'the file has no text subtitle tracks' };
  }

  return { video, audio: selected, subtitles, warnings };
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

  const args = [
    '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-i', source,
    '-map', `0:${Number(video.index)}`,
  ];

  if (video.codec === 'h264') {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  }

  tracks.forEach((track, position) => {
    const channels = Number(track.channels) || 2;
    const surround = channels > 2;
    const rawLang = String(track.lang || '').trim().toLowerCase();
    const lang = /^[a-z]{2,3}$/.test(rawLang) ? rawLang : (toIso2(rawLang) || 'und');

    args.push(
      '-map', `0:${Number(track.index)}`,
      `-c:a:${position}`, 'aac',
      `-b:a:${position}`, surround ? '448k' : '192k',
      `-ac:a:${position}`, surround ? '6' : '2',
      `-metadata:s:a:${position}`, `language=${lang}`,
    );
    if (track.title) args.push(`-metadata:s:a:${position}`, `title=${track.title}`);
    args.push(`-disposition:a:${position}`, position === 0 ? 'default' : '0');
  });

  args.push(
    '-sn', '-dn',
    '-map_chapters', '-1',
    '-movflags', '+faststart',
    '-f', 'mp4',
    target,
  );

  // The progress blocks only carry time; the duration comes from one probe.
  let durationSec = 0;
  if (typeof onProgress === 'function') {
    try {
      durationSec = (await probeMedia(source)).durationSec;
    } catch {
      /* progress is optional */
    }
  }

  const emit = (sec) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ sec, durationSec });
    } catch {
      /* ignore a broken callback */
    }
  };

  try {
    const child = spawnNice(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

    const code = await new Promise((resolve, reject) => {
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

    if (code !== 0) throw new Error(lastLine(stderr) || `ffmpeg exited with code ${code}`);

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

  const written = [];
  for (const track of Array.isArray(subtitles) ? subtitles : []) {
    const index = Number(track?.index);
    if (!Number.isInteger(index) || index < 0) continue;

    const iso = toIso2(track.lang);
    if (!iso) continue;
    if (written.some((entry) => entry.lang === iso)) continue;

    const file = `${stem}.${iso}.vtt`;
    try {
      await run(ffmpegPath, [
        '-y', '-v', 'error',
        '-i', source,
        '-map', `0:${index}`,
        '-c:s', 'webvtt',
        file,
      ], { lane: 'media', timeout: 60000 });

      const body = await fsp.readFile(file, 'utf8');
      if (body.length < 20 || !body.includes('-->')) {
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }

      written.push({
        lang: iso,
        label: String(track.title || '') || LANG_NAMES.get(iso) || iso.toUpperCase(),
        path: file,
        cues: (body.match(/-->/g) || []).length,
      });
    } catch {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
  return written;
}
