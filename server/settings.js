import fs from 'node:fs';
import path from 'node:path';

/**
 * Small persisted app settings store.
 *
 * `offline` is enforced by the server, not just the UI: when it is on, every
 * route that would reach the internet answers 503 and active downloads pause.
 */
const DEFAULTS = { offline: false, tmdbKey: '' };

let settingsFile = '';
let state = { ...DEFAULTS };

export function initSettings(cacheDir) {
  settingsFile = path.join(cacheDir, 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (raw && typeof raw.offline === 'boolean') state.offline = raw.offline;
    if (raw && typeof raw.tmdbKey === 'string') state.tmdbKey = raw.tmdbKey.trim();
  } catch {
    /* first run or unreadable file: keep defaults */
  }
  const fromEnv = String(process.env.TMDB_API_KEY || '').trim();
  if (!state.tmdbKey && fromEnv) state.tmdbKey = fromEnv;
  return getSettings();
}

/* The key never leaves the server; the UI only learns whether one is set. */
export function getSettings() {
  return { offline: state.offline, tmdbConfigured: Boolean(state.tmdbKey) };
}

export function getTmdbKey() {
  return state.tmdbKey;
}

export function setTmdbKey(value) {
  state = { ...state, tmdbKey: String(value || '').trim() };
  persist();
  return getSettings();
}

export function isOffline() {
  return state.offline === true;
}

export function setOffline(value) {
  state = { ...state, offline: Boolean(value) };
  persist();
  return getSettings();
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* settings stay in memory when the file cannot be written */
  }
}
