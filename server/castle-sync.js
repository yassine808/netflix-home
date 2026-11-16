import { refreshCastleTitle, castleTrailerItem } from './castle.js';
import {
  listCastleTitleIds, getCastleTitleSaved, getCastleSyncState, putCastleSyncState,
} from './db.js';
import { isOffline } from './settings.js';
import { trailerStatus, warmTrailer } from './trailers.js';

/**
 * Refresh every Castle title already saved in catalog.db.
 *
 * This never walks the whole catalog: only titles that were opened at least
 * once are refreshed. Each row is merged field by field, so a fresh response
 * that misses a description, poster or season keeps the saved copy. Missing
 * artwork is downloaded and a title without a trailer gets one queued. Nothing
 * is ever deleted: a refresh that fails leaves the saved row exactly as it was.
 *
 * The seven-day window is read from the `castle_sync` row in catalog.db, not
 * from memory, so a restart keeps the same schedule. A launch and an hourly
 * timer both ask `startCastleSyncIfDue()`; both funnel into `startCastleSync()`,
 * whose `running` flag is the one thing that decides whether a pass may start.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_EVERY_MS = 7 * DAY_MS;
const CHECK_EVERY_MS = 60 * 60 * 1000;

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

/* Progress, plus the persisted schedule: `lastSyncAt` is the timestamp written
 * by the last completed pass, `nextDueAt` is when the seven-day rule opens
 * again (0 = never synced, so it is due now), and `due` is that comparison. */
export function castleSyncStatus() {
  const { lastSyncAt, result } = getCastleSyncState();
  return {
    ...state,
    lastSyncAt,
    nextDueAt: lastSyncAt ? lastSyncAt + SYNC_EVERY_MS : 0,
    due: !lastSyncAt || Date.now() >= lastSyncAt + SYNC_EVERY_MS,
    syncEveryMs: SYNC_EVERY_MS,
    lastResult: result,
  };
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
      } catch (err) {
        // The saved row is untouched: a failed refresh never deletes anything.
        state.errors += 1;
        console.warn(`[castle] ${id}: refresh failed, saved row kept - ${err?.message || String(err)}`);
      }
      state.done += 1;
    }
  };
  await Promise.all([worker(), worker()]);

  // The pass counts as done even when a title errored: the failed row keeps its
  // saved copy and the next window retries it. Offline switched on mid-pass
  // leaves the old timestamp untouched, so the next check retries instead of
  // waiting another week.
  if (isOffline()) return;
  putCastleSyncState({
    lastSyncAt: Date.now(),
    result: {
      total: state.total,
      updated: state.updated,
      kept: state.kept,
      images: state.images,
      trailers: state.trailers,
      errors: state.errors,
      startedAt: state.startedAt,
      finishedAt: Date.now(),
    },
  });
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
      console.log(`[castle] sync finished: ${state.total} title(s), ${state.updated} updated, `
        + `${state.kept} unchanged, ${state.errors} error(s), ${state.images} image(s), `
        + `${state.trailers} trailer(s) queued in ${Math.round((state.finishedAt - state.startedAt) / 1000)}s`);
    });

  return { started: true, total: ids.length };
}

/* Automatic trigger for boot and the hourly timer. Reads the stored timestamp
 * instead of memory, and does nothing while offline - not even a DNS lookup. */
export function startCastleSyncIfDue({ reason = 'check' } = {}) {
  if (isOffline()) return { started: false, offline: true, reason };
  if (state.running) return { started: false, running: true, reason };
  const { lastSyncAt } = getCastleSyncState();
  if (lastSyncAt && Date.now() - lastSyncAt < SYNC_EVERY_MS) {
    return { started: false, due: false, lastSyncAt, nextDueAt: lastSyncAt + SYNC_EVERY_MS, reason };
  }
  const result = startCastleSync();
  if (result.started) {
    console.log(`[castle] ${reason}: seven-day refresh started for ${result.total} saved title(s)`
      + `${lastSyncAt ? '' : ' (never synced)'}`);
  }
  return { ...result, due: true, reason };
}

let checkTimer = null;

/* Hourly is enough: the condition is a timestamp a week old, so a check that
 * lands an hour late changes nothing, and an app left open for weeks still
 * refreshes on day 14. */
export function scheduleCastleSync() {
  if (checkTimer) return checkTimer;
  checkTimer = setInterval(() => startCastleSyncIfDue({ reason: 'hourly check' }), CHECK_EVERY_MS);
  checkTimer.unref?.();
  return checkTimer;
}
