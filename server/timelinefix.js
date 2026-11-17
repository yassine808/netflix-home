import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { probeMedia, timelineIsBroken } from './torrent.js';
import { spawnNice, playbackActive } from './proc.js';

/**
 * Broken-timeline repair.
 *
 * Some releases are muxed with the frame reordering B-frames need missing from
 * the timestamps: several packets share one PTS, then PTS == DTS for the rest of
 * the file. The pictures are all there and ffmpeg decodes them in the right
 * order, but a browser trusts the container timeline, presents the frames as
 * they arrive and drops the ones that land late. Measured on one 1080p HEVC
 * film: 22-32% of frames dropped in Chromium, while a re-encode of the same
 * footage lost none, and every healthy file in the same library played clean.
 *
 * A re-encode is the repair: the encoder timestamps the decoded frames in
 * display order, so the output carries a correct timeline. The source depth is
 * kept (10-bit in, 10-bit Main out) and the audio is copied when it is already
 * AAC. The library watcher re-probes the swapped file, and the player reopens
 * the stream because the version changed.
 *
 * The repair starts when the player reports dropped frames and the server
 * confirms the timeline is broken, so a machine that is simply too slow is
 * never re-encoded for nothing.
 */

const PLAYBACK_WAIT_MS = 30000;

/* `decode` runs before -i; `filter` converts to the depth the encoder writes.
 * The same NVDEC path the downloads use keeps the decode on the GPU: a 10-bit
 * HEVC film re-encodes several times faster than it plays. */
const ENCODERS = [
  {
    name: 'hevc_nvenc+nvdec',
    decode: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
    filter: (format) => `scale_cuda=format=${format}`,
    args: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '22', '-b:v', '0'],
  },
  {
    name: 'hevc_nvenc',
    args: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '22', '-b:v', '0'],
  },
  {
    name: 'libx265',
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

export function initTimelineFix({ cacheDir: dir, root: libraryRoot } = {}) {
  cacheDir = String(dir || '');
  root = String(libraryRoot || '');
  load();
}

export function timelineFixStatus() {
  return {
    jobs: jobs.map((job) => ({ relPath: job.relPath, title: job.title, progress: round(job.progress) })),
    queued: queue.map((entry) => ({ relPath: entry.relPath, title: entry.title })),
    entries: Object.entries(state).map(([relPath, value]) => ({ relPath, ...value })),
  };
}

/* The player saw the frames go missing. Only a file whose timeline is actually
 * broken is queued: a slow machine, a 4K HDR file on a weak GPU or a busy disk
 * all drop frames too, and re-encoding those would cost minutes for nothing. */
export async function requestTimelineFix(relPath, title) {
  const wanted = String(relPath || '');
  if (!wanted) return { queued: false, reason: 'no file given' };
  if (jobs.some((job) => job.relPath === wanted)) return { queued: true };
  if (queue.some((entry) => entry.relPath === wanted)) return { queued: true };

  const full = path.resolve(root, wanted);
  const source = await probeMedia(full).catch(() => null);
  if (!source?.video) return { queued: false, reason: 'the file is gone or has no video stream' };
  if (!(await timelineIsBroken(full, source.video.hasBFrames))) {
    return { queued: false, reason: 'the timeline is not broken' };
  }

  enqueue({ relPath: wanted, title: title || path.basename(wanted), priority: true });
  pump();
  return { queued: true };
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
  while (!jobs.length && queue.length) {
    if (playbackActive() && !queue[0].priority) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        pump();
      }, PLAYBACK_WAIT_MS);
      retryTimer.unref?.();
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
      console.warn(`[timelinefix] ${entry.title || entry.relPath}: ${err?.message || err}`);
    })
    .finally(() => {
      const at = jobs.indexOf(job);
      if (at >= 0) jobs.splice(at, 1);
      pump();
    });
}

async function fix(entry, job) {
  const full = path.resolve(root, entry.relPath);
  const temp = `${full}.timelinefix.tmp`;

  const source = await probeMedia(full).catch(() => null);
  if (!source?.video) {
    mark(entry, 'done', 'the file is gone');
    return;
  }
  /* The file may already have been replaced (a new download, a colour repair)
   * between the request and this moment. */
  if (!(await timelineIsBroken(full, source.video.hasBFrames))) {
    mark(entry, 'done', 'the timeline is fine now');
    return;
  }

  job.progress = 0;
  state[entry.relPath] = { ...(state[entry.relPath] || {}), status: 'running', at: Date.now() };
  save();
  console.log(`[timelinefix] ${entry.title}: broken packet timeline, re-encoding to rebuild it`);

  const expected = Number(source.durationSec) || 0;
  const started = Date.now();
  let encoded = null;
  try {
    /* A previous run may have finished the encode but could not swap while the
     * player held the file. Reuse that copy instead of encoding it twice. */
    encoded = await usableTemp(temp, expected);
    if (encoded) {
      console.log(`[timelinefix] ${entry.title}: reusing the finished repair waiting to be swapped in`);
    } else {
      const encoder = await videoEncoder();
      await fsp.rm(temp, { force: true }).catch(() => {});
      await encode({
        source,
        sourceFile: full,
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
    console.log(`[timelinefix] ${entry.title}: timeline rebuilt in ${seconds.toFixed(0)} s (${speed})`);
  } catch (err) {
    /* Windows refuses the rename while the player holds the file. The finished
     * copy stays next to the file and the queue comes back after the player lets
     * go, instead of spending the minutes again. */
    if (isBusy(err)) {
      mark(entry, 'queued', 'waiting for the player to release the file');
      console.warn(`[timelinefix] ${entry.title}: the file is in use, will swap after playback`);
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

/* A finished repair is only worth keeping when it has a video stream, the same
 * duration, and a timeline the detector accepts. */
async function usableTemp(temp, expected) {
  const stat = await fsp.stat(temp).catch(() => null);
  if (!stat || stat.size < 1024) return null;
  const probe = await probeMedia(temp).catch(() => null);
  if (!probe?.video) return null;
  if (expected > 0 && Math.abs((Number(probe.durationSec) || 0) - expected) > 2) return null;
  if (await timelineIsBroken(temp, probe.video.hasBFrames)) return null;
  return probe;
}

function isBusy(err) {
  const code = String(err?.code || '');
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true;
  return /\b(EBUSY|EPERM|EACCES)\b/.test(String(err?.message || ''));
}

function mark(entry, status, note) {
  const previous = state[entry.relPath] || {};
  state[entry.relPath] = {
    ...previous,
    status,
    note,
    title: entry.title || previous.title,
    at: Date.now(),
  };
  save();
}

function isTenBit(pixFmt) {
  return /10le|12le|p010/i.test(String(pixFmt || ''));
}

/* One ffmpeg pass. The video is re-encoded at the source depth, so the picture
 * keeps its 10 bits and HDR releases keep their transfers; audio is copied when
 * it is already AAC, because a Chromium player cannot decode E-AC3 in MP4. */
function encode({ source, sourceFile, target, encoder, durationSec, onProgress }) {
  const tenBit = isTenBit(source.video?.pixFmt);
  const format = tenBit ? 'p010le' : 'nv12';
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    ...(encoder.decode || []),
    '-i', sourceFile,
    '-map', '0:v:0',
  ];
  const filter = typeof encoder.filter === 'function' ? encoder.filter(format) : '';
  if (filter) args.push('-vf', filter);
  args.push(...encoder.args, '-pix_fmt', format === 'nv12' ? 'yuv420p' : 'yuv420p10le');
  if (String(source.video?.colorRange || '').toLowerCase() === 'pc') args.push('-color_range', 'pc');

  const audio = Array.isArray(source.audio) ? source.audio : [];
  audio.forEach((track, position) => {
    args.push('-map', `0:${Number(track.index)}`);
    const codec = String(track.codec || '').toLowerCase();
    if (codec === 'aac') {
      args.push(`-c:a:${position}`, 'copy');
      return;
    }
    args.push(
      `-c:a:${position}`, 'aac',
      `-b:a:${position}`, Number(track.channels) > 2 ? '448k' : '192k',
      `-ac:a:${position}`, Number(track.channels) > 2 ? '6' : '2',
    );
  });
  audio.forEach((track, position) => {
    const lang = String(track.lang || '').trim();
    if (/^[a-z]{2,3}$/.test(lang)) args.push(`-metadata:s:a:${position}`, `language=${lang}`);
    args.push('-disposition:a:' + position, position === 0 ? 'default' : '0');
  });

  args.push('-tag:v', 'hvc1', '-sn', '-dn', '-map_chapters', '-1', '-f', 'mp4', target);

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
        /* ffmpeg reports out_time_ms in microseconds. */
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

/* The GPU path needs a real stream, so the candidates are proved on a small
 * 10-bit HEVC clip made once in the cache. Two repairs can start together, so
 * the probe is shared. */
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
    console.log(`[timelinefix] video encoder: ${entry.name}`);
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
  const file = path.join(cacheDir, 'timelinefix-sample.mp4');
  const stat = await fsp.stat(file).catch(() => null);
  if (stat && stat.size > 1024) return file;
  const code = await ffmpegCode([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=0.6,format=yuv420p10le',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
    '-pix_fmt', 'yuv420p10le', '-f', 'mp4', file,
  ]);
  return code === 0 ? file : null;
}

async function encoderWorks(entry, sample) {
  if (!sample) {
    if (entry.decode) return false;
    return (await ffmpegCode([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=0.4,format=yuv420p10le',
      ...entry.args, '-pix_fmt', 'yuv420p10le',
      '-frames:v', '2', '-f', 'null', '-',
    ])) === 0;
  }

  const out = path.join(cacheDir, `timelinefix-test-${entry.name.replace(/[^a-z0-9]+/gi, '-')}.mp4`);
  await fsp.rm(out, { force: true }).catch(() => {});
  const filter = typeof entry.filter === 'function' ? entry.filter('p010le') : '';
  const code = await ffmpegCode([
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(entry.decode || []),
    '-i', sample,
    '-frames:v', '2',
    ...(filter ? ['-vf', filter] : []),
    ...entry.args,
    '-pix_fmt', 'yuv420p10le',
    '-an', '-f', 'mp4', out,
  ]);
  if (code !== 0) {
    await fsp.rm(out, { force: true }).catch(() => {});
    return false;
  }
  const probe = await probeMedia(out).catch(() => null);
  await fsp.rm(out, { force: true }).catch(() => {});
  return Boolean(probe?.video);
}

function ffmpegCode(args) {
  return new Promise((resolve) => {
    const child = spawnNice(ffmpegPath, args, { stdio: 'ignore' });
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
}

/* The repaired copy replaces the original in place, and only after the new file
 * is complete: a failure at any step leaves the library exactly as it was. */
async function swap(target, temp) {
  const backup = `${target}.timelinefix-orig`;
  await fsp.rm(backup, { force: true }).catch(() => {});
  await fsp.rename(target, backup);
  try {
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rename(backup, target).catch(() => {});
    throw err;
  }
  await fsp.rm(backup, { force: true }).catch(() => {});
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
  return path.join(cacheDir, 'timelinefix.json');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    state = {};
  }
  /* A 'running' entry is left over from a session killed mid-encode. */
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
