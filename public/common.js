const LIST_KEY = 'netflix-home:mylist';
const PROGRESS_KEY = 'netflix-home:progress';

export async function getLibrary() {
  const res = await fetch('/api/library', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`library ${res.status}`);
  return res.json();
}

export async function rescanLibrary() {
  const res = await fetch('/api/rescan', { method: 'POST' });
  if (!res.ok) throw new Error(`rescan ${res.status}`);
  return res.json();
}

/* Refresh every Castle title already saved in catalog.db. The call returns as
 * soon as the worker starts; poll getCastleSyncStatus for progress. */
export async function syncCastleCatalog() {
  const res = await fetch('/api/castle/sync', { method: 'POST' });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    const error = new Error(payload?.error || `sync ${res.status}`);
    error.offline = Boolean(payload?.offline);
    throw error;
  }
  return res.json();
}

export async function getCastleSyncStatus() {
  const res = await fetch('/api/castle/sync', { cache: 'no-store' });
  if (!res.ok) throw new Error(`sync status ${res.status}`);
  return res.json();
}

/* Stops the bundled app: the server exits, so the page goes dead afterwards. */
export async function quitApp() {
  const res = await fetch('/api/quit', { method: 'POST' });
  if (!res.ok) throw new Error(`quit ${res.status}`);
  return res.json();
}

/* Random shelf for the Online page: genre searches merged and shuffled. */
export async function browseCastle({ fresh = false, mode = 'random', genre = '', signal } = {}) {
  const params = new URLSearchParams();
  if (fresh) params.set('fresh', '1');
  if (mode && mode !== 'random') params.set('mode', mode);
  if (genre) params.set('genre', genre);
  const query = params.toString();
  const res = await fetch(`/api/castle/browse${query ? `?${query}` : ''}`, { cache: 'no-store', signal });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `download catalog browse ${res.status}`);
  }
  return res.json();
}

export async function searchOnline(query, { signal } = {}) {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`/api/online/search?${params}`, { cache: 'no-store', signal });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `online search ${res.status}`);
  }
  return res.json();
}

export async function getOnlineTitle(type, id, { signal } = {}) {
  const res = await fetch(
    `/api/online/title/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    { cache: 'no-store', signal },
  );
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `online title ${res.status}`);
  }
  return res.json();
}

export async function searchCastle(query, { signal } = {}) {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`/api/castle/search?${params}`, { cache: 'no-store', signal });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `download catalog search ${res.status}`);
  }
  return res.json();
}

export async function getCastleTitle(id, { season, signal } = {}) {
  const params = new URLSearchParams();
  if (season) params.set('season', String(season));
  const query = params.toString();
  const url = `/api/castle/title/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `download catalog title ${res.status}`);
  }
  return res.json();
}

/* Every season with its episodes, used by "Download all". */
export async function getCastleSeriesEpisodes(id, { signal } = {}) {
  const res = await fetch(`/api/castle/series/${encodeURIComponent(id)}/episodes`, { cache: 'no-store', signal });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `download catalog series ${res.status}`);
  }
  return res.json();
}

/* The saved Castle catalogue, for offline browsing. */
export async function getSavedCastle({ signal } = {}) {
  const res = await fetch('/api/castle/saved', { cache: 'no-store', signal });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `saved catalog ${res.status}`);
  }
  return res.json();
}

/* Does this browser decode HEVC by itself? When it does, the server copies the
 * release's own video stream into the MP4 instead of re-encoding it, which
 * takes the GPU out of the download: 30 min of 1080p HEVC went from 140 s to
 * 18 s on the same disk. Chromium only answers "probably" when the platform has
 * a hardware HEVC decoder, and that is the decoder that plays the result. */
let hevcDecode = null;
export function decodesHevc() {
  if (hevcDecode !== null) return hevcDecode;
  hevcDecode = false;
  try {
    const probe = document.createElement('video');
    hevcDecode = ['hvc1.2.4.L120.90', 'hvc1.1.6.L120.90']
      .some((codec) => probe.canPlayType(`video/mp4; codecs="${codec}"`) === 'probably');
  } catch {
    hevcDecode = false;
  }
  return hevcDecode;
}

/* Does this browser open a Matroska file at all? Chromium answers "probably"
 * for an MKV carrying H.264 + AAC; Firefox and Safari answer "", so the server
 * must not keep a release .mkv for them - it remuxes to MP4 instead. */
let matroskaPlayable = null;
export function playsMatroska() {
  if (matroskaPlayable !== null) return matroskaPlayable;
  matroskaPlayable = false;
  try {
    const probe = document.createElement('video');
    matroskaPlayable = probe.canPlayType('video/x-matroska; codecs="avc1.640028, mp4a.40.2"') !== '';
  } catch {
    matroskaPlayable = false;
  }
  return matroskaPlayable;
}

export async function startCastleDownload(body) {
  const res = await fetch('/api/castle/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, copyVideo: decodesHevc(), mkv: playsMatroska() }),
  });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `download failed (${res.status})`);
  }
  return res.json();
}

export async function getDownloads() {
  const res = await fetch('/api/downloads', { cache: 'no-store' });
  if (!res.ok) throw new Error(`downloads ${res.status}`);
  return res.json();
}

/* Full-range video repairs the server runs on its own (washed-out HEVC). */
export async function getColorFix() {
  const res = await fetch('/api/colorfix', { cache: 'no-store' });
  if (!res.ok) throw new Error(`colorfix ${res.status}`);
  return res.json();
}

export async function getSeries(key) {
  const res = await fetch(`/api/series/${encodeURIComponent(key)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`series ${res.status}`);
  return res.json();
}

/* Episodes known to the download catalog, with local + missing merged by the UI. */
export async function getSeriesCatalog(key, { signal } = {}) {
  const res = await fetch(`/api/series/${encodeURIComponent(key)}/catalog`, { cache: 'no-store', signal });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `series catalog ${res.status}`);
  }
  return res.json();
}

export async function getSettings() {
  const res = await fetch('/api/settings', { cache: 'no-store' });
  if (!res.ok) throw new Error(`settings ${res.status}`);
  return res.json();
}

/* The server stores the flag, so "offline" really stops outgoing requests. */
export async function setOfflineMode(offline) {
  const res = await fetch('/api/settings/offline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offline: Boolean(offline) }),
  });
  if (!res.ok) throw new Error(`offline ${res.status}`);
  return res.json();
}

/* Torrentio-only switch: the server refuses to fall back to Castle's 720p file
 * when this is off, so the UI never promises a download it would not get. */
export async function setCastleFallback(castleFallback) {
  const res = await fetch('/api/settings/castle-fallback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ castleFallback: Boolean(castleFallback) }),
  });
  if (!res.ok) throw new Error(`castle fallback ${res.status}`);
  return res.json();
}

/* Torrentio quality switch: '1080p' keeps files small, '2160p' accepts 4K
 * releases only. The server filters with it, so the answer is authoritative. */
export async function setTorrentQuality(quality) {
  const res = await fetch('/api/settings/torrent-quality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quality: String(quality || '') }),
  });
  if (!res.ok) throw new Error(`torrent quality ${res.status}`);
  return res.json();
}

/* The folder the app scans. Saved beside the app, because the catalog, the
 * artwork cache and the download queue all live inside the library itself —
 * the answer says whether a restart is still needed (`libraryRootPending`). */
export async function setLibraryRoot(libraryRoot) {
  const res = await fetch('/api/settings/library-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: String(libraryRoot || '') }),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) throw new Error(payload?.error || `library folder ${res.status}`);
  return payload;
}

/* Relaunches the bundled app, so the new library folder is the one it opens. */
export async function restartApp() {
  const res = await fetch('/api/restart', { method: 'POST' });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) throw new Error(payload?.error || `restart ${res.status}`);
  return payload;
}

/* Sound default for the hero preview and the player. */
export async function setAutoplaySound(autoplaySound) {
  const res = await fetch('/api/settings/autoplay-sound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoplaySound: Boolean(autoplaySound) }),
  });
  if (!res.ok) throw new Error(`autoplay sound ${res.status}`);
  return res.json();
}

/* Download limits: parallel transfers and the combined speed cap in MB/s
 * (0 = unlimited). The server applies both to the queue immediately. */
export async function setDownloadLimits({ maxActive, limitMBps } = {}) {
  const body = {};
  if (maxActive !== undefined) body.maxActive = Number(maxActive);
  if (limitMBps !== undefined) body.limitMBps = Number(limitMBps);
  const res = await fetch('/api/settings/download-limits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) throw new Error(payload?.error || `download limits ${res.status}`);
  return payload;
}

/* Removes one episode/movie file from disk. Needs DELETE /api/item/:id on the server. */
export async function deleteLibraryItem(id) {
  const res = await fetch(`/api/item/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `delete failed (${res.status})`);
  }
  return res.json().catch(() => ({}));
}

/* Bulk delete: one request and one library scan for the whole series. The
 * server reports per-file failures, so a clip still open in the player does
 * not hide the episodes that did go away. */
export async function deleteLibraryItems(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) return { removed: 0, failed: [] };
  const res = await fetch('/api/items/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: list }),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error */ }
  if (!payload) throw new Error(`delete failed (${res.status})`);
  return payload;
}

export function subtitleUrl(id, lang) {
  return `/api/subtitle/${encodeURIComponent(id)}/${encodeURIComponent(lang)}`;
}

export async function cancelDownload(id) {
  const res = await fetch(`/api/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`cancel ${res.status}`);
  return res.json();
}

/* best-effort: tells the server the new queue order (ignored if unsupported) */
export async function reorderDownloads(ids) {
  try {
    await fetch('/api/downloads/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } catch { /* order stays local */ }
}

export async function retryDownload(id) {
  const res = await fetch(`/api/downloads/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  if (!res.ok) throw new Error(`retry ${res.status}`);
  return res.json();
}

/* Pause keeps the partial payload on disk; resume picks it up again. */
export async function pauseDownload(id) {
  const res = await fetch(`/api/downloads/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error(`pause ${res.status}`);
  return res.json();
}

export async function resumeDownload(id) {
  const res = await fetch(`/api/downloads/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(`resume ${res.status}`);
  return res.json();
}

export function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function qualityLabel(item) {
  if (item.height >= 2000) return '4K';
  if (item.height >= 1000) return 'HD';
  return item.height ? 'SD' : '';
}

export function thumbUrl(item, width = 480) {
  // Always the title's official artwork, never a frame from the video.
  // `width` asks the server for a JPEG scaled to the slot (0 = original).
  const w = Number(width) > 0 ? `?w=${Math.round(Number(width))}` : '';
  return `/api/art/${item.id}/backdrop${w}`;
}

/* Cached hero still + 8 s preview clip (see server/hero.js). */
export function heroImageUrl(item) {
  return `/api/hero/${encodeURIComponent(item.id)}/image.jpg`;
}

export function heroPreviewUrl(item) {
  return `/api/hero/${encodeURIComponent(item.id)}/preview.mp4`;
}

/* Transparent title wordmark from the catalog. Answers 404 when the title has
 * none, which the UI treats as "keep the text title". The version tag matters:
 * browsers still hold the old `/logo` response, which was the backdrop image,
 * for a day. */
export function logoUrl(item) {
  return `/api/art/${encodeURIComponent(item.id)}/logo?v=2`;
}

export function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or disabled */
  }
}

export function getMyList() {
  const list = readJson(LIST_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function toggleMyList(id) {
  const list = getMyList();
  const idx = list.indexOf(id);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift(id);
  writeJson(LIST_KEY, list);
  return idx < 0;
}

export function isInMyList(id) {
  return getMyList().includes(id);
}

/* Titles that live in the download catalog, not on disk. They are kept as
 * small snapshot objects so the My List row can draw them without a lookup. */
const REMOTE_LIST_KEY = 'netflix-home:my-list-remote';

export function getRemoteList() {
  const list = readJson(REMOTE_LIST_KEY, []);
  return Array.isArray(list) ? list.filter((entry) => entry && entry.key && entry.title) : [];
}

export function isInRemoteList(key) {
  return getRemoteList().some((entry) => entry.key === key);
}

export function toggleRemoteList(entry) {
  if (!entry?.key) return false;
  const list = getRemoteList();
  const idx = list.findIndex((item) => item.key === entry.key);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift(entry);
  writeJson(REMOTE_LIST_KEY, list);
  return idx < 0;
}

function getProgress() {
  const all = readJson(PROGRESS_KEY, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

export function progressFor(id) {
  const entry = getProgress()[id];
  if (!entry || !entry.d) return null;
  return entry;
}

export function saveProgress(id, t, d) {
  if (!id || !Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return;
  const all = getProgress();
  if (t < 5) {
    delete all[id];
  } else if (t / d > 0.965) {
    all[id] = { t: d, d, updatedAt: Date.now(), finished: true };
  } else {
    all[id] = { t, d, updatedAt: Date.now(), finished: false };
  }
  writeJson(PROGRESS_KEY, all);
}

export function debounce(fn, ms = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/* ---------- loading skeletons ---------- */

/* An image counts as "ready" once it loaded or failed. Until then the CSS draws a
 * shimmer behind it (img[src]:not(.img-ready)). Capture phase, because load and
 * error events do not bubble. */
if (typeof document !== 'undefined') {
  const markReady = (e) => {
    if (e.target instanceof HTMLImageElement) e.target.classList.add('img-ready');
  };
  document.addEventListener('load', markReady, true);
  document.addEventListener('error', markReady, true);
}

/* Sets an image source and restarts its shimmer when the picture really changes. */
export function setImg(img, src) {
  if (!img) return;
  const next = src || '';
  const current = img.getAttribute('src') || '';
  if (current === next) return;
  img.classList.remove('img-ready');
  if (next) img.setAttribute('src', next);
  else img.removeAttribute('src');
}

/* One shimmer block. `cls` adds the shape, `w`/`h` override its size. */
export function skel(cls = '', w, h) {
  const el = document.createElement('div');
  el.className = `skeleton${cls ? ` ${cls}` : ''}`;
  if (w) el.style.width = w;
  if (h) el.style.height = h;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/* Stacked text lines; the last one is shorter, like a paragraph. */
export function skelLines(count = 3, { height = '13px', gap = '10px', last = '62%' } = {}) {
  const box = document.createElement('div');
  box.className = 'sk-lines';
  box.style.gap = gap;
  box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i += 1) {
    box.append(skel('sk-line', i === count - 1 && count > 1 ? last : '100%', height));
  }
  return box;
}

/* Metadata row: year, runtime, quality chips. */
export function skelMeta() {
  const box = document.createElement('div');
  box.className = 'sk-meta';
  box.setAttribute('aria-hidden', 'true');
  box.append(skel('sk-line', '44px', '14px'), skel('sk-line', '64px', '14px'), skel('sk-chip'), skel('sk-line', '110px', '14px'));
  return box;
}

/* 16:9 card, same size as .card in rows and grids. */
function skelCard() {
  const card = document.createElement('div');
  card.className = 'card sk-card skeleton';
  card.setAttribute('aria-hidden', 'true');
  return card;
}

export function skelCards(count = 6) {
  return Array.from({ length: count }, skelCard);
}

/* 2:3 poster with two text lines, same shape as .online-card. */
export function skelPoster() {
  const card = document.createElement('div');
  card.className = 'online-card sk-poster';
  card.setAttribute('aria-hidden', 'true');
  card.append(skel('sk-art'), skel('sk-line', '78%', '12px'), skel('sk-line', '44%', '10px'));
  return card;
}

/* Episode row: thumbnail, two lines and an action button. */
function skelEpisode({ button = true } = {}) {
  const row = document.createElement('div');
  row.className = 'sk-episode';
  row.setAttribute('aria-hidden', 'true');
  const lines = document.createElement('div');
  lines.className = 'sk-episode-lines';
  lines.append(skel('sk-line', '46%', '13px'), skel('sk-line', '28%', '10px'));
  row.append(skel('sk-episode-thumb'), lines);
  if (button) row.append(skel('sk-episode-btn'));
  return row;
}

export function skelEpisodes(count = 4, opts) {
  return Array.from({ length: count }, () => skelEpisode(opts));
}

/* Download queue entry: poster, title, progress bar. */
export function skelDownload() {
  const row = document.createElement('div');
  row.className = 'sk-download';
  row.setAttribute('aria-hidden', 'true');
  const lines = document.createElement('div');
  lines.className = 'sk-episode-lines';
  lines.append(skel('sk-line', '64%', '13px'), skel('sk-line', '38%', '10px'), skel('sk-line', '100%', '5px'));
  row.append(skel('sk-download-thumb'), lines);
  return row;
}
