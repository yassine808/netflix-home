import crypto from 'node:crypto';

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

export async function searchCastle(query, page = 1) {
  const q = String(query || '').trim();
  if (!q) throw httpError('q is required', 400);

  return cached(`search:${q}:${page}`, CACHE_TTL, async () => {
    const params = new URLSearchParams({
      channel: CHANNEL,
      clientType: CLIENT,
      lang: LANG,
      keyword: q,
      page: String(Math.max(1, Number(page) || 1)),
      size: '24',
    });
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
 * search, so this asks a handful of broad genres and shuffles the union. */
const BROWSE_KEYWORDS = [
  'action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 'sci-fi',
  'animation', 'crime', 'adventure', 'family', 'mystery', 'war', 'fantasy',
];

function shuffled(rows) {
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function browseCastle({ fresh = false, limit = 30 } = {}) {
  const key = fresh ? `browse:${Date.now()}:${Math.random()}` : 'browse:picks';
  return cached(key, fresh ? 0 : CACHE_TTL, async () => {
    const picks = shuffled(BROWSE_KEYWORDS).slice(0, 6);
    const settled = await Promise.allSettled(picks.map((query) => searchCastle(query)));
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
    if (!rows.length) {
      const failure = settled.find((entry) => entry.status === 'rejected');
      throw failure?.reason || httpError('castle returned no titles');
    }
    return shuffled(rows).slice(0, Math.max(1, Number(limit) || 30));
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
