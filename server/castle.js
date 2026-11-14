import crypto from 'node:crypto';
import { getCastleStat, putCastleStat } from './db.js';

/**
 * Castle (api.hlowb.com) catalog client.
 *
 * The API answers with AES-CBC encrypted JSON. The key is handed out per
 * session by /v0.1/system/getSecurityKey and is the same value used as IV.
 * Requests are keyless, so the whole catalog (movies + TV, with seasons,
 * episodes, resolutions and file sizes) is reachable without an account.
 */

const BASE = 'https://api.hlowb.com';
const CHANNEL = 'IndiaA';
const CLIENT = '1';
const LANG = 'en-US';
const PKG = 'com.external.castle';
const KEY_SUFFIX = 'T!BgJB';
const APK_SIGN_KEY = 'ED0955EB04E67A1D9F3305B95454FED485261475';

const HEADERS = {
  'User-Agent': 'okhttp/4.9.3',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: BASE,
};

const KEY_TTL = 10 * 60 * 1000;
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 120;
/* Saved ratings are served immediately; after this age one refresh is tried
 * and the saved copy remains the fallback when Castle cannot be reached. */
const STATS_TTL = 24 * 60 * 60 * 1000;

/* Country -> language the service names its tracks with. Only the first
 * country with a known language is used; anime falls back to Japanese. */
const COUNTRY_LANGUAGES = {
  'united states': 'English', 'united states of america': 'English', usa: 'English',
  'united kingdom': 'English', uk: 'English', 'great britain': 'English', england: 'English',
  canada: 'English', australia: 'English', 'new zealand': 'English', ireland: 'English',
  'south africa': 'English', nigeria: 'English', kenya: 'English', ghana: 'English',
  japan: 'Japanese', 'south korea': 'Korean', korea: 'Korean', 'republic of korea': 'Korean',
  china: 'Chinese', 'mainland china': 'Chinese', 'hong kong': 'Chinese', taiwan: 'Chinese',
  india: 'Hindi', pakistan: 'Urdu', bangladesh: 'Bengali', nepal: 'Nepali',
  'sri lanka': 'Sinhala', myanmar: 'Burmese', cambodia: 'Khmer', laos: 'Lao',
  thailand: 'Thai', indonesia: 'Indonesian', malaysia: 'Malay', philippines: 'Filipino',
  vietnam: 'Vietnamese', mongolia: 'Mongolian',
  france: 'French', germany: 'Germany', 'west germany': 'Germany', austria: 'Germany',
  switzerland: 'Germany', spain: 'Spanish', mexico: 'Spanish', argentina: 'Spanish',
  colombia: 'Spanish', chile: 'Spanish', peru: 'Spanish', venezuela: 'Spanish',
  italy: 'Italian', portugal: 'Portuguese', brazil: 'Portuguese',
  poland: 'Polish', russia: 'Russian', 'soviet union': 'Russian', ukraine: 'Ukrainian',
  turkey: 'Turkish', greece: 'Greek', israel: 'Hebrew',
  'saudi arabia': 'Arabic', egypt: 'Arabic', 'united arab emirates': 'Arabic',
  qatar: 'Arabic', lebanon: 'Arabic', morocco: 'Arabic', iraq: 'Arabic', iran: 'Persian',
  denmark: 'Danish', sweden: 'Swedish', norway: 'Norwegian', finland: 'Finnish',
  netherlands: 'Dutch', holland: 'Dutch', belgium: 'French',
  'czech republic': 'Czech', czechia: 'Czech', hungary: 'Hungarian', romania: 'Romanian',
  serbia: 'Serbian', croatia: 'Croatian', slovenia: 'Slovenian', slovakia: 'Slovak',
  bulgaria: 'Bulgarian', lithuania: 'Lithuanian', latvia: 'Latvian', estonia: 'Estonian',
  iceland: 'Icelandic', kazakhstan: 'Kazakh', uzbekistan: 'Uzbek', azerbaijan: 'Azerbaijani',
  georgia: 'Georgian', armenia: 'Armenian', ethiopia: 'Amharic', tanzania: 'Swahili',
};

/* Castle spells some languages differently from the ISO name ("Germany" for
 * German, "OST" for original sound). Compare by canonical key, not raw text. */
const LANGUAGE_ALIASES = {
  german: 'germany', deutsch: 'germany',
  mandarin: 'chinese', cantonese: 'chinese',
  farsi: 'persian', castilian: 'spanish', 'brazilian portuguese': 'portuguese',
  tagalog: 'filipino', myanmar: 'burmese', bengali: 'bengali',
  'original soundtrack': 'ost', original: 'ost',
};

/* ISO 639-1 -> ISO 639-2/B, because MP4 language tags are three letters. */
const ISO_639_2 = {
  en: 'eng', ja: 'jpn', hi: 'hin', de: 'deu', fr: 'fra', cs: 'ces', pl: 'pol',
  pt: 'por', es: 'spa', th: 'tha', id: 'ind', it: 'ita', ko: 'kor', zh: 'zho',
  cmn: 'zho', ru: 'rus', tr: 'tur', da: 'dan', sv: 'swe', no: 'nor', nb: 'nor',
  fi: 'fin', nl: 'nld', hu: 'hun', ro: 'ron', uk: 'ukr', el: 'ell', he: 'heb',
  ar: 'ara', fa: 'fas', vi: 'vie', ms: 'msa', tl: 'fil', fil: 'fil', ta: 'tam',
  te: 'tel', ml: 'mal', bn: 'ben', mr: 'mar', pa: 'pan', gu: 'guj', kn: 'kan',
  ur: 'urd', ne: 'nep', si: 'sin', my: 'mya', km: 'khm', lo: 'lao', ka: 'kat',
  az: 'aze', kk: 'kaz', uz: 'uzb', sr: 'srp', hr: 'hrv', sl: 'slv', sk: 'slk',
  bg: 'bul', lt: 'lit', lv: 'lav', et: 'est', is: 'ice', ga: 'gle', cy: 'cym',
  sq: 'alb', mk: 'mac', bs: 'bos', be: 'bel', hy: 'arm', sw: 'swa', am: 'amh',
  af: 'afr', zu: 'zul', yo: 'yor', ig: 'ibo', ha: 'hau', so: 'som', ceb: 'ceb',
};

function languageKey(name) {
  const value = String(name || '').trim().toLowerCase();
  return LANGUAGE_ALIASES[value] || value;
}

function sameLanguage(a, b) {
  const left = languageKey(a);
  const right = languageKey(b);
  return Boolean(left) && left === right;
}

function inferOriginalLanguage({ countries = [], anime = false } = {}) {
  const names = (Array.isArray(countries) ? countries : [])
    .map((country) => String(country || '').trim().toLowerCase())
    .filter(Boolean);
  if (anime && names.includes('japan')) return 'Japanese';
  for (const name of names) {
    const language = COUNTRY_LANGUAGES[name];
    if (language) return language;
  }
  return anime ? 'Japanese' : '';
}

let keyCache = { value: '', at: 0 };
const cache = new Map();

function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = Promise.resolve().then(loader);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

function httpError(message, status = 502) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function securityKey() {
  if (keyCache.value && Date.now() - keyCache.at < KEY_TTL) return keyCache.value;
  const url = `${BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw httpError(`castle key failed (HTTP ${res.status})`);
  const body = await res.json();
  if (!body || body.code !== 200 || !body.data) throw httpError('castle key rejected');
  keyCache = { value: body.data, at: Date.now() };
  return body.data;
}

function decrypt(cipherB64, keyB64) {
  const material = Buffer.concat([
    Buffer.from(keyB64, 'base64'),
    Buffer.from(KEY_SUFFIX, 'utf8'),
  ]);
  const key = material.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([
    decipher.update(Buffer.from(cipherB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Castle ids are 16-19 digit integers and overflow Number.MAX_SAFE_INTEGER.
 * Quote them before JSON.parse so they survive as exact strings.
 */
function parseExact(text) {
  const guarded = text.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]])/g, '$1"$2"');
  return JSON.parse(guarded);
}

async function request(path, { body, method = 'GET' } = {}) {
  const key = await securityKey();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw httpError(`castle request failed (HTTP ${res.status})`);
  const cipher = (await res.text()).trim();
  if (!cipher) throw httpError('castle returned an empty response');
  let payload;
  try {
    payload = parseExact(decrypt(cipher, key));
  } catch {
    throw httpError('castle response could not be decrypted');
  }
  if (Number(payload?.code) !== 200) {
    throw httpError(payload?.msg ? `castle: ${payload.msg}` : 'castle rejected the request', 404);
  }
  return payload.data;
}

export function isCastleId(value) {
  return /^\d{6,20}$/.test(String(value || ''));
}

function yearOf(row) {
  const time = Number(row.publishTime);
  if (!Number.isFinite(time) || time <= 0) return null;
  const year = new Date(time).getUTCFullYear();
  return year > 1900 && year < 2100 ? year : null;
}

function typeOf(row) {
  if (Number(row.movieType) === 1) return 'series';
  if (Number(row.movieType) === 2) return 'movie';
  if (Number(row.movieType) === 5) return 'anime';
  return Number(row.lastEpisodeCount) > 1 ? 'series' : 'movie';
}

function seasonCountOf(row) {
  const match = String(row.seasonDescription || '').match(/(\d+)\s+season/i);
  return match ? Number(match[1]) : 0;
}

function normalize(row) {
  const type = typeOf(row);
  const seasons = seasonCountOf(row);
  return {
    provider: 'castle',
    id: String(row.id),
    title: String(row.title || '').trim(),
    type,
    year: yearOf(row),
    rating: Number(row.score) || 0,
    poster: row.coverVerticalImage || '',
    background: row.coverHorizontalImage || '',
    description: String(row.briefIntroduction || '').trim(),
    genres: Array.isArray(row.tags) ? row.tags.filter(Boolean).slice(0, 6) : [],
    languages: Array.isArray(row.languages) ? row.languages.filter(Boolean) : [],
    seasonCount: seasons,
    episodeCount: 0,
    // Anime rows resolve through the same detail route; only the catalog table differs.
    downloadable: true,
    movieType: Number(row.movieType) || 0,
  };
}

export async function searchCastle(query, page = 1, { tagId = '', size = 24 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw httpError('q is required', 400);

  const tag = String(tagId || '').trim();
  const pageSize = Math.min(50, Math.max(1, Number(size) || 24));
  return cached(`search:${q}:${page}:${tag}:${pageSize}`, CACHE_TTL, async () => {
    const params = new URLSearchParams({
      channel: CHANNEL,
      clientType: CLIENT,
      lang: LANG,
      keyword: q,
      page: String(Math.max(1, Number(page) || 1)),
      size: String(pageSize),
    });
    if (tag) params.set('tagId', tag);
    const data = await request(`/film-api/v1.1.0/movie/searchByKeyword?${params}`);
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return {
      query: q,
      total: Number(data?.total) || rows.length,
      results: rows.map(normalize).filter((item) => item.id && item.title),
    };
  });
}

/* A random-looking shelf for the Online page. Castle only exposes keyword
 * search, so this asks a handful of broad words and shuffles the union. */
const BROWSE_KEYWORDS = [
  'action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 'sci-fi',
  'animation', 'crime', 'adventure', 'family', 'mystery', 'war', 'fantasy',
];

/* Genre tag ids accepted by Castle's search filter. Horror is not a tag on
 * this source; horror titles are filed under Thriller. */
export const CASTLE_GENRES = [
  { name: 'Action', tagId: '1003' },
  { name: 'Adventure', tagId: '5992705930904576' },
  { name: 'Animation', tagId: '1008' },
  { name: 'Comedy', tagId: '1006' },
  { name: 'Crime', tagId: '1011' },
  { name: 'Documentary', tagId: '1009' },
  { name: 'Drama', tagId: '1004' },
  { name: 'Mystery', tagId: '1002' },
  { name: 'Romance', tagId: '1007' },
  { name: 'Sci-Fi', tagId: '1001' },
  { name: 'Thriller', tagId: '1005' },
];

const TAG_POOL_KEYWORDS = ['a', 'e', 'i', 'o', 'u', 'the'];
const OVERALL_TAG_IDS = ['1003', '1004', '1005', '1006', '1007', '1001', '1011', '1002'];

function shuffled(rows) {
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function genreFor(value) {
  const wanted = String(value || '').trim().toLowerCase();
  return CASTLE_GENRES.find((genre) => genre.name.toLowerCase() === wanted) || null;
}

function mergeResults(settled) {
  const seen = new Set();
  const rows = [];
  for (const entry of settled) {
    if (entry.status !== 'fulfilled') continue;
    for (const item of entry.value.results) {
      if (!item.id || !item.title || !item.poster || seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push(item);
    }
  }
  return rows;
}

async function tagPool(tagId, keywords = TAG_POOL_KEYWORDS) {
  const settled = await Promise.allSettled(
    keywords.map((keyword) => searchCastle(keyword, 1, { tagId, size: 40 })),
  );
  return mergeResults(settled);
}

async function overallPool(keywords = ['a', 'the']) {
  const queries = [];
  for (const tagId of OVERALL_TAG_IDS) {
    for (const keyword of keywords) queries.push({ tagId, keyword });
  }
  const settled = await Promise.allSettled(
    queries.map(({ tagId, keyword }) => searchCastle(keyword, 1, { tagId, size: 40 })),
  );
  return mergeResults(settled);
}

/* Evenly samples a long pool, so "most watched" does not only consider the
 * first page of one search. */
function spread(rows, count) {
  if (rows.length <= count) return rows;
  const step = rows.length / count;
  return Array.from({ length: count }, (_, index) => rows[Math.floor(index * step)]);
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

/* Rating and watch counts for one title. Saved in catalog.db so the value
 * survives restarts and Castle outages; refreshed once a day. */
export async function getCastleStats(id) {
  if (!isCastleId(id)) throw httpError('invalid castle id', 400);
  const saved = getCastleStat(id);
  if (saved && Date.now() - saved.fetchedAt < STATS_TTL) {
    const { fetchedAt, ...stats } = saved;
    return stats;
  }
  try {
    return await cached(`stats:${id}`, STATS_TTL, async () => {
      const data = await request(
        `/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`
        + `&movieId=${encodeURIComponent(id)}&packageName=${PKG}`,
      );
      const stats = {
        id: String(data?.id || id),
        title: String(data?.title || '').trim(),
        type: typeOf(data || {}),
        year: yearOf(data || {}),
        rating: Number(data?.score) || 0,
        watchCount: Number(data?.watchCount) || 0,
        commentTotal: Number(data?.commentTotal) || 0,
        genres: Array.isArray(data?.tags) ? data.tags.filter(Boolean).slice(0, 6) : [],
        poster: data?.coverVerticalImage || '',
      };
      putCastleStat(stats);
      return stats;
    });
  } catch (err) {
    if (saved) {
      const { fetchedAt, ...stats } = saved;
      return stats;
    }
    throw err;
  }
}

/**
 * Online shelves. Modes:
 *  - random: shuffle a broad pool (optionally inside one genre)
 *  - top: highest Castle score
 *  - popular: highest watch count, enriched from the detail endpoint
 */
export async function browseCastle({ mode = 'random', genre = '', fresh = false, limit = 60 } = {}) {
  const selected = genre ? genreFor(genre) : null;
  if (genre && !selected) throw httpError(`unknown genre “${genre}”`, 400);
  if (!['random', 'top', 'popular'].includes(mode)) throw httpError('unknown browse mode', 400);

  const capped = Math.min(120, Math.max(1, Number(limit) || 60));
  const key = fresh ? `browse:${Date.now()}:${Math.random()}` : `browse:${mode}:${selected?.name || 'all'}`;
  return cached(key, fresh ? 0 : CACHE_TTL, async () => {
    if (mode === 'random' && !selected) {
      const picks = shuffled(BROWSE_KEYWORDS).slice(0, 6);
      const settled = await Promise.allSettled(picks.map((query) => searchCastle(query)));
      const rows = mergeResults(settled);
      if (!rows.length) {
        const failure = settled.find((entry) => entry.status === 'rejected');
        throw failure?.reason || httpError('castle returned no titles');
      }
      return shuffled(rows).slice(0, capped);
    }

    if (mode === 'random') {
      const keywords = shuffled(TAG_POOL_KEYWORDS).slice(0, 4);
      const rows = await tagPool(selected.tagId, keywords);
      if (!rows.length) throw httpError('castle returned no titles');
      return shuffled(rows).slice(0, capped);
    }

    const pool = mode === 'popular'
      ? (selected ? await tagPool(selected.tagId) : await overallPool(['a', 'the', 's']))
      : (selected ? await tagPool(selected.tagId) : await overallPool());
    if (!pool.length) throw httpError('castle returned no titles');

    if (mode === 'top') {
      return [...pool]
        .sort((a, b) => (b.rating - a.rating) || ((b.year || 0) - (a.year || 0)))
        .slice(0, capped);
    }

    const candidates = spread(pool, Math.min(capped * 2, 140));
    const enriched = await mapLimit(candidates, 8, async (row) => {
      try {
        const stats = await getCastleStats(row.id);
        return {
          ...row,
          rating: stats.rating || row.rating,
          watchCount: stats.watchCount,
          commentTotal: stats.commentTotal,
        };
      } catch {
        return { ...row, watchCount: 0, commentTotal: 0 };
      }
    });
    return enriched
      .sort((a, b) => (b.watchCount - a.watchCount) || (b.rating - a.rating))
      .slice(0, capped);
  });
}

function episodeOf(entry, movieId) {
  return {
    episode: Number(entry.number) || 0,
    title: String(entry.title || '').trim() || `Episode ${entry.number}`,
    duration: Number(entry.duration) || 0,
    thumbnail: entry.coverImage || '',
    movieId: String(movieId),
    episodeId: String(entry.id),
    resolutions: (Array.isArray(entry.videos) ? entry.videos : [])
      .filter((video) => Number(video.resolution) > 0)
      .map((video) => ({
        resolution: Number(video.resolution),
        label: String(video.resolutionDescription || '').trim()
          || `${Number(video.resolution) + 1}K`,
        size: Number(video.size) || 0,
        premium: Boolean(video.premiumProPermission),
      }))
      .sort((a, b) => a.resolution - b.resolution),
  };
}

export async function getCastleTitle(id, { season } = {}) {
  if (!isCastleId(id)) throw httpError('invalid castle id', 400);

  return cached(`title:${id}:${season ?? ''}`, CACHE_TTL, async () => {
    const data = await request(
      `/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`
      + `&movieId=${encodeURIComponent(id)}&packageName=${PKG}`,
    );
    const seasons = (Array.isArray(data?.seasons) ? data.seasons : [])
      .map((entry) => ({
        season: Number(entry.number) || 0,
        movieId: String(entry.movieId),
        current: Boolean(entry.isCurrent),
      }))
      .sort((a, b) => a.season - b.season);

    const base = {
      provider: 'castle',
      id: String(data.id || id),
      title: String(data.title || '').trim(),
      type: seasons.length ? 'series' : 'movie',
      year: yearOf(data),
      rating: Number(data.score) || 0,
      watchCount: Number(data.watchCount) || 0,
      commentTotal: Number(data.commentTotal) || 0,
      poster: data.coverVerticalImage || '',
      background: data.coverHorizontalImage || '',
      description: String(data.briefIntroduction || '').trim(),
      genres: Array.isArray(data.tags) ? data.tags.filter(Boolean).slice(0, 6) : [],
      languages: Array.isArray(data.audioTags)
        ? data.audioTags.map((tag) => tag?.languageName).filter(Boolean)
        : [],
      seasonCount: seasons.length,
      seasons: [],
      downloadable: true,
    };

    // Opening a sheet also refreshes the saved rating snapshot.
    putCastleStat({
      id: base.id,
      title: base.title,
      type: base.type,
      year: base.year,
      rating: base.rating,
      watchCount: base.watchCount,
      commentTotal: base.commentTotal,
      genres: base.genres,
      poster: base.poster,
    });

    if (!seasons.length) {
      const episodes = (Array.isArray(data.episodes) ? data.episodes : [])
        .map((entry) => episodeOf(entry, id))
        .filter((entry) => entry.episodeId);
      base.episodes = episodes;
      base.episodeCount = episodes.length;
      base.duration = episodes[0]?.duration || 0;
      return base;
    }

    const wanted = Number(season) > 0 ? Number(season) : seasons[0].season;
    const target = seasons.find((entry) => entry.season === wanted) || seasons[0];

    let detail = data;
    if (String(target.movieId) !== String(id)) {
      detail = await request(
        `/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`
        + `&movieId=${encodeURIComponent(target.movieId)}&packageName=${PKG}`,
      );
    }

    const episodes = (Array.isArray(detail?.episodes) ? detail.episodes : [])
      .map((entry) => episodeOf(entry, target.movieId))
      .filter((entry) => entry.episodeId);

    base.seasons = seasons.map((entry) => ({
      season: entry.season,
      episodes: entry.season === target.season ? episodes : [],
    }));
    base.activeSeason = target.season;
    base.episodeCount = episodes.length;
    return base;
  });
}

/* Every season with its full episode list (resolutions included). Used by the
 * "Download all" action, which needs all seasons, not just the open tab. */
export async function getCastleSeries(id) {
  if (!isCastleId(id)) throw httpError('invalid castle id', 400);
  const first = await getCastleTitle(id);
  if (!first.seasons?.length) {
    return { id: first.id, title: first.title, seasons: [{ season: 0, episodes: first.episodes || [] }] };
  }
  const rows = await Promise.all(first.seasons.map(async (row) => {
    const detail = row.season === first.activeSeason
      ? first
      : await getCastleTitle(id, { season: row.season });
    const active = (detail.seasons || []).find((entry) => entry.season === detail.activeSeason);
    return { season: row.season, episodes: active?.episodes || [] };
  }));
  return { id: first.id, title: first.title, seasons: rows };
}

export async function getCastleStream({ movieId, episodeId, resolution = 2, languageId } = {}) {
  if (!isCastleId(movieId)) throw httpError('invalid movieId', 400);
  if (!isCastleId(episodeId)) throw httpError('invalid episodeId', 400);
  const quality = Number(resolution);
  if (![1, 2, 3].includes(quality)) throw httpError('resolution must be 1, 2 or 3', 400);

  const body = {
    mode: '1',
    appMarket: 'GuanWang',
    clientType: CLIENT,
    woolUser: 'false',
    apkSignKey: APK_SIGN_KEY,
    androidVersion: '13',
    movieId: String(movieId),
    episodeId: String(episodeId),
    isNewUser: 'true',
    resolution: String(quality),
    packageName: PKG,
  };
  if (languageId) body.languageId = String(languageId);

  const data = await request(
    `/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}`
    + `&channel=${CHANNEL}&lang=${LANG}`,
    { method: 'POST', body },
  );

  const url = String(data?.videoUrl || '');
  if (!/^https?:\/\//i.test(url)) {
    // Castle marks 1080p as premium for most titles and answers without a URL.
    if (quality === 3) {
      throw httpError('1080p is premium-only on this source; pick 720p or 480p', 409);
    }
    throw httpError('castle did not return a playable URL', 404);
  }

  return {
    url,
    expiresAt: Number(data.expireTime) || null,
    preview: Boolean(data.isPreview),
    subtitles: (Array.isArray(data.subtitles) ? data.subtitles : []).map((track) => ({
      language: String(track.abbreviate || track.languageId || ''),
      title: String(track.title || '').trim(),
      url: String(track.url || ''),
    })).filter((track) => track.url),
    sources: (Array.isArray(data.videos) ? data.videos : []).map((video) => ({
      resolution: Number(video.resolution) || 0,
      label: String(video.resolutionDescription || '').trim(),
      size: Number(video.size) || 0,
    })),
  };
}

/* The episode `tracks` array carries the exact mux index of each audio
 * language, so a download can map only the tracks it wants. `languages`
 * lists names in stream order but has no indexes; `audioTags` is only the
 * enabled subset and is not reliable as an index map. */
function normalizeAudioTracks(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((track) => {
      const code = String(track?.abbreviate || '').trim().toLowerCase();
      return {
        index: Number(track?.index),
        language: String(track?.languageName || '').trim(),
        code,
        iso: code.length === 3 ? code : (ISO_639_2[code] || ''),
        default: Boolean(track?.isDefault),
      };
    })
    .filter((track) => Number.isInteger(track.index) && track.index >= 0 && track.language);
}

export async function getCastleEpisodeTracks({ movieId, episodeId } = {}) {
  if (!isCastleId(movieId)) throw httpError('invalid movieId', 400);

  const detail = await cached(`audio:${movieId}`, CACHE_TTL, async () => {
    const data = await request(
      `/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`
      + `&movieId=${encodeURIComponent(movieId)}&packageName=${PKG}`,
    );
    const episodes = {};
    for (const episode of Array.isArray(data?.episodes) ? data.episodes : []) {
      const tracks = normalizeAudioTracks(episode?.tracks);
      if (tracks.length) episodes[String(episode.id)] = tracks;
    }
    const own = normalizeAudioTracks(data?.tracks);
    if (own.length) episodes[String(data?.id || movieId)] = own;
    return {
      episodes,
      countries: Array.isArray(data?.countries) ? data.countries.filter(Boolean) : [],
      anime: Number(data?.movieType) === 5,
    };
  });

  return {
    tracks: detail.episodes[String(episodeId)] || detail.episodes[String(movieId)] || [],
    countries: detail.countries,
    anime: detail.anime,
    original: inferOriginalLanguage(detail),
  };
}

/**
 * Picks the original-language track plus English (when it exists and differs).
 * With no tracks at all the caller keeps the old all-audio behaviour; with
 * tracks but an unknown original, the service default stands in for it.
 */
export function selectCastleAudioTracks(tracks, originalLanguage) {
  if (!Array.isArray(tracks) || !tracks.length) return [];
  const original = originalLanguage
    ? tracks.find((track) => sameLanguage(track.language, originalLanguage))
    : null;
  const primary = original || tracks.find((track) => track.default) || tracks[0];
  const english = tracks.find((track) => sameLanguage(track.language, 'English'));
  const picked = [primary];
  if (english && english.index !== primary.index) picked.push(english);
  return picked;
}
