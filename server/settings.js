import fs from 'node:fs';
import path from 'node:path';

/**
 * Small persisted app settings store.
 *
 * `offline` is enforced by the server, not just the UI: when it is on, every
 * route that would reach the internet answers 503 and active downloads pause.
 *
 * `castleFallback` decides what happens when Torrentio has no release with
 * English audio: true downloads Castle's 720p HLS file instead, false keeps the
 * download Torrentio-only and refuses instead of quietly lowering the quality.
 */
const DEFAULTS = { offline: false, castleFallback: true };

let settingsFile = '';
let state = { ...DEFAULTS };

export function initSettings(cacheDir) {
  settingsFile = path.join(cacheDir, 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (raw && typeof raw.offline === 'boolean') state.offline = raw.offline;
    if (raw && typeof raw.castleFallback === 'boolean') state.castleFallback = raw.castleFallback;
  } catch {
    /* first run or unreadable file: keep defaults */
  }
  return getSettings();
}

export function getSettings() {
  return { ...state };
}

export function isOffline() {
  return state.offline === true;
}

export function isCastleFallback() {
  return state.castleFallback !== false;
}

export function setOffline(value) {
  return save({ ...state, offline: Boolean(value) });
}

export function setCastleFallback(value) {
  return save({ ...state, castleFallback: Boolean(value) });
}

function save(next) {
  state = next;
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* settings stay in memory when the file cannot be written */
  }
  return getSettings();
}
