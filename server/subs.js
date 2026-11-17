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

/* SubStation Alpha (.ass/.ssa) is what anime releases and most OpenSubtitles
 * uploads carry. Its events are not WebVTT cues: copied through as-is the file
 * parses to zero cues, so a fetched track looks like "no subtitles" even though
 * the download worked. Read the Events section and write real cues: the
 * timestamps move to HH:MM:SS.mmm, override blocks and line-break escapes turn
 * into plain cue text. */
function assStamp(value) {
  const match = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(String(value || ''));
  if (!match) return NaN;
  const fraction = Number(String(match[4] || '0').padEnd(3, '0')) / 1000;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

function assToVtt(source) {
  const lines = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let fields = null;
  const cues = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[events\]$/i.test(trimmed)) {
      inEvents = true;
      fields = null;
      continue;
    }
    if (/^\[/.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(trimmed)) {
      fields = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map((name) => name.trim().toLowerCase());
      continue;
    }
    if (!fields || !/^dialogue\s*:/i.test(trimmed)) continue;
    const startAt = fields.indexOf('start');
    const endAt = fields.indexOf('end');
    const textAt = fields.indexOf('text');
    if (startAt < 0 || endAt < 0 || textAt < 0) continue;
    // The text field is last and may itself contain commas.
    const parts = trimmed.slice(trimmed.indexOf(':') + 1).split(',');
    if (parts.length <= textAt) continue;
    const start = assStamp(parts[startAt]);
    const end = assStamp(parts[endAt]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = parts.slice(textAt).join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .replace(/<[^>]*>/g, '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean)
      .join('\n');
    if (!text) continue;
    cues.push({ start, end, text });
  }
  if (!cues.length) return '';
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  /* A sign and the line it translates can share one span. One cue with both
   * lines reads better than two cues the player has to choose between. */
  const merged = [];
  for (const cue of cues) {
    const last = merged[merged.length - 1];
    if (last && last.start === cue.start && last.end === cue.end) {
      if (!last.text.split('\n').includes(cue.text)) last.text += `\n${cue.text}`;
      continue;
    }
    merged.push({ ...cue });
  }
  const stamp = (seconds) => {
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  return `WEBVTT\n\n${merged.map((cue) => `${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}

export function vttFromSubtitle(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(clean)) return clean.endsWith('\n') ? clean : `${clean}\n`;
  // SubStation Alpha: [Script Info]/[Events] with Dialogue lines.
  if (/^\s*\[script info\]/i.test(clean) || /^\s*\[events\]/im.test(clean) || /^\s*dialogue\s*:/im.test(clean)) {
    const converted = assToVtt(clean);
    if (converted) return converted;
  }
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

/* Cue start/end pairs, in seconds. */
function cueSpans(body) {
  const re = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/g;
  const toSec = (h, m, s, ms) => (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0')) / 1000;
  const out = [];
  let match;
  while ((match = re.exec(String(body || '')))) {
    out.push({ start: toSec(match[1], match[2], match[3], match[4]), end: toSec(match[5], match[6], match[7], match[8]) });
  }
  return out;
}

function parseStamp(value) {
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

function formatStamp(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/*
 * A subtitle file is timed against one video. A release can carry a track that
 * was timed against a different one - the usual case is a 23.976 fps subtitle
 * inside a 25 fps PAL transfer, which lands later and later until it is minutes
 * off by the end. The companion tracks of the same release are timed for the
 * file that is actually on disk, so their cue starts give the correction:
 * `video = slug * t + offset`, fitted by counting how many of this track's cues
 * land inside the reference's cues.
 *
 * Only a slope that is really different from 1 is reported: two tracks of the
 * same cut can differ by a small constant lead, and shifting those would break
 * a file that was fine. Null means "leave the track alone".
 */
export function fitSubtitleTiming(body, reference) {
  const cues = cueSpans(body);
  const ref = cueSpans(reference).sort((a, b) => a.start - b.start);
  if (cues.length < 20 || ref.length < 20) return null;
  if (ref[ref.length - 1].end - ref[0].start < 600) return null; // a forced track covers scenes, not a film

  const inside = (t) => {
    let lo = 0;
    let hi = ref.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ref[mid].start <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = at; i >= 0 && ref[i].start >= t - 180; i -= 1) {
      if (t <= ref[i].end + 0.5) return true;
    }
    return false;
  };

  let best = { slope: 1, offset: 0, hits: -1 };
  for (let slope = 0.9; slope <= 1.1001; slope += 0.005) {
    for (let offset = -40; offset <= 40.001; offset += 0.5) {
      let hits = 0;
      for (const cue of cues) if (inside(cue.start * slope + offset)) hits += 1;
      if (hits > best.hits) best = { slope, offset, hits };
    }
  }
  const seed = best;
  for (let slope = seed.slope - 0.01; slope <= seed.slope + 0.0101; slope += 0.0005) {
    for (let offset = seed.offset - 1; offset <= seed.offset + 1.001; offset += 0.05) {
      let hits = 0;
      for (const cue of cues) if (inside(cue.start * slope + offset)) hits += 1;
      if (hits > best.hits) best = { slope, offset, hits };
    }
  }
  /* How well the track already sits on the reference. A track that is right
   * needs no help, and a *reference* that is the mistimed one must not be able
   * to drag a good track away: without this number the fit has no idea which of
   * the two sides is the odd one out. */
  let baseline = 0;
  for (const cue of cues) if (inside(cue.start)) baseline += 1;
  if (Math.abs(best.slope - 1) < 0.02) return null;
  if (best.hits < cues.length * 0.5) return null;
  return { ...best, baseline, total: cues.length };
}

/* The same file, every cue moved by `t = t * slope + offset`. Cues that would
 * land before the start of the film are dropped; the text is untouched. */
export function retimeSubtitle(body, fit = {}) {
  const slope = Number(fit.slope);
  const offset = Number(fit.offset);
  if (!Number.isFinite(slope) || !Number.isFinite(offset)) return null;
  const out = [];
  for (const block of String(body || '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const idx = lines.findIndex((line) => line.includes('-->'));
    if (idx < 0) continue;
    const text = lines.slice(idx + 1).join('\n').trim();
    if (!text) continue;
    const [a, b] = lines[idx].split('-->');
    const start = parseStamp(a) * slope + offset;
    const end = parseStamp(String(b).trim().split(/\s+/)[0]) * slope + offset;
    if (end <= 0) continue;
    out.push(`${formatStamp(start)} --> ${formatStamp(end)}\n${text}`);
  }
  if (out.length < 10) return null;
  return `WEBVTT\n\n${out.join('\n\n')}\n`;
}

/*
 * Makes `<stem>.en.vtt` agree with the video by fitting it against the other
 * subtitle tracks of the same release. Runs at install time, on the real file,
 * so a re-download of the same title comes out right without anyone touching
 * it. Returns the fit when the file was rewritten, null when it was left alone.
 */
export async function retimeEnglishSidecar(stem, tracks = [], { full = '' } = {}) {
  const english = `${stem}.en.vtt`;
  let body;
  try {
    body = await fsp.readFile(english, 'utf8');
  } catch {
    return null;
  }
  let best = null;
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || track.lang === 'en' || !track.path) continue;
    let reference;
    try {
      reference = await fsp.readFile(track.path, 'utf8');
    } catch {
      continue;
    }
    const fit = fitSubtitleTiming(body, reference);
    /* Only a track that is measurably *worse* than its fitted version may be
     * rewritten. Two tracks of the same cut score high at slope 1; a track
     * timed to another cut scores low and jumps once the slope is applied. */
    if (!fit || fit.hits < fit.baseline + fit.total * 0.15) continue;
    if (!best || fit.hits > best.fit.hits) best = { fit, lang: track.lang };
    /* A season pack can carry thirty languages. Once a reference explains most
     * of the track, the next twenty fits cannot improve the answer. */
    if (best.fit.hits >= best.fit.total * 0.8) break;
  }
  if (!best) return null;
  const retimed = retimeSubtitle(body, best.fit);
  if (!retimed) return null;
  /* Subtitles cannot run past the end of the film, and the implied source
   * frame rate has to be one that exists. A track timed to another cut maps
   * onto a plausible fps (a 23.976 subtitle inside a 25 fps transfer fits at
   * slope 23.976/25); a fit that would imply, say, 26.1 fps is the pair
   * disagreeing in the other direction - there the sidecar was right. */
  if (full) {
    const probe = await probeMedia(full).catch(() => null);
    const durationSec = Number(probe?.durationSec) || 0;
    if (durationSec > 0 && cueStats(retimed).end > durationSec + 60) return null;
    const fps = Number(probe?.video?.fps) || 0;
    if (fps > 0) {
      const implied = best.fit.slope * fps;
      const known = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
      if (!known.some((rate) => Math.abs(implied - rate) / rate <= 0.02)) return null;
    }
  }
  await fsp.writeFile(english, retimed, 'utf8');
  return { ...best.fit, lang: best.lang };
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
  /* 90 % of the container was too strict: a feature's last line lands before
   * the end credits start, so a correct track on an 87-minute file (credits
   * from 80:35, last line 77:12) ends at 89 % and was thrown away - and the
   * replacement fetched for it was timed to another cut. 85 % still rejects the
   * first half of a two-CD rip (it stops at 50 %). */
  const enough = durationSec > 0 ? durationSec * 0.85 : 0;
  /* A cue every 20 s is a talkative film; A Quiet Place legitimately carries
   * 137 in 87 minutes. A forced track (foreign dialogue only) is a few dozen
   * lines for the whole runtime, so one cue a minute still tells them apart. */
  const enoughCues = durationSec > 0 ? Math.max(24, durationSec / 60) : 0;

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