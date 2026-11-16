import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { resolveImdbId, isImdbId } from './imdb.js';
import { isOffline } from './settings.js';
import { getDb, transaction, hash32 } from './db.js';
import { probeMedia } from './torrent.js';

/**
 * Subtitle fallback. Castle ships its own .vtt tracks; when English is missing
 * (or a local file has no sidecars at all), the keyless OpenSubtitles REST API
 * is queried and the result is written as <video>.en.vtt next to the file.
 */

const REST = 'https://rest.opensubtitles.org/search';
const AGENT = 'TemporaryUserAgent';
const LANG_CODES = { en: 'eng', fr: 'fre', ar: 'ara', it: 'ita', es: 'spa', de: 'ger', pt: 'por' };

const SUBTITLE_LABELS = {
  en: 'English', fr: 'Français', ar: 'العربية', it: 'Italiano', es: 'Español',
  de: 'Deutsch', pt: 'Português', nl: 'Nederlands', pl: 'Polski', ru: 'Русский',
  tr: 'Türkçe', ja: '日本語', ko: '한국어', zh: '中文', hi: 'हिन्दी',
  th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu',
  tl: 'Filipino', sv: 'Svenska', da: 'Dansk', no: 'Norsk', fi: 'Suomi',
  cs: 'Čeština', el: 'Ελληνικά', he: 'עברית', hu: 'Magyar', ro: 'Română',
  uk: 'Українська', bg: 'Български', hr: 'Hrvatski', sr: 'Српски', sk: 'Slovenčina',
};
const SUBTITLE_ORDER = ['en', 'fr', 'ar', 'it'];

function rankOf(lang) {
  const index = SUBTITLE_ORDER.indexOf(lang);
  return index >= 0 ? index : SUBTITLE_ORDER.length;
}

/* Read the .vtt sidecars once, with their text. A directory mtime check means
 * this only happens when a track is added or removed. */
function scanSidecars(full) {
  let names;
  try {
    names = fs.readdirSync(path.dirname(full));
  } catch {
    return [];
  }
  const stem = path.basename(full).replace(/\.[^.]+$/, '').toLowerCase();
  const tracks = [];
  const seen = new Set();
  for (const name of names) {
    if (!/\.vtt$/i.test(name)) continue;
    const base = name.replace(/\.vtt$/i, '');
    if (!base.toLowerCase().startsWith(stem)) continue;
    const suffix = base.slice(stem.length);
    const match = /\.([a-z]{2,3})$/i.exec(suffix);
    const lang = match ? match[1].toLowerCase() : '';
    if (!lang || seen.has(lang)) continue;
    seen.add(lang);
    const file = path.join(path.dirname(full), name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size < 20 || stat.size > 4 * 1024 * 1024) continue;
      tracks.push({
        lang,
        label: SUBTITLE_LABELS[lang] || lang.toUpperCase(),
        body: fs.readFileSync(file, 'utf8'),
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
      });
    } catch {
      /* unreadable sidecar; skip it */
    }
  }
  return tracks.sort((a, b) => rankOf(a.lang) - rankOf(b.lang) || a.lang.localeCompare(b.lang));
}

function summarize(tracks) {
  return tracks.map((track) => ({ lang: track.lang, label: track.label, size: track.size }));
}

/* The .vtt file for one language, if it is still there. */
function sidecarFile(full, lang) {
  const wanted = String(lang || '').toLowerCase();
  if (!wanted) return null;
  let names;
  try {
    names = fs.readdirSync(path.dirname(full));
  } catch {
    return null;
  }
  const stem = path.basename(full).replace(/\.[^.]+$/, '').toLowerCase();
  for (const name of names) {
    if (!/\.vtt$/i.test(name)) continue;
    const base = name.replace(/\.vtt$/i, '');
    if (!base.toLowerCase().startsWith(stem)) continue;
    if (!base.toLowerCase().endsWith(`.${wanted}`)) continue;
    return path.join(path.dirname(full), name);
  }
  return null;
}

/* Tracks for one item, from catalog.db when the directory has not changed. */
export function syncSubtitleTracks(item, full) {
  const db = getDb();
  const dir = path.dirname(full);
  let dirMtime = 0;
  try {
    dirMtime = Math.round(fs.statSync(dir).mtimeMs);
  } catch {
    return [];
  }

  if (db && item) {
    try {
      const scan = db.prepare('SELECT dir_mtime FROM subtitle_scans WHERE item_id = ?').get(item.id);
      if (scan && Number(scan.dir_mtime) === dirMtime) {
        const rows = db.prepare('SELECT lang, label, size, mtime FROM subtitles WHERE item_id = ?').all(item.id);
        /* The directory mtime does not move when an existing sidecar is
         * rewritten in place (which is how a truncated subtitle is replaced),
         * so the cached body has to be checked against the file itself. */
        const fresh = rows.length > 0 && rows.every((row) => {
          const file = sidecarFile(full, row.lang);
          if (!file) return false;
          try {
            return Math.round(fs.statSync(file).mtimeMs) === Number(row.mtime);
          } catch {
            return false;
          }
        });
        if (fresh) {
          return rows
            .map((row) => ({ lang: row.lang, label: row.label, size: Number(row.size) }))
            .sort((a, b) => rankOf(a.lang) - rankOf(b.lang) || a.lang.localeCompare(b.lang));
        }
      }
    } catch {
      /* fall through to a fresh scan */
    }
  }

  const tracks = scanSidecars(full);
  if (db && item) {
    try {
      transaction(() => {
        db.prepare('DELETE FROM subtitles WHERE item_id = ?').run(item.id);
        const insert = db.prepare(`INSERT INTO subtitles
          (item_id, lang, label, body, size, mtime, etag, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        const now = Date.now();
        for (const track of tracks) {
          insert.run(item.id, track.lang, track.label, track.body, track.size, track.mtime,
            `"${hash32(track.body)}"`, now);
        }
        db.prepare(`INSERT INTO subtitle_scans (item_id, dir_mtime, scanned_at)
          VALUES (?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET
            dir_mtime = excluded.dir_mtime,
            scanned_at = excluded.scanned_at`)
          .run(item.id, dirMtime, now);
      });
    } catch {
      /* sidecars still work without the index */
    }
  }
  return summarize(tracks);
}

/* Body for one track, straight from the database when possible. */
export function subtitleBody(item, full, lang) {
  const db = getDb();
  const wanted = String(lang).toLowerCase();
  if (db && item) {
    try {
      const row = db.prepare('SELECT body, etag, mtime FROM subtitles WHERE item_id = ? AND lang = ?')
        .get(item.id, wanted);
      /* Only while the file it came from is unchanged. A rewritten sidecar -
       * the fix for a subtitle that stopped halfway - must not be served from
       * the old cached body. */
      const file = sidecarFile(full, wanted);
      const stat = file ? fs.statSync(file) : null;
      if (row && stat && Math.round(stat.mtimeMs) === Number(row.mtime)) {
        return { body: row.body, etag: row.etag || `"${hash32(row.body)}"`, mtime: Number(row.mtime) || 0 };
      }
    } catch {
      /* fall back to the sidecar file */
    }
  }
  const track = scanSidecars(full).find((entry) => entry.lang === wanted);
  if (!track) return null;
  return { body: track.body, etag: `"${hash32(track.body)}"`, mtime: track.mtime };
}

export function vttFromSubtitle(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(clean)) return clean.endsWith('\n') ? clean : `${clean}\n`;
  // SRT: "00:00:01,000 --> 00:00:03,000" becomes VTT's dot separator.
  const body = clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}\n`;
}

/* Where the last cue ends and how many cues there are. An OpenSubtitles entry
 * is often the first half of an old two-CD rip: it reads perfectly for an hour
 * and then leaves the rest of the film bare, which looks exactly like
 * "subtitles are broken" to the person watching. The count matters too: a
 * forced track carries only the foreign dialogue, so it can span the whole
 * runtime with a few dozen lines. ffmpeg writes "MM:SS.mmm" below one hour and
 * "HH:MM:SS.mmm" above it, so the hours part is optional - matching only the
 * long form made every episode shorter than an hour look like it ended at
 * zero. */
function cueStats(text) {
  const re = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.]\d{1,3}\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})/g;
  let end = 0;
  let cues = 0;
  let match;
  while ((match = re.exec(String(text || '')))) {
    cues += 1;
    const seconds = (match[4] ? Number(match[4]) * 3600 : 0) + Number(match[5]) * 60 + Number(match[6]);
    if (seconds > end) end = seconds;
  }
  return { end, cues };
}

function lastCueSec(text) {
  return cueStats(text).end;
}

async function videoDurationSec(full, item) {
  const known = Number(item?.durationSec);
  if (known > 0) return known;
  try {
    const probe = await probeMedia(full);
    return Number(probe.durationSec) || 0;
  } catch {
    return 0;
  }
}

export async function fetchEnglishSubtitle({ imdbId, season = 0, episode = 0, lang = 'en', durationSec = 0 } = {}) {
  if (isOffline()) return null;
  const id = isImdbId(imdbId) ? String(imdbId).replace(/^tt/, '') : '';
  if (!id) return null;
  const parts = [`imdbid-${id}`];
  if (Number(season) > 0) parts.push(`season-${Number(season)}`);
  if (Number(episode) > 0) parts.push(`episode-${Number(episode)}`);
  parts.push(`sublanguageid-${LANG_CODES[lang] || lang}`);

  const res = await fetch(`${REST}/${parts.join('/')}`, {
    headers: { 'User-Agent': AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;

  // Prefer plain (not hearing-impaired) English, then one that is not the first
  // half of a two-CD rip, most downloaded first.
  const ranked = [...list].sort((a, b) => {
    const sdh = (Number(a.SubHearingImpaired) || 0) - (Number(b.SubHearingImpaired) || 0);
    if (sdh) return sdh;
    const part = Number(/cd\s*1|disc\s*1|part\s*1/i.test(String(a.SubFileName || '')))
      - Number(/cd\s*1|disc\s*1|part\s*1/i.test(String(b.SubFileName || '')));
    if (part) return part;
    return (Number(b.SubDownloadsCnt) || 0) - (Number(a.SubDownloadsCnt) || 0);
  });

  /* A full copy is required when the length is known; a short one is only
   * kept as a last resort so an episode never ends up with no text at all. */
  let best = null;
  let bestCoverage = 0;
  const enough = durationSec > 0 ? durationSec * 0.9 : 0;
  for (const hit of ranked.slice(0, 6)) {
    try {
      const link = hit.SubDownloadLink || '';
      if (!/^https:\/\//i.test(link)) continue;
      const download = await fetch(link, {
        headers: { 'User-Agent': AGENT, Referer: 'https://www.opensubtitles.org/' },
        signal: AbortSignal.timeout(20000),
      });
      if (!download.ok) continue;
      let buffer = Buffer.from(await download.arrayBuffer());
      if (/\.gz($|\?)/i.test(link) || (buffer[0] === 0x1f && buffer[1] === 0x8b)) {
        buffer = gunzipSync(buffer);
      }
      const text = vttFromSubtitle(buffer.toString('utf8'));
      if (text.length <= 40) continue;
      const coverage = lastCueSec(text);
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        best = text;
      }
      if (enough && coverage >= enough) return text;
    } catch {
      /* try the next candidate */
    }
  }
  if (best && durationSec > 0) {
    console.warn(`[subs] the best English subtitle covers ${(bestCoverage / 60).toFixed(0)} of ${(durationSec / 60).toFixed(0)} min`);
  }
  return best;
}

/* A failed lookup is retried only after a while: the player asks for the track
 * list every time it opens, and a title with no usable English subtitle on
 * OpenSubtitles must not pay two round trips per open. */
const attempts = new Map();
const ATTEMPT_TTL = 10 * 60 * 1000;

export async function ensureEnglishSubtitle(full, item = {}) {
  if (!full || !item || isOffline()) return false;
  const stem = full.slice(0, full.length - path.extname(full).length);
  const target = `${stem}.en.vtt`;
  const durationSec = await videoDurationSec(full, item);
  const enough = durationSec > 0 ? durationSec * 0.9 : 0;
  // A dialogue track keeps a cue every few seconds; a forced track (foreign
  // dialogue only) can span the whole episode with a few dozen lines, which an
  // end-time check alone happily accepts.
  const enoughCues = durationSec > 0 ? Math.max(24, durationSec / 20) : 0;

  /* An existing sidecar is only good while it covers the video and carries a
   * real dialogue track. The old check was "any file bigger than 40 bytes is
   * fine", which kept a first-half-only subtitle - and then a forced track -
   * forever. */
  let have = null;
  try {
    have = fs.readFileSync(target, 'utf8');
  } catch {
    have = null;
  }
  const stats = have && have.length > 40 ? cueStats(have) : null;
  if (stats && (!enough || (stats.end >= enough && stats.cues >= enoughCues))) return true;
  if (stats) {
    const reason = stats.end < enough
      ? `stops at ${(stats.end / 60).toFixed(0)} of ${(durationSec / 60).toFixed(0)} min`
      : `holds only ${stats.cues} cue(s) for ${(durationSec / 60).toFixed(0)} min (forced track?)`;
    console.log(`[subs] ${path.basename(target)} ${reason} - fetching a full copy`);
  }

  const attemptKey = `${target}:${stats?.end || 0}:${stats?.cues || 0}`;
  const tried = attempts.get(attemptKey);
  if (tried && Date.now() - tried < ATTEMPT_TTL) return Boolean(stats);

  const imdbId = await resolveImdbId({
    ...item,
    title: item.seriesTitle || item.title,
  });
  if (!imdbId) return false;
  const text = await fetchEnglishSubtitle({
    imdbId,
    season: item.season,
    episode: item.episode,
    durationSec,
  });
  if (!text) {
    attempts.set(attemptKey, Date.now());
    return false;
  }
  const next = cueStats(text);
  if (stats && next.cues <= stats.cues && next.end <= stats.end) {
    attempts.set(attemptKey, Date.now());
    return true;
  }
  await fsp.writeFile(target, text, 'utf8');
  attempts.delete(attemptKey);
  return true;
}