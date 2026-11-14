import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { resolveImdbId, isImdbId } from './imdb.js';
import { isOffline } from './settings.js';
import { getDb, transaction, hash32 } from './db.js';

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
        const rows = db.prepare('SELECT lang, label, size FROM subtitles WHERE item_id = ?').all(item.id);
        return rows
          .map((row) => ({ lang: row.lang, label: row.label, size: Number(row.size) }))
          .sort((a, b) => rankOf(a.lang) - rankOf(b.lang) || a.lang.localeCompare(b.lang));
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
  if (db && item) {
    try {
      const row = db.prepare('SELECT body, etag, mtime FROM subtitles WHERE item_id = ? AND lang = ?')
        .get(item.id, String(lang).toLowerCase());
      if (row) return { body: row.body, etag: row.etag || `"${hash32(row.body)}"`, mtime: Number(row.mtime) || 0 };
    } catch {
      /* fall back to the sidecar file */
    }
  }
  const track = scanSidecars(full).find((entry) => entry.lang === String(lang).toLowerCase());
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

export async function fetchEnglishSubtitle({ imdbId, season = 0, episode = 0, lang = 'en' } = {}) {
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

  // Prefer plain (not hearing-impaired) English, most downloaded first.
  const ranked = [...list].sort((a, b) => {
    const sdh = (Number(a.SubHearingImpaired) || 0) - (Number(b.SubHearingImpaired) || 0);
    if (sdh) return sdh;
    return (Number(b.SubDownloadsCnt) || 0) - (Number(a.SubDownloadsCnt) || 0);
  });
  for (const hit of ranked.slice(0, 4)) {
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
      if (text.length > 40) return text;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export async function ensureEnglishSubtitle(full, item = {}) {
  if (!full || !item || isOffline()) return false;
  const stem = full.slice(0, full.length - path.extname(full).length);
  const target = `${stem}.en.vtt`;
  try {
    if (fs.statSync(target).size > 40) return true;
  } catch {
    /* no English sidecar yet */
  }

  const imdbId = await resolveImdbId({
    ...item,
    title: item.seriesTitle || item.title,
  });
  if (!imdbId) return false;
  const text = await fetchEnglishSubtitle({
    imdbId,
    season: item.season,
    episode: item.episode,
  });
  if (!text) return false;
  await fsp.writeFile(target, text, 'utf8');
  return true;
}