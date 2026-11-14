export const LIB_STORAGE_KEY = 'netflix-home:library';
export const LIST_KEY = 'netflix-home:mylist';
export const PROGRESS_KEY = 'netflix-home:progress';
export const PROFILE_KEY = 'netflix-home:profile';

export async function getLibrary() {
  const res = await fetch('/api/library', { cache: 'no-store' });
  if (!res.ok) throw new Error(`library ${res.status}`);
  return res.json();
}

export async function rescanLibrary() {
  const res = await fetch('/api/rescan', { method: 'POST' });
  if (!res.ok) throw new Error(`rescan ${res.status}`);
  return res.json();
}

/* Stops the bundled app: the server exits, so the page goes dead afterwards. */
export async function quitApp() {
  const res = await fetch('/api/quit', { method: 'POST' });
  if (!res.ok) throw new Error(`quit ${res.status}`);
  return res.json();
}

export async function searchCatalog(query, page = 1) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const res = await fetch(`/api/catalog/search?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`catalog search ${res.status}`);
  return res.json();
}

export async function getFallbackCatalog() {
  const res = await fetch('/api/catalog/fallback', { cache: 'no-store' });
  if (!res.ok) throw new Error(`catalog fallback ${res.status}`);
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

export async function startCastleDownload(body) {
  const res = await fetch('/api/castle/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `download failed (${res.status})`);
  }
  return res.json();
}

export async function getCatalogItem(identifier) {
  const res = await fetch(`/api/catalog/item/${encodeURIComponent(identifier)}`, { cache: 'no-store' });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    const err = new Error(payload?.error || `catalog item ${res.status}`);
    err.status = res.status;
    err.files = payload?.files;
    throw err;
  }
  return res.json();
}

export async function startDownload(body) {
  const res = await fetch('/api/downloads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `download failed (${res.status})`);
  }
  return res.json();
}

export async function startSeriesDownload(body) {
  const res = await fetch('/api/downloads/series', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new Error(payload?.error || `series download failed (${res.status})`);
  }
  return res.json();
}

export async function getDownloads() {
  const res = await fetch('/api/downloads', { cache: 'no-store' });
  if (!res.ok) throw new Error(`downloads ${res.status}`);
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

export async function getSubtitles(id) {
  const res = await fetch(`/api/subtitles/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`subtitles ${res.status}`);
  return res.json();
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

export function thumbUrl(item) {
  // Always the title's official artwork, never a frame from the video.
  return `/api/art/${item.id}/backdrop`;
}

/* Cached hero still + 12 s preview clip (see server/hero.js). */
export function heroImageUrl(item) {
  return `/api/hero/${encodeURIComponent(item.id)}/image.jpg`;
}

export function heroPreviewUrl(item) {
  return `/api/hero/${encodeURIComponent(item.id)}/preview.mp4`;
}

export function posterUrl(item) {
  // Poster art for portrait slots; the catalog's own image, cached locally.
  return `/api/art/${item.id}/poster`;
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

export function getProgress() {
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

export function continueWatching(items) {
  const progress = getProgress();
  return items
    .map((item) => ({ item, p: progress[item.id] }))
    .filter(({ p }) => p && Number.isFinite(p.t) && p.t > 5 && p.d > 0 && p.t / p.d < 0.965)
    .sort((a, b) => (b.p.updatedAt || 0) - (a.p.updatedAt || 0))
    .map(({ item, p }) => ({ item, progress: Math.min(1, p.t / p.d) }));
}

export function debounce(fn, ms = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function escapeText(el, text) {
  el.textContent = text ?? '';
  return el;
}

export function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

export function initials(name) {
  return (name || 'N').trim().charAt(0).toUpperCase();
}
