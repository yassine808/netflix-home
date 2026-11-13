/*
 * Online movie and series catalog.
 *
 * Provider: Cinemeta (https://v3-cinemeta.strem.io), the public metadata
 * service behind Stremio. It is keyless, IMDb-backed, and covers mainstream
 * movies and series, including per-season episode data.
 *
 * This module only returns metadata. It never returns stream or download
 * URLs for copyrighted titles.
 */

const BASE = 'https://v3-cinemeta.strem.io';
const USER_AGENT = 'netflix-home/1.0 (local library metadata)';
const TIMEOUT_MS = 9000;
const SEARCH_TTL = 10 * 60 * 1000;
const TITLE_TTL = 6 * 60 * 60 * 1000;
const CACHE_LIMIT = 300;

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value, ttl) {
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + ttl });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(res.status === 404 ? 'title not found' : `Cinemeta HTTP ${res.status}`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  return res.json();
}

function text(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return value == null ? '' : String(value);
}

function clean(value) {
  return text(value).replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return text(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function parseYear(value) {
  const match = text(value).match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function httpsUrl(value) {
  const url = clean(value);
  return /^https:\/\//i.test(url) ? url : '';
}

function validType(value) {
  return value === 'movie' || value === 'series' ? value : '';
}

function validId(value) {
  const id = clean(value);
  return /^tt\d{4,10}$/.test(id) ? id : '';
}

function normalizeListItem(meta, fallbackType) {
  if (!meta || typeof meta !== 'object') return null;
  const id = validId(meta.imdb_id || meta.id);
  const title = clean(meta.name);
  if (!id || !title) return null;
  const type = validType(meta.type) || fallbackType;
  if (!type) return null;
  return {
    id,
    type,
    title,
    year: parseYear(meta.releaseInfo || meta.year),
    poster: httpsUrl(meta.poster),
    background: httpsUrl(meta.background),
    description: stripHtml(meta.description).slice(0, 600),
    rating: Number(meta.imdbRating) || null,
    runtime: clean(meta.runtime) || '',
    genres: Array.isArray(meta.genres) ? meta.genres.map(clean).filter(Boolean).slice(0, 6) : [],
  };
}

/* Rough relevance ranking so an exact title lands above sequels and noise. */
function rank(title, query) {
  const t = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const q = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.replace(/^(the|a|an) /, '') === q) return 96;
  if (t.startsWith(q)) return 80;
  if (t.replace(/^(the|a|an) /, '').startsWith(q)) return 76;
  if (t.includes(q)) return 60;
  const words = t.split(' ');
  if (words.some((word) => word.startsWith(q))) return 50;
  return 10;
}

async function searchType(type, query) {
  const url = `${BASE}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
  const data = await fetchJson(url);
  const metas = Array.isArray(data?.metas) ? data.metas : [];
  return metas
    .map((meta) => normalizeListItem(meta, type))
    .filter(Boolean)
    // The same title sometimes leaks into the other catalog; trust the
    // endpoint that was asked for unless the payload insists otherwise.
    .map((item) => (item.type === type ? item : { ...item, type }));
}

export async function searchOnline(query) {
  const q = clean(query).slice(0, 80);
  if (!q) {
    const err = new Error('q is required');
    err.status = 400;
    throw err;
  }

  const key = `search:${q.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const outcomes = await Promise.allSettled([
    searchType('movie', q),
    searchType('series', q),
  ]);
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
  if (failures.length === outcomes.length) {
    const err = new Error('Online catalog is unavailable right now');
    err.status = 502;
    throw err;
  }

  const movies = outcomes[0].status === 'fulfilled' ? outcomes[0].value : [];
  const series = outcomes[1].status === 'fulfilled' ? outcomes[1].value : [];

  const merged = new Map();
  // Series win ties on the same IMDb id because they carry episode data.
  for (const item of [...series, ...movies]) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }

  const results = [...merged.values()]
    .map((item) => ({ item, score: rank(item.title, q) }))
    .sort((a, b) => b.score - a.score || (a.item.year || 9999) - (b.item.year || 9999))
    .slice(0, 24)
    .map(({ item }) => item);

  const payload = {
    source: 'cinemeta',
    query: q,
    count: results.length,
    results,
  };
  cacheSet(key, payload, SEARCH_TTL);
  return payload;
}

function collectSeasons(videos) {
  const seasons = new Map();
  for (const video of Array.isArray(videos) ? videos : []) {
    const season = Number(video?.season);
    const episode = Number(video?.episode ?? video?.number);
    if (!Number.isInteger(season) || season < 1) continue;
    if (!Number.isInteger(episode) || episode < 1) continue;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push({
      id: clean(video.id),
      episode,
      title: clean(video.title || video.name) || `Episode ${episode}`,
      released: clean(video.released) || '',
      overview: stripHtml(video.overview).slice(0, 800),
      thumbnail: httpsUrl(video.thumbnail),
    });
  }
  return [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodes]) => ({
      season,
      episodes: episodes.sort((a, b) => a.episode - b.episode),
    }));
}

export async function getOnlineTitle(type, id) {
  const kind = validType(type);
  const imdbId = validId(id);
  if (!kind || !imdbId) {
    const err = new Error('valid type and IMDb id are required');
    err.status = 400;
    throw err;
  }

  const key = `title:${kind}:${imdbId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await fetchJson(`${BASE}/meta/${kind}/${imdbId}.json`);
  const meta = data?.meta;
  if (!meta || typeof meta !== 'object') {
    const err = new Error('title not found');
    err.status = 404;
    throw err;
  }

  const base = normalizeListItem(meta, kind);
  if (!base) {
    const err = new Error('title not found');
    err.status = 404;
    throw err;
  }

  const seasons = collectSeasons(meta.videos);
  const payload = {
    ...base,
    type: validType(meta.type) || kind,
    poster: httpsUrl(meta.poster) || base.poster,
    background: httpsUrl(meta.background) || base.background,
    logo: httpsUrl(meta.logo),
    description: stripHtml(meta.description),
    status: clean(meta.status),
    released: clean(meta.released),
    runtime: clean(meta.runtime),
    cast: Array.isArray(meta.cast) ? meta.cast.map(clean).filter(Boolean).slice(0, 12) : [],
    director: Array.isArray(meta.director) ? meta.director.map(clean).filter(Boolean).slice(0, 6) : [],
    seasons,
    episodeCount: seasons.reduce((sum, entry) => sum + entry.episodes.length, 0),
  };
  cacheSet(key, payload, TITLE_TTL);
  return payload;
}
