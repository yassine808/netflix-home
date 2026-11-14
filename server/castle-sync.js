import { refreshCastleTitle, castleTrailerItem } from './castle.js';
import { listCastleTitleIds, getCastleTitleSaved } from './db.js';
import { isOffline } from './settings.js';
import { trailerStatus, warmTrailer } from './trailers.js';

/**
 * Refresh every Castle title already saved in catalog.db.
 *
 * This never walks the whole catalog: only titles that were opened at least
 * once are refreshed. Each row is merged field by field, so a fresh response
 * that misses a description, poster or season keeps the saved copy. Missing
 * artwork is downloaded and a title without a trailer gets one queued.
 */

const state = {
  running: false,
  total: 0,
  done: 0,
  updated: 0,
  kept: 0,
  images: 0,
  trailers: 0,
  errors: 0,
  startedAt: 0,
  finishedAt: 0,
};

export function castleSyncStatus() {
  return { ...state };
}

function print(value) {
  return JSON.stringify(value ?? null);
}

function changed(before, after) {
  if (!before) return true;
  const fields = ['title', 'year', 'description', 'genres', 'poster', 'background',
    'rating', 'watchCount', 'commentTotal', 'seasonCount', 'type'];
  for (const field of fields) {
    if (print(before[field]) !== print(after[field])) return true;
  }
  const shape = (title) => (title.seasons || []).map((row) => [
    row.season,
    (row.episodes || []).map((ep) => `${ep.episodeId}:${ep.title}:${ep.duration}`),
  ]);
  return print(shape(before)) !== print(shape(after));
}

async function run(ids) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor];
      cursor += 1;
      try {
        const before = getCastleTitleSaved(id);
        const result = await refreshCastleTitle(id);
        if (changed(before, result.title)) state.updated += 1;
        else state.kept += 1;
        state.images += result.images;

        // A trailer that already plays is kept; only a missing/failed one is
        // queued, and the queue downloads one title at a time in the background.
        const item = castleTrailerItem(result.title);
        if (trailerStatus(item).status !== 'ready') {
          warmTrailer(item);
          state.trailers += 1;
        }
      } catch {
        state.errors += 1;
      }
      state.done += 1;
    }
  };
  await Promise.all([worker(), worker()]);
}

export function startCastleSync() {
  if (isOffline()) return { started: false, offline: true };
  if (state.running) return { started: false, running: true };

  const ids = listCastleTitleIds();
  Object.assign(state, {
    running: true,
    total: ids.length,
    done: 0,
    updated: 0,
    kept: 0,
    images: 0,
    trailers: 0,
    errors: 0,
    startedAt: Date.now(),
    finishedAt: 0,
  });

  run(ids)
    .catch(() => { state.errors += 1; })
    .finally(() => {
      state.running = false;
      state.finishedAt = Date.now();
    });

  return { started: true, total: ids.length };
}
