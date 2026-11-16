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
 * `autoplaySound` is the sound default for trailers the app starts by itself:
 * the hero preview on the home page and the trailer in the catalogue sheet.
 * Off means both start muted and the viewer unmutes them. The watch player is
 * never affected: a show always opens with sound.
 *
 * `downloadMaxActive` is how many transfers run at once. Every one is its own
 * torrent swarm with its own aria2c: 41 at a time answered /api/downloads in
 * 46-82 s and made Castle return 502, so the queue is capped and the rest wait
 * in "queued". `downloadLimitMBps` caps the combined speed (0 = unlimited) and
 * is split evenly between the transfers that are running.
 *
 * `torrentQuality` is the video quality a Torrentio download may pick: '1080p'
 * (the default, small files) or '2160p' (4K releases only, usually 4-8x the
 * size). It is a hard filter, not a preference: the other quality is never
 * downloaded, and releases below 1080p stay excluded either way.
 *
 * `downloadStagingDir` is a scratch folder for transfers. Empty keeps every
 * piece next to the library (one rename into place). Set, the swarm writes on
 * that disk and the finished file is copied to the library once, at a capped
 * rate: a 4K release writes megabytes of random pieces for a long time, and on
 * the library drive that is exactly what makes playback stutter.
 */
const DEFAULTS = {
  offline: false,
  castleFallback: true,
  autoplaySound: true,
  downloadMaxActive: 3,
  downloadLimitMBps: 0,
  torrentQuality: '1080p',
  downloadStagingDir: '',
};

const MAX_ACTIVE_LIMIT = 20;
const MAX_SPEED_LIMIT = 1000;
const TORRENT_QUALITIES = new Set(['1080p', '2160p']);

let settingsFile = '';
let state = { ...DEFAULTS };

export function initSettings(cacheDir) {
  settingsFile = path.join(cacheDir, 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (raw && typeof raw.offline === 'boolean') state.offline = raw.offline;
    if (raw && typeof raw.castleFallback === 'boolean') state.castleFallback = raw.castleFallback;
    if (raw && typeof raw.autoplaySound === 'boolean') state.autoplaySound = raw.autoplaySound;
    if (raw && Number.isFinite(Number(raw.downloadMaxActive))) {
      state.downloadMaxActive = clampMaxActive(raw.downloadMaxActive);
    }
    if (raw && Number.isFinite(Number(raw.downloadLimitMBps))) {
      state.downloadLimitMBps = clampSpeed(raw.downloadLimitMBps);
    }
    if (raw && TORRENT_QUALITIES.has(raw.torrentQuality)) {
      state.torrentQuality = raw.torrentQuality;
    }
    if (raw && typeof raw.downloadStagingDir === 'string') {
      state.downloadStagingDir = cleanStagingDir(raw.downloadStagingDir);
    }
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

/* How many transfers may run at the same time. Always at least 1: a cap of 0
 * would stop the queue for good with no visible reason. */
export function getDownloadMaxActive() {
  return clampMaxActive(state.downloadMaxActive);
}

/* Combined cap in megabytes per second; 0 means unlimited. */
export function getDownloadLimitMBps() {
  return clampSpeed(state.downloadLimitMBps);
}

export function setDownloadLimits({ maxActive, limitMBps } = {}) {
  const next = { ...state };
  if (maxActive !== undefined) next.downloadMaxActive = clampMaxActive(maxActive);
  if (limitMBps !== undefined) next.downloadLimitMBps = clampSpeed(limitMBps);
  return save(next);
}

/* The video quality a Torrentio download may pick. Always one of the two:
 * anything else is treated as 1080p, so a corrupt settings file cannot leave
 * the downloader without a rule. */
export function getTorrentQuality() {
  return TORRENT_QUALITIES.has(state.torrentQuality) ? state.torrentQuality : DEFAULTS.torrentQuality;
}

export function setTorrentQuality(value) {
  const wanted = String(value || '').toLowerCase();
  if (!TORRENT_QUALITIES.has(wanted)) return getSettings();
  return save({ ...state, torrentQuality: wanted });
}

/* Scratch folder for transfers; '' means "beside the library". */
export function getDownloadStagingDir() {
  return state.downloadStagingDir || '';
}

export function setDownloadStagingDir(value) {
  return save({ ...state, downloadStagingDir: cleanStagingDir(value) });
}

/* An empty value means "beside the library". Anything else has to be an
 * absolute path: a relative one would land inside the app folder, where the
 * next deploy wipes it. Surrounding quotes are stripped so a pasted Explorer
 * path ("C:\temp") is accepted as-is. */
function cleanStagingDir(value) {
  const raw = String(value ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!raw) return '';
  try {
    const resolved = path.resolve(raw);
    return path.isAbsolute(resolved) ? resolved : '';
  } catch {
    return '';
  }
}

function clampMaxActive(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULTS.downloadMaxActive;
  return Math.min(MAX_ACTIVE_LIMIT, Math.max(1, number));
}

function clampSpeed(value) {
  const number = Math.round(Number(value) * 10) / 10;
  if (!Number.isFinite(number)) return DEFAULTS.downloadLimitMBps;
  return Math.min(MAX_SPEED_LIMIT, Math.max(0, number));
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
