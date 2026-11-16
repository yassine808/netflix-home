import { searchOnline, getTitleRun, getOnlineTitle } from './online.js';
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
  const season = Number(item.season) || 0;
  const episode = Number(item.episode) || 0;
  // The season is part of the key: two series can share a title and still be
  // told apart by the episode on disk, so each season resolves on its own.
  const key = `${item.seriesKey || item.id}:${year}:${season}`;
  if (cache.has(key)) return cache.get(key);

  let id = '';
  try {
    const data = await searchOnline(item.seriesTitle || item.title);
    const wanted = normalizeTitle(item.seriesTitle || item.title);
    const results = Array.isArray(data?.results) ? data.results : [];
    const typed = item.isSeries ? results.filter((hit) => hit.type === 'series') : results;
    id = await pickImdbId(typed, wanted, year, item.isSeries === true, season, episode);
  } catch {
    /* offline or catalog down: no id, no lookup */
  }
  cache.set(key, id);
  return id;
}

/* Which of these catalogue entries actually holds the season and episode that
 * is on disk? The library usually has no year, so a bare title clash resolves
 * by catalogue order - "The Boys" is both a 1993 series and the 2019 one - and
 * the older entry then supplies a poster with no backdrop or logo, which is
 * exactly the card that renders as an empty gradient. The episode number is a
 * stronger signal than the order: a season 5 episode belongs to the show that
 * has a season 5. */
async function seasonHolders(pool, season, episode) {
  const titles = await Promise.all(
    pool.map((hit) => getOnlineTitle('series', hit.id).catch(() => null)),
  );
  return pool.filter((hit, index) => {
    const seasons = titles[index]?.seasons;
    if (!Array.isArray(seasons) || !seasons.length) return false;
    const found = seasons.find((entry) => Number(entry.season) === season);
    if (!found) return false;
    return !episode || found.episodes.some((entry) => Number(entry.episode) === episode);
  });
}

/* Remakes share a title, so a bare name is ambiguous: "The Trunk" is both a
 * 2013 series and the 2024 Netflix one, and the older one wins by catalog
 * order. When the caller knows the year, the candidate whose run covers that
 * year wins, and the closest first year is only the fallback: a catalog often
 * files a long-running show under its last season (Castle says "Suits" is
 * 2019), which is closer to a 2018 remake's first year than to the original's
 * 2011 - and that remake has no English release at all. */
async function pickImdbId(results, wanted, year, isSeries, season = 0, episode = 0) {
  if (!results.length) return '';
  const exact = results.filter((hit) => normalizeTitle(hit.title) === wanted);
  let pool = exact.length ? exact : results;
  if (pool.length === 1) return pool[0].id;

  /* A title clash with no year is settled by the episode itself before the
   * year logic runs, because "no year" alone would hand the first entry in
   * catalogue order the whole series. */
  if (isSeries && exact.length > 1 && season > 0) {
    const holders = await seasonHolders(pool, season, episode);
    if (holders.length === 1) return holders[0].id;
    if (holders.length > 1) pool = holders;
  }

  if (!year) return pool[0].id;

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