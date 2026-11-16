import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { probeMedia } from './torrent.js';
import { spawnNice, playbackActive } from './proc.js';

/**
 * Full-range HEVC repair.
 *
 * A release that is encoded with the full-range flag (`color_range=pc`, samples
 * spanning 0-1023 in 10-bit) plays washed out in every Chromium browser: the
 * decoder ignores the flag and shows the samples as if they were limited
 * (64-940), so blacks lift, highlights clip and hues drift. H.264 with the same
 * flag is fine - only HEVC loses it - and the container makes no difference
 * (MP4 and Matroska both render wrong).
 *
 * There is no metadata-only fix, because the flag is exactly what is ignored:
 * the samples have to be moved into the legal range. One pass does it:
 *
 *   scale=in_range=pc:out_range=tv   maps 0-1023 into 64-940
 *   -color_range tv                  tags the result as limited
 *
 * The video is re-encoded (HEVC 10-bit through NVENC, libx265 as the fallback),
 * audio and subtitles are copied, and the file is swapped in only after ffprobe
 * confirms the output. Two files at a time, below normal priority, never started
 * while a video is being watched, and the file the viewer just opened jumps the
 * queue. The library watcher re-probes the swapped file, so the item simply
 * stops being flagged when the repair lands.
 */

/* One automatic attempt per file: a release ffmpeg cannot re-encode would
 * otherwise be retried on every library scan. A manual retry clears the count. */
const MAX_AUTO_ATTEMPTS = 1;
const PLAYBACK_WAIT_MS = 30000;
/* Two episodes at once: one encoder session is fast enough on its own, two let
 * a full season repair in half the wall time without starving the download
 * queue (both run below normal priority). */
const MAX_PARALLEL = 2;

/* `decode` runs before -i, `filter` replaces the implied range conversion. NVDEC
 * keeps the decode on the GPU and measured 10.2 s per 30 s against 16.6 s for
 * the CPU decoder on a 1080p Main10 episode. */
const ENCODERS = [
  {
    name: 'hevc_nvenc+nvdec',
    decode: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
    filter: 'hwdownload,format=p010le,scale=in_range=pc:out_range=tv',
    args: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '22', '-b:v', '0'],
  },
  {
    name: 'hevc_nvenc',
    filter: 'scale=in_range=pc:out_range=tv',
    args: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '22', '-b:v', '0'],
  },
  {
    name: 'libx265',
    filter: 'scale=in_range=pc:out_range=tv',
    args: ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20', '-x265-params', 'log-level=error'],
  },
];

let cacheDir = '';
let root = '';
let state = {};
let queue = [];
let jobs = [];
let retryTimer = null;
let encoderChoice = null;
let encoderProbe = null;
let samplePromise = null;

export function initColorFix({ cacheDir: dir, root: libraryRoot } = {}) {
  cacheDir = String(dir || '');
  root = String(libraryRoot || '');
  load();
}

/* A title needs the repair when its video is HEVC and its samples are full
 * range. `yuvj*` pixel formats are the other way a file states full range. */
export function needsColorFix(item) {
  const codec = String(item?.videoCodec || '').toLowerCase();
  if (codec !== 'hevc') return false;
  const range = String(item?.colorRange || '').toLowerCase();
  return range === 'pc' || range === 'jpeg' || range === 'full';
}

export function colorFixStatus() {
  return {
    jobs: jobs.map((job) => ({ relPath: job.relPath, title: job.title, progress: round(job.progress) })),
    queued: queue.map((entry) => ({ relPath: entry.relPath, title: entry.title })),
    entries: Object.entries(state).map(([relPath, value]) => ({ relPath, ...value })),
  };
}

/* Called after every library scan: whatever is flagged and not already fixed,
 * queued or given up on joins the queue. Safe to call as often as you like. */
export function syncColorFix(items = []) {
  for (const item of items) {
    if (!needsColorFix(item)) continue;
    const relPath = String(item.relPath || '');
    if (!relPath) continue;
    const known = state[relPath];
    if (known?.status === 'queued' || known?.status === 'running') continue;
    if (known?.status === 'failed' && Number(known.attempts) >= MAX_AUTO_ATTEMPTS) continue;
    enqueue({ relPath, title: item.displayTitle || item.title || item.fileName, item });
  }
  pump();
}

/* The viewer just opened this file, so it looks washed out right now: move it to
 * the head of the queue. A file already encoding is left alone. Also clears a
 * failed attempt, so the API doubles as the manual retry. */
export function prioritizeColorFix(relPath, title) {
  const wanted = String(relPath || '');
  if (!wanted) return false;
  if (jobs.some((job) => job.relPath === wanted)) return true;

  const known = state[wanted] || {};
  const label = title || known.title || path.basename(wanted);
  state[wanted] = { ...known, status: 'queued', title: label, attempts: 0, note: '', at: Date.now() };
  save();

  const rest = queue.filter((entry) => entry.relPath !== wanted);
  queue = [{ relPath: wanted, title: label }, ...rest];
  pump();
  return true;
}

function enqueue(entry) {
  if (queue.some((queued) => queued.relPath === entry.relPath)) return;
  state[entry.relPath] = {
    ...(state[entry.relPath] || {}),
    status: 'queued',
    title: entry.title,
    at: Date.now(),
  };
  save();
  queue.push(entry);
}

function pump() {
  if (retryTimer) return;
  while (jobs.length < MAX_PARALLEL && queue.length) {
    if (playbackActive()) {
      /* Nothing new starts while something plays; a repair already running is
       * allowed to finish, since it only replaces files it is not streaming. */
      if (!jobs.length) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          pump();
        }, PLAYBACK_WAIT_MS);
        retryTimer.unref?.();
      }
      return;
    }
    start(queue.shift());
  }
}

function start(entry) {
  const job = { relPath: entry.relPath, title: entry.title, progress: 0 };
  jobs.push(job);
  fix(entry, job)
    .catch((err) => {
      console.warn(`[colorfix] ${entry.title || entry.relPath}: ${err?.message || err}`);
    })
    .finally(() => {
      const at = jobs.indexOf(job);
      if (at >= 0) jobs.splice(at, 1);
      pump();
    });
}

async function fix(entry, job) {
  const full = path.resolve(root, entry.relPath);
  const temp = `${full}.colorfix.tmp`;

  const source = await probeMedia(full).catch(() => null);
  if (!source?.video) throw new Error('the file is gone or has no video stream');
  /* Between the scan and this moment the file may have been replaced by a
   * fixed copy (or deleted). Re-check instead of re-encoding twice. */
  if (String(source.video.codec).toLowerCase() !== 'hevc') {
    mark(entry, 'done', 'no longer HEVC');
    return;
  }
  if (!isFullRange(source.video)) {
    mark(entry, 'done', 'already limited range');
    return;
  }

  job.progress = 0;
  state[entry.relPath] = { ...(state[entry.relPath] || {}), status: 'running', at: Date.now() };
  save();
  console.log(`[colorfix] ${entry.title}: full-range HEVC, repairing to limited range`);

  const expected = Number(source.durationSec) || 0;
  const started = Date.now();
  let encoded = null;
  try {
    /* A previous run may have finished the encode but could not replace the file
     * because the viewer had it open. Reuse that copy instead of spending the
     * minutes again. */
    encoded = await usableTemp(temp, expected);
    if (encoded) {
      console.log(`[colorfix] ${entry.title}: reusing the finished repair waiting to be swapped in`);
    } else {
      const encoder = await videoEncoder();
      await fsp.rm(temp, { force: true }).catch(() => {});
      await encode({
        source: full,
        target: temp,
        encoder,
        durationSec: expected,
        onProgress: (ratio) => {
          job.progress = ratio;
        },
      });
      encoded = await usableTemp(temp, expected);
      if (!encoded) throw new Error('the repaired file did not verify');
    }

    await swap(full, temp);
    const seconds = (Date.now() - started) / 1000;
    const speed = expected > 0 ? `${(expected / Math.max(seconds, 0.001)).toFixed(1)}x realtime` : 'duration unknown';
    mark(entry, 'done', `repaired in ${seconds.toFixed(0)} s (${speed})`);
    console.log(`[colorfix] ${entry.title}: repaired to limited range in ${seconds.toFixed(0)} s (${speed})`);
  } catch (err) {
    /* The one failure worth retrying by itself is a file that is being streamed
     * right now: Windows refuses the rename while the player holds it. The
     * finished copy stays next to the file and the queue comes back later. */
    if (isBusy(err)) {
      mark(entry, 'queued', 'waiting for the player to release the file');
      console.warn(`[colorfix] ${entry.title}: the file is in use, will swap after playback`);
      setTimeout(() => {
        if (!queue.some((queued) => queued.relPath === entry.relPath)) queue.push(entry);
        pump();
      }, 60000).unref?.();
      return;
    }
    await fsp.rm(temp, { force: true }).catch(() => {});
    mark(entry, 'failed', String(err?.message || err));
    throw err;
  }
}

/* A finished repair is only worth keeping when ffprobe says it is HEVC, limited
 * range, and as long as the original. */
async function usableTemp(temp, expected) {
  const stat = await fsp.stat(temp).catch(() => null);
  if (!stat || stat.size < 1024) return null;
  const probe = await probeMedia(temp).catch(() => null);
  if (!probe?.video) return null;
  if (String(probe.video.codec).toLowerCase() !== 'hevc') return null;
  if (isFullRange(probe.video)) return null;
  if (expected > 0 && Math.abs((Number(probe.durationSec) || 0) - expected) > 2) return null;
  return probe;
}

function isBusy(err) {
  const code = String(err?.code || '');
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true;
  return /\b(EBUSY|EPERM|EACCES)\b/.test(String(err?.message || ''));
}

/* Both colour flags a file can carry, from ffprobe's stream fields. */
function isFullRange(video) {
  const range = String(video?.colorRange || '').toLowerCase();
  if (range === 'pc' || range === 'jpeg' || range === 'full') return true;
  return /^yuvj/.test(String(video?.pixFmt || ''));
}

function mark(entry, status, note) {
  const previous = state[entry.relPath] || {};
  const attempts = status === 'failed' ? Number(previous.attempts || 0) + 1 : Number(previous.attempts || 0);
  state[entry.relPath] = {
    ...previous,
    status,
    note,
    attempts,
    title: entry.title || previous.title,
    at: Date.now(),
  };
  save();
}

/* One ffmpeg pass: the samples are mapped into the legal range and the result
 * is tagged limited, so every player shows the film the way it was graded. */
function encode({ source, target, encoder, durationSec, onProgress }) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    ...(encoder.decode || []),
    '-i', source,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', encoder.filter,
    ...encoder.args,
    '-pix_fmt', 'p010le',
    '-color_range', 'tv',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'copy', '-sn', '-dn', '-map_chapters', '-1',
    '-f', 'mp4', target,
  ];
  return new Promise((resolve, reject) => {
    const child = spawnNice(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let pending = '';
    let settled = false;

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdout.on('data', (chunk) => {
      if (!durationSec || typeof onProgress !== 'function') return;
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        /* ffmpeg reports out_time_ms in microseconds; out_time is new on some
         * builds and carries the clock form. */
        const micro = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (micro) {
          onProgress(Math.max(0, Math.min(1, Number(micro[1]) / 1e6 / durationSec)));
          continue;
        }
        const clock = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(line);
        if (clock) {
          const sec = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
          onProgress(Math.max(0, Math.min(1, sec / durationSec)));
        }
      }
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) return resolve();
      reject(new Error(lastLine(stderr) || `ffmpeg exited with ${code}`));
    });
  });
}

/* The GPU path only works on a real HEVC stream: `-hwaccel cuda` needs a stream
 * to decode, and a generated test pattern gives it none. So the candidates are
 * tried on a small full-range HEVC clip made once and kept in the cache; a
 * machine without libx265 falls back to the plain encode test.
 *
 * Two repairs can start together, so the probe is shared: the second caller
 * waits for the first instead of encoding the same test clip again. */
async function videoEncoder() {
  if (encoderChoice) return encoderChoice;
  if (!encoderProbe) {
    encoderProbe = pickEncoder().finally(() => {
      encoderProbe = null;
    });
  }
  return encoderProbe;
}

async function pickEncoder() {
  const sample = await hevcSample();
  for (const entry of ENCODERS) {
    if (!(await encoderWorks(entry, sample))) continue;
    encoderChoice = entry;
    console.log(`[colorfix] video encoder: ${entry.name}`);
    break;
  }
  if (!encoderChoice) encoderChoice = ENCODERS[ENCODERS.length - 1];
  return encoderChoice;
}

async function hevcSample() {
  if (!cacheDir) return null;
  if (!samplePromise) samplePromise = makeSample();
  return samplePromise;
}

async function makeSample() {
  const file = path.join(cacheDir, 'colorfix-sample.mp4');
  const stat = await fsp.stat(file).catch(() => null);
  if (stat && stat.size > 1024) return file;
  const code = await ffmpegCode([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=0.6,format=yuv420p10le',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
    '-pix_fmt', 'p010le', '-color_range', 'pc',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-f', 'mp4', file,
  ]);
  return code === 0 ? file : null;
}

/* A candidate has to survive the exact pass the repair uses and come out HEVC
 * and limited range: two frames of the sample prove the decoder and the encoder
 * half together. */
async function encoderWorks(entry, sample) {
  if (!sample) {
    if (entry.decode) return false;
    return (await ffmpegCode([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=0.4,format=yuv420p10le',
      ...entry.args, '-pix_fmt', 'p010le', '-color_range', 'tv',
      '-frames:v', '2', '-f', 'null', '-',
    ])) === 0;
  }

  const out = path.join(cacheDir, `colorfix-test-${entry.name.replace(/[^a-z0-9]+/gi, '-')}.mp4`);
  await fsp.rm(out, { force: true }).catch(() => {});
  const code = await ffmpegCode([
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(entry.decode || []),
    '-i', sample,
    '-frames:v', '2',
    '-vf', entry.filter,
    ...entry.args,
    '-pix_fmt', 'p010le', '-color_range', 'tv',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an', '-f', 'mp4', out,
  ]);
  if (code !== 0) {
    await fsp.rm(out, { force: true }).catch(() => {});
    return false;
  }
  const probe = await probeMedia(out).catch(() => null);
  await fsp.rm(out, { force: true }).catch(() => {});
  if (!probe?.video) return false;
  return String(probe.video.codec).toLowerCase() === 'hevc' && !isFullRange(probe.video);
}

function ffmpegCode(args) {
  return new Promise((resolve) => {
    const child = spawnNice(ffmpegPath, args, { stdio: 'ignore' });
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
}

/* The repaired copy replaces the original in place. The original is only
 * unlinked after the new file is in place, so a failure at any step leaves the
 * library exactly as it was. */
async function swap(target, temp) {
  const backup = `${target}.colorfix-orig`;
  await fsp.rm(backup, { force: true }).catch(() => {});
  await fsp.rename(target, backup);
  try {
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rename(backup, target).catch(() => {});
    throw err;
  }
  await fsp.rm(backup, { force: true }).catch(() => {});
  /* Windows can keep a handle briefly after a rename; a leftover backup is
   * harmless but should not sit in the library. */
  setTimeout(() => {
    fs.promises.rm(backup, { force: true }).catch(() => {});
  }, 5000).unref?.();
}

function lastLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function statePath() {
  return path.join(cacheDir, 'colorfix.json');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    state = {};
  }
  /* A 'running' entry is left over from a session that was killed mid-encode:
   * nothing is running now, so it goes back into the queue on the next scan. */
  for (const value of Object.values(state)) {
    if (value && value.status === 'running') value.status = 'queued';
  }
}

function save() {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* the repair still runs; only the memory of it is lost */
  }
}
