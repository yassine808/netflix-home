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

  const year = Number(item.year) || 0;
  const key = `${item.seriesKey || item.id}:${year}`;
  if (cache.has(key)) return cache.get(key);

  let id = '';
  try {
    const data = await searchOnline(item.seriesTitle || item.title);
    const wanted = normalizeTitle(item.seriesTitle || item.title);
    const results = Array.isArray(data?.results) ? data.results : [];
    const typed = item.isSeries ? results.filter((hit) => hit.type === 'series') : results;
    id = pickImdbId(typed, wanted, year);
  } catch {
    /* offline or catalog down: no id, no lookup */
  }
  cache.set(key, id);
  return id;
}

/* Remakes share a title, so a bare name is ambiguous: "The Trunk" is both a
 * 2013 series and the 2024 Netflix one, and the older one wins by catalog
 * order. When the caller knows the year, take the closest one instead. */
function pickImdbId(results, wanted, year) {
  if (!results.length) return '';
  const exact = results.filter((hit) => normalizeTitle(hit.title) === wanted);
  const pool = exact.length ? exact : results;
  if (!year) return pool[0].id;
  const dated = pool
    .filter((hit) => hit.year)
    .map((hit) => ({ hit, delta: Math.abs(hit.year - year) }))
    .sort((a, b) => a.delta - b.delta);
  return (dated[0]?.hit || pool[0]).id;
}