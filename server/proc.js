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
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { isOffline } from './settings.js';
import { gateError } from './net.js';

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

/* A child process reaches the internet on its own: aria2c joins a swarm through
 * its trackers, yt-dlp talks to YouTube, ffmpeg pulls an HLS playlist. None of
 * that passes through `fetch`, so net.js cannot see it. This is the same gate
 * one level down, on the command line that would start it: while offline, a
 * command that names a remote source is refused before the process exists.
 * `ytsearch5:` is included because yt-dlp turns it into a YouTube query. */
const REMOTE_ARG = /^(?:https?|wss?|ftps?|magnet|srv|rtmp|rtsp|ytsearch\d*):/i;

function remoteSourceArg(args) {
  const list = Array.isArray(args) ? args : [];
  const hit = list.find((arg) => REMOTE_ARG.test(String(arg).trim()));
  return hit ? String(hit).trim() : '';
}

export function offlineBlockedCommand(cmd, args) {
  if (!isOffline()) return '';
  const hit = remoteSourceArg(args);
  if (!hit) return '';
  return `${path.basename(String(cmd))} ${hit.slice(0, 120)}`;
}

/* Children that are talking to a remote source right now. The offline switch
 * ends them: a download that started while online must not keep pulling packets
 * after the switch is on. */
const remoteChildren = new Set();

function trackRemoteChild(child, args) {
  if (!child || !remoteSourceArg(args)) return child;
  remoteChildren.add(child);
  child.once('close', () => remoteChildren.delete(child));
  return child;
}

/** Kill every child that is currently reading from a remote source. */
export function stopRemoteChildren() {
  const killed = [...remoteChildren];
  for (const child of killed) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* best effort */
      }
    }
  }
  remoteChildren.clear();
  return killed.length;
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
/* Subtitle demux is a text copy with no decode: two runs keep three finishing
 * downloads from queueing behind each other's extraction. */
const subsLane = createLane(2);
/* Artwork thumbnails are short single-frame jobs; two at a time keeps a cold
 * card grid from queueing behind a hero build. */
const artLane = createLane(2);

const LANES = { probe: probeLane, art: artLane, media: mediaLane, subs: subsLane };
const laneFor = (name) => LANES[name] || mediaLane;

/* Promise wrapper around execFile. `lane` is 'media' (default), 'probe' or
 * 'art'; `timeout: 0` means no timeout (used by the dub remux). `encoding:
 * 'buffer'` returns raw bytes for callers that read PCM instead of text. */
export function run(cmd, args, { timeout = 30000, maxBuffer = DEFAULT_MAX_BUFFER, lane = 'media', encoding = 'utf8' } = {}) {
  return laneFor(lane)(() => new Promise((resolve, reject) => {
    const blocked = offlineBlockedCommand(cmd, args);
    if (blocked) {
      reject(gateError(blocked));
      return;
    }
    const child = execFile(cmd, args, {
      timeout,
      windowsHide: true,
      maxBuffer,
      encoding,
    }, (err, stdout, stderr) => {
      if (err) {
        if (stderr) err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    trackRemoteChild(child, args);
    nice(child);
  }));
}

/* spawn for jobs that stream output (HLS download, long remux). The caller owns
 * the child; this only sets its priority. */
export function spawnNice(cmd, args, options = {}) {
  const blocked = offlineBlockedCommand(cmd, args);
  if (blocked) throw gateError(blocked);
  return trackRemoteChild(nice(spawn(cmd, args, { windowsHide: true, ...options })), args);
}

/* Long, user-initiated work (a remux) only steps aside while something is
 * actually playing. Below-normal priority cost a hardware encoder about 40 %
 * of its throughput for no benefit on an idle machine. */
export function spawnMedia(cmd, args, options = {}) {
  const blocked = offlineBlockedCommand(cmd, args);
  if (blocked) throw gateError(blocked);
  const child = spawn(cmd, args, { windowsHide: true, ...options });
  trackRemoteChild(child, args);
  return playbackActive() ? nice(child) : child;
}
