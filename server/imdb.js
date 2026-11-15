import { searchOnline, getTitleRun } from './online.js';
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
    id = await pickImdbId(typed, wanted, year, item.isSeries === true);
  } catch {
    /* offline or catalog down: no id, no lookup */
  }
  cache.set(key, id);
  return id;
}

/* Remakes share a title, so a bare name is ambiguous: "The Trunk" is both a
 * 2013 series and the 2024 Netflix one, and the older one wins by catalog
 * order. When the caller knows the year, the candidate whose run covers that
 * year wins, and the closest first year is only the fallback: a catalog often
 * files a long-running show under its last season (Castle says "Suits" is
 * 2019), which is closer to a 2018 remake's first year than to the original's
 * 2011 - and that remake has no English release at all. */
async function pickImdbId(results, wanted, year, isSeries) {
  if (!results.length) return '';
  const exact = results.filter((hit) => normalizeTitle(hit.title) === wanted);
  const pool = exact.length ? exact : results;
  if (!year || pool.length === 1) return pool[0].id;

  /* Runs come from Cinemeta's releaseInfo ("2011-2019" against "2018"). One
   * lookup per candidate, cached for 6 h; a provider failure just leaves that
   * candidate's run unknown instead of failing the resolution. Only an exact
   * title clash is a remake question: a fuzzy match keeps the old
   * closest-first-year order. */
  let covering = [];
  if (isSeries && exact.length > 1) {
    const runs = await Promise.all(
      pool.map((hit) => getTitleRun('series', hit.id).catch(() => null)),
    );
    covering = pool.filter((hit, index) => {
      const run = runs[index];
      return run && year >= run.start && year <= run.end;
    });
  }

  const dated = (covering.length ? covering : pool)
    .filter((hit) => hit.year)
    .map((hit) => ({ hit, delta: Math.abs(hit.year - year) }))
    .sort((a, b) => a.delta - b.delta);
  return (dated[0]?.hit || covering[0] || pool[0]).id;
}