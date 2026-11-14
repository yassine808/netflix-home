/**
 * Child-process control for everything that touches media.
 *
 * ffmpeg and ffprobe are bursty: a hero build or a dub remux can saturate every
 * core for a few seconds while the UI is scrolling or a video is playing. Two
 * cheap measures keep the app feeling light:
 *
 *   1. Every child is put in BELOW_NORMAL priority, so the OS schedules the UI,
 *      the browser and playback ahead of it.
 *   2. Work is admitted through lanes: one heavy ffmpeg job at a time, a couple
 *      of ffprobe reads, and nothing heavy while a video is being served.
 *
 * Nothing here is required for correctness. If a task is refused because
 * playback is active, callers fall back to their normal on-demand path.
 */

import os from 'node:os';
import { execFile, spawn } from 'node:child_process';

const BELOW_NORMAL = os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/* Last time a media file was requested by the player. Heavy background work
 * waits while this is recent, so a hero build never fights a stream. */
let lastPlaybackAt = 0;
const PLAYBACK_WINDOW_MS = 20000;

export function notePlayback() {
  lastPlaybackAt = Date.now();
}

export function playbackActive(windowMs = PLAYBACK_WINDOW_MS) {
  return Date.now() - lastPlaybackAt < windowMs;
}

/* Lower a running child without failing the caller if the OS refuses. */
function nice(child) {
  if (!child || !child.pid) return child;
  try {
    os.setPriority(child.pid, BELOW_NORMAL);
  } catch {
    /* priority is a hint; the job still runs */
  }
  return child;
}

function createLane(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

/* One ffmpeg at a time; ffprobe reads are tiny and can overlap a little. */
const mediaLane = createLane(1);
const probeLane = createLane(3);
/* Artwork thumbnails are short single-frame jobs; two at a time keeps a cold
 * card grid from queueing behind a hero build. */
const artLane = createLane(2);

const LANES = { probe: probeLane, art: artLane, media: mediaLane };
const laneFor = (name) => LANES[name] || mediaLane;

/* Promise wrapper around execFile. `lane` is 'media' (default), 'probe' or
 * 'art'; `timeout: 0` means no timeout (used by the dub remux). */
export function run(cmd, args, { timeout = 30000, maxBuffer = DEFAULT_MAX_BUFFER, lane = 'media' } = {}) {
  return laneFor(lane)(() => new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      timeout,
      windowsHide: true,
      maxBuffer,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        if (stderr) err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    nice(child);
  }));
}

/* spawn for jobs that stream output (HLS download, long remux). The caller owns
 * the child; this only sets its priority. */
export function spawnNice(cmd, args, options = {}) {
  return nice(spawn(cmd, args, { windowsHide: true, ...options }));
}
