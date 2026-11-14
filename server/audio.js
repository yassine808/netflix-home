import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

/**
 * Audio-track support.
 *
 * Browsers play the first audio stream of an MP4 and Chrome gives no API to
 * switch between muxed tracks, so a dub is served as its own file: the original
 * is streamed untouched, and any other track is remuxed once (`-c copy`, no
 * re-encode) into <cache>\audio\ and cached by id + mtime + track index.
 */

const ffprobePath = ffprobeStatic.path;

const LANG_NAMES = {
  tha: 'Thai', eng: 'English', kor: 'Korean', jpn: 'Japanese', cmn: 'Chinese',
  zho: 'Chinese', hin: 'Hindi', spa: 'Spanish', por: 'Portuguese', fra: 'French',
  fre: 'French', deu: 'German', ger: 'German', ita: 'Italian', ara: 'Arabic',
  rus: 'Russian', tur: 'Turkish', vie: 'Vietnamese', ind: 'Indonesian',
  msa: 'Malay', fil: 'Filipino', nld: 'Dutch', dut: 'Dutch', pol: 'Polish',
  swe: 'Swedish', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish', ces: 'Czech',
  hun: 'Hungarian', ron: 'Romanian', ukr: 'Ukrainian', ell: 'Greek', heb: 'Hebrew',
};

let audioDir = null;
const probeCache = new Map();
const building = new Map();

export function initAudio(cacheDir) {
  audioDir = path.join(cacheDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
}

function execFileP(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function audioLabel(track, position) {
  const lang = String(track?.lang || '').toLowerCase();
  const named = LANG_NAMES[lang] || (lang.length === 3 ? '' : '');
  if (track?.title) return track.title;
  if (named) return named;
  return `Audio track ${position + 1}`;
}

/* Probes the audio streams of one file. Cached until the file changes. */
export async function probeAudioTracks(full) {
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return [];
  }
  const key = `${full}:${stat.mtimeMs}:${stat.size}`;
  const hit = probeCache.get(key);
  if (hit) return hit;

  let streams = [];
  try {
    const raw = await execFileP(ffprobePath, [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index,codec_name,channels,bit_rate:stream_tags=language,title:stream_disposition=default',
      '-of', 'json', full,
    ]);
    streams = JSON.parse(raw).streams || [];
  } catch {
    return [];
  }

  const tracks = streams.map((stream, position) => {
    const tags = stream.tags || {};
    const lang = String(tags.language || '').toLowerCase();
    return {
      streamIndex: Number(stream.index),
      position,
      lang: lang === 'und' ? '' : lang,
      title: String(tags.title || '').trim(),
      codec: String(stream.codec_name || ''),
      channels: Number(stream.channels) || 0,
      bitRate: Number(stream.bit_rate) || 0,
      default: Number(stream.disposition?.default) === 1,
    };
  });

  for (const track of tracks) track.label = audioLabel(track, track.position);
  if (probeCache.size > 60) probeCache.clear();
  probeCache.set(key, tracks);
  return tracks;
}

function variantPath(full, track, stat) {
  const hash = crypto.createHash('sha1')
    .update(`${full}:${Math.round(stat.mtimeMs)}:${stat.size}:${track.streamIndex}`)
    .digest('hex');
  return path.join(audioDir, `${hash}.mp4`);
}

/**
 * Returns a file whose first audio stream is `track`. The file's original
 * stream order is kept, so requesting the first track returns the source.
 */
export async function ensureAudioVariant(full, track) {
  const tracks = await probeAudioTracks(full);
  const first = tracks[0];
  if (!first || !track || track.streamIndex === first.streamIndex) return full;
  if (!audioDir) return full;

  const stat = await fsp.stat(full);
  const target = variantPath(full, track, stat);
  try {
    if ((await fsp.stat(target)).size > 1024) return target;
  } catch {
    /* not built yet */
  }

  const pending = building.get(target);
  if (pending) return pending;

  const job = (async () => {
    const part = `${target}.part`;
    await fsp.rm(part, { force: true }).catch(() => {});
    const args = [
      '-y', '-loglevel', 'error',
      '-i', full,
      '-map', '0:v:0',
      '-map', `0:a:${track.position}`,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-metadata:s:a:0', `language=${track.lang || 'und'}`,
      '-disposition:a:0', 'default',
      '-f', 'mp4', part,
    ];
    try {
      await execFileP(ffmpegPath, args, 0);
      await fsp.rm(target, { force: true }).catch(() => {});
      await fsp.rename(part, target);
      return target;
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {});
      throw err;
    } finally {
      building.delete(target);
    }
  })();

  building.set(target, job);
  return job;
}
