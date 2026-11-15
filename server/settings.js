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
 *
 * `autoplaySound` is the sound default for video the app starts by itself: the
 * hero preview on the home page and the player when an episode opens. Off means
 * both start muted and the viewer unmutes them.
 */
const DEFAULTS = { offline: false, castleFallback: true, autoplaySound: true };

let settingsFile = '';
let state = { ...DEFAULTS };

export function initSettings(cacheDir) {
  settingsFile = path.join(cacheDir, 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (raw && typeof raw.offline === 'boolean') state.offline = raw.offline;
    if (raw && typeof raw.castleFallback === 'boolean') state.castleFallback = raw.castleFallback;
    if (raw && typeof raw.autoplaySound === 'boolean') state.autoplaySound = raw.autoplaySound;
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

export function isAutoplaySound() {
  return state.autoplaySound !== false;
}

export function setAutoplaySound(value) {
  return save({ ...state, autoplaySound: Boolean(value) });
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
