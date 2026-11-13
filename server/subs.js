import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { resolveImdbId, isImdbId } from './imdb.js';

/**
 * Subtitle fallback. Castle ships its own .vtt tracks; when English is missing
 * (or a local file has no sidecars at all), the keyless OpenSubtitles REST API
 * is queried and the result is written as <video>.en.vtt next to the file.
 */

const REST = 'https://rest.opensubtitles.org/search';
const AGENT = 'TemporaryUserAgent';
const LANG_CODES = { en: 'eng', fr: 'fre', ar: 'ara', it: 'ita', es: 'spa', de: 'ger', pt: 'por' };

export function vttFromSubtitle(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(clean)) return clean.endsWith('\n') ? clean : `${clean}\n`;
  // SRT: "00:00:01,000 --> 00:00:03,000" becomes VTT's dot separator.
  const body = clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}\n`;
}

export async function fetchEnglishSubtitle({ imdbId, season = 0, episode = 0, lang = 'en' } = {}) {
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
  if (!full || !item) return false;
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