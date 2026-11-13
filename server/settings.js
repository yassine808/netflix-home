import fs from 'node:fs';
import path from 'node:path';

/**
 * Small persisted app settings store.
 *
 * `offline` is enforced by the server, not just the UI: when it is on, every
 * route that would reach the internet answers 503 and active downloads pause.
 */
const DEFAULTS = { offline: false };

let settingsFile = '';
let state = { ...DEFAULTS };

export function initSettings(cacheDir) {
  settingsFile = path.join(cacheDir, 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (raw && typeof raw.offline === 'boolean') state.offline = raw.offline;
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

export function setOffline(value) {
  state = { ...state, offline: Boolean(value) };
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* settings stay in memory when the file cannot be written */
  }
  return getSettings();
}
