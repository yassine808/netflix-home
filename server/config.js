import fs from 'node:fs';
import path from 'node:path';

/**
 * App-level config that has to be readable *before* the library exists.
 *
 * `libraryRoot` is the folder picked in Settings. It cannot live in
 * `<library>\.cache\settings.json`, because that file sits inside the folder
 * the setting replaces: the next launch would look in the new folder and find
 * no settings at all. It sits beside the app instead (`config.json`), which
 * never moves.
 *
 * The folder is only a hint until a restart: the catalog, the artwork cache and
 * the download queue all open against the root resolved at boot.
 */
const DEFAULTS = { libraryRoot: '' };

let configFile = '';
let state = { ...DEFAULTS };

export function initConfig(appDir) {
  configFile = path.join(appDir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (raw && typeof raw.libraryRoot === 'string') state.libraryRoot = raw.libraryRoot.trim();
  } catch {
    /* first run or unreadable file: keep defaults */
  }
  return getConfig();
}

export function getConfig() {
  return { ...state };
}

export function configPath() {
  return configFile;
}

/* Empty means "not chosen yet": the caller falls back to auto-detection. */
export function getLibraryRootSetting() {
  return state.libraryRoot || '';
}

/* Only an existing, writable folder is accepted. A typo must not create a
 * second empty library that silently hides every film, and a read-only drive
 * would fail later with a database error instead of a clear message here. */
export function setLibraryRootSetting(raw) {
  const value = String(raw ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!value) throw badRequest('enter the folder the app should scan');
  if (!path.isAbsolute(value)) throw badRequest(`not a full path: ${value}`);
  let stat = null;
  try {
    stat = fs.statSync(value);
  } catch {
    throw badRequest(`folder not found: ${value}`);
  }
  if (!stat.isDirectory()) throw badRequest(`not a folder: ${value}`);

  const resolved = path.resolve(value);
  const probe = path.join(resolved, '.cache');
  const probeFile = path.join(probe, `.write-test-${process.pid}`);
  try {
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(probeFile, 'ok');
    fs.rmSync(probeFile, { force: true });
  } catch {
    throw badRequest(`folder is not writable: ${resolved}`);
  }
  return save({ ...state, libraryRoot: resolved });
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function save(next) {
  state = next;
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    throw badRequest(`could not write ${configFile}: ${err.message}`);
  }
  return getConfig();
}
