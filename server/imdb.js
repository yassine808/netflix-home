import { searchOnline } from './online.js';
import { isOffline } from './settings.js';

/* The library rarely carries an IMDb id, so resolve one per series/movie once
 * through Cinemeta and keep it for the rest of the process. */
const cache = new Map();

export function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function isImdbId(value) {
  return /^tt\d{4,10}$/.test(String(value || ''));
}

export async function resolveImdbId(item) {
  const direct = String(item.tmdbId || '');
  if (isImdbId(direct)) return direct;
  // Offline means no lookup and no cached negative: once the switch is back on
  // the same title can still resolve.
  if (isOffline()) return '';

  const key = item.seriesKey || item.id;
  if (cache.has(key)) return cache.get(key);

  let id = '';
  try {
    const data = await searchOnline(item.seriesTitle || item.title);
    const wanted = normalizeTitle(item.seriesTitle || item.title);
    const results = Array.isArray(data?.results) ? data.results : [];
    const typed = item.isSeries ? results.filter((hit) => hit.type === 'series') : results;
    const exact = typed.find((hit) => normalizeTitle(hit.title) === wanted);
    id = (exact || typed[0])?.id || '';
  } catch {
    /* offline or catalog down: no id, no lookup */
  }
  cache.set(key, id);
  return id;
}