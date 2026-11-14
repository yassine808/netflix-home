import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { getDb, transaction } from './db.js';
import { run } from './proc.js';

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
  return run(cmd, args, {
    timeout,
    maxBuffer: 1024 * 1024 * 8,
    lane: cmd === ffprobePath ? 'probe' : 'media',
  });
}

export function audioLabel(track, position) {
  const lang = String(track?.lang || '').toLowerCase();
  const named = LANG_NAMES[lang] || (lang.length === 3 ? '' : '');
  if (track?.title) return track.title;
  if (named) return named;
  return `Audio track ${position + 1}`;
}

/* Tracks saved by a previous launch are trusted only while the source file
 * still has the same size and mtime; the probe then costs one indexed SELECT. */
function storedTracks(item) {
  const db = getDb();
  if (!db || !item) return null;
  try {
    const probe = db.prepare('SELECT source_size, source_mtime FROM audio_probe WHERE item_id = ?').get(item.id);
    if (!probe) return null;
    if (Number(probe.source_size) !== Number(item.size) || Number(probe.source_mtime) !== Number(item.mtime)) return null;
    const rows = db.prepare(`SELECT stream_index, position, lang, title, codec, channels, bit_rate, is_default, label, variant_path
      FROM audio_tracks WHERE item_id = ? ORDER BY position`).all(item.id);
    if (!rows.length) return null;
    return rows.map((row) => ({
      streamIndex: Number(row.stream_index),
      position: Number(row.position),
      lang: row.lang || '',
      title: row.title || '',
      codec: row.codec || '',
      channels: Number(row.channels) || 0,
      bitRate: Number(row.bit_rate) || 0,
      default: Number(row.is_default) === 1,
      label: row.label || '',
      variantPath: row.variant_path || null,
    }));
  } catch {
    return null;
  }
}

function saveTracks(item, tracks) {
  const db = getDb();
  if (!db || !item) return;
  try {
    transaction(() => {
      const previous = new Map(
        db.prepare('SELECT stream_index, variant_path FROM audio_tracks WHERE item_id = ?')
          .all(item.id).map((row) => [Number(row.stream_index), row.variant_path]),
      );
      db.prepare('DELETE FROM audio_tracks WHERE item_id = ?').run(item.id);
      const insert = db.prepare(`INSERT INTO audio_tracks
        (item_id, stream_index, position, lang, title, codec, channels, bit_rate, is_default, label, variant_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const track of tracks) {
        insert.run(item.id, track.streamIndex, track.position, track.lang || '', track.title || '',
          track.codec || '', track.channels || 0, track.bitRate || 0, track.default ? 1 : 0,
          track.label || '', previous.get(track.streamIndex) || track.variantPath || null);
      }
      db.prepare(`INSERT INTO audio_probe (item_id, source_size, source_mtime, probed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          source_size = excluded.source_size,
          source_mtime = excluded.source_mtime,
          probed_at = excluded.probed_at`)
        .run(item.id, Number(item.size) || 0, Number(item.mtime) || 0, Date.now());
    });
  } catch {
    /* the in-memory cache below still answers this run */
  }
}

/* Probes the audio streams of one file. Cached in SQLite until the file
 * changes, with a small in-memory layer in front for the player's requests. */
export async function probeAudioTracks(item, full) {
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return [];
  }
  const itemId = item?.id || null;
  const key = `${full}:${stat.mtimeMs}:${stat.size}`;
  const hit = probeCache.get(key);
  if (hit) return hit;

  const stored = storedTracks(item);
  if (stored?.length) {
    probeCache.set(key, stored);
    return stored;
  }

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
  if (itemId) saveTracks(item, tracks);
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
export async function ensureAudioVariant(item, full, track) {
  const tracks = await probeAudioTracks(item, full);
  const first = tracks[0];
  if (!first || !track || track.streamIndex === first.streamIndex) return full;
  if (!audioDir) return full;

  const saved = tracks.find((entry) => entry.streamIndex === track.streamIndex)?.variantPath;
  if (saved) {
    try {
      if ((await fsp.stat(saved)).size > 1024) return saved;
    } catch {
      /* file was cleaned; rebuild below */
    }
  }

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
      const db = getDb();
      if (db && item) {
        try {
          db.prepare('UPDATE audio_tracks SET variant_path = ? WHERE item_id = ? AND stream_index = ?')
            .run(target, item.id, track.streamIndex);
        } catch {
          /* the file itself is still served */
        }
      }
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
