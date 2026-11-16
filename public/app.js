import {
  getLibrary, rescanLibrary, quitApp, formatDuration, formatSize, formatClock,
  syncCastleCatalog, getCastleSyncStatus,
  qualityLabel, thumbUrl, logoUrl, toggleMyList, isInMyList, getMyList, progressFor,
  getRemoteList, isInRemoteList, toggleRemoteList,
  getSeries, getSeriesCatalog, debounce, createEl,
  browseCastle,
  searchOnline, getOnlineTitle, searchCastle, getCastleTitle, getCastleSeriesEpisodes, startCastleDownload,
  getSavedCastle,
  deleteLibraryItem, deleteLibraryItems, getDownloads, cancelDownload, retryDownload, reorderDownloads,
  pauseDownload, resumeDownload,
  getSettings, setOfflineMode, setCastleFallback, setAutoplaySound, setDownloadLimits,
  setLibraryRoot, restartApp,
  readJson, writeJson, heroImageUrl, heroPreviewUrl,
  setImg, skel, skelLines, skelMeta, skelCards, skelPoster, skelEpisodes, skelDownload,
  decodesHevc,
} from './common.js';

const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'cancelling']);
const SEARCH_HISTORY_KEY = 'netflix-home:search-history';
const PREVIEW_MUTED_KEY = 'netflix-home:preview-muted';
const SEARCH_HISTORY_LIMIT = 8;

const state = {
  library: null,
  libraryPrint: '',
  items: [],
  byId: new Map(),
  view: 'home',
  heroId: null,
  heroPlayId: null,
  modalPlayId: null,
  seriesSeason: 0,
  pollTimer: null,
  previewTimer: null,
  previewStart: 0,
  previewMode: 'clip',
  previewMuted: readJson(PREVIEW_MUTED_KEY, false) === true,
  offline: false,
  // Mirrors the server's Castle fallback setting: false = Torrentio only.
  castleFallback: true,
  // Mirrors the server's sound setting: false = preview and player start muted.
  autoplaySound: true,
  // Mirrors the server's download queue: parallel transfers and the combined
  // speed cap in MB/s (0 = no limit).
  downloadMaxActive: 3,
  downloadLimitMBps: 0,
  // Library folder this tab is scanning, and the one config.json holds. They
  // differ until the app restarts.
  libraryRoot: '',
  libraryRootSetting: '',
  libraryRestartPending: false,
  searchHistory: readJson(SEARCH_HISTORY_KEY, []),
  toastTimer: null,
  toastExitTimer: null,
  lastFocus: null,
  bootAt: Date.now(),
  rescanning: false,
  syncing: false,
  onlineBrowse: [],
  onlineBrowseLoading: false,
  /* Saved Catalogue poster per title, read once at boot. The downloads drawer
   * uses it when a finished file's own artwork is gone. */
  savedTitles: [],
  onlineBrowseToken: 0,
  onlineBrowseAbort: null,
  onlineMode: 'random',
  onlineGenre: '',
  downloads: [],
  downloadsSynced: false,
  downloadsLoaded: false,
  downloadPoll: null,
  notifs: [],
  onlineResults: [],
  onlineLoading: false,
  onlineError: '',
  onlineToken: 0,
  onlineAbort: null,
  onlineCache: new Map(),
  onlineTitle: null,
  castleResults: [],
  castleLoading: false,
  castleToken: 0,
  castleAbort: null,
  castleCache: new Map(),
  castleTitle: null,
  castleSeason: 0,
  castleBusy: false,
  castleDetailToken: 0,
  castleSeasonToken: 0,
  castlePlanCache: new Map(),
  castlePlanToken: 0,
  castleTrailerToken: 0,
  castleTrailerTimer: null,
  castleTrailerPlayTimer: null,
  castleVolumeTimer: 0,
  castleMuted: false,
  castleOpenedAt: 0,
  castleLocal: null,
  castleCatalog: null,
  castleSig: '',
  sheetTarget: null,
  heroPickId: null,
  heroVisible: true,
  heroPausedForScroll: false,
  heroVolumeTimer: 0,
  castleVisible: true,
  castlePausedForScroll: false,
  seriesCatalog: new Map(),
  seriesCatalogLoading: new Set(),
  queuedEpisodes: new Set(),
};

const $ = (id) => document.getElementById(id);

const els = {
  nav: $('nav'),
  hero: $('hero'),
  heroImg: $('heroImg'),
  heroVideo: $('heroVideo'),
  heroTitle: $('heroTitle'),
  heroLogo: $('heroLogo'),
  heroMeta: $('heroMeta'),
  heroPlot: $('heroPlot'),
  heroPlay: $('heroPlay'),
  heroPlayLabel: $('heroPlayLabel'),
  heroInfo: $('heroInfo'),
  heroMute: $('heroMute'),
  heroRating: $('heroRating'),
  rows: $('rows'),
  loading: $('loading'),
  dlSkeleton: $('dlSkeleton'),
  emptyHero: $('emptyHero'),
  emptyPath: $('emptyPath'),
  emptyStatus: $('emptyStatus'),
  emptyScan: $('emptyScan'),
  homeView: $('homeView'),
  gridView: $('gridView'),
  gridTitle: $('gridTitle'),
  gridSub: $('gridSub'),
  grid: $('grid'),
  gridEmpty: $('gridEmpty'),
  searchOverlay: $('searchOverlay'),
  searchInput: $('searchInput'),
  searchClose: $('searchClose'),
  searchHint: $('searchHint'),
  searchHistory: $('searchHistory'),
  searchResults: $('searchResults'),
  searchLocalSection: $('searchLocalSection'),
  searchLocalCount: $('searchLocalCount'),
  searchLocalEmpty: $('searchLocalEmpty'),
  searchCastleSection: $('searchCastleSection'),
  searchCastleCount: $('searchCastleCount'),
  searchCastleResults: $('searchCastleResults'),
  searchCastleLoading: $('searchCastleLoading'),
  searchCastleEmpty: $('searchCastleEmpty'),
  searchCastleError: $('searchCastleError'),
  searchOnlineSection: $('searchOnlineSection'),
  searchOnlineCount: $('searchOnlineCount'),
  searchOnlineResults: $('searchOnlineResults'),
  searchOnlineLoading: $('searchOnlineLoading'),
  searchOnlineEmpty: $('searchOnlineEmpty'),
  searchOnlineError: $('searchOnlineError'),
  searchBtn: $('searchBtn'),
  offlineBtn: $('offlineBtn'),
  offlineLabel: $('offlineLabel'),
  refreshBtn: $('refreshBtn'),
  modal: $('modal'),
  modalImg: $('modalImg'),
  modalTitle: $('modalTitle'),
  modalMeta: $('modalMeta'),
  modalPlot: $('modalPlot'),
  modalSide: $('modalSide'),
  modalPlay: $('modalPlay'),
  modalPlayLabel: $('modalPlayLabel'),
  modalList: $('modalList'),
  seriesBlock: $('seriesBlock'),
  seriesFind: $('seriesFind'),
  seriesSeasons: $('seriesSeasons'),
  seriesEpisodes: $('seriesEpisodes'),
  moreGrid: $('moreGrid'),
  main: document.querySelector('main'),
  onlineModal: $('onlineModal'),
  onlineBackdrop: $('onlineBackdrop'),
  onlineKicker: $('onlineKicker'),
  onlineTitle: $('onlineTitle'),
  onlineMeta: $('onlineMeta'),
  onlinePlot: $('onlinePlot'),
  onlineWatchLink: $('onlineWatchLink'),
  onlineImdbLink: $('onlineImdbLink'),
  onlineCastleBtn: $('onlineCastleBtn'),
  onlineSeasonBlock: $('onlineSeasonBlock'),
  onlineSeasonTabs: $('onlineSeasonTabs'),
  onlineEpisodes: $('onlineEpisodes'),
  castleModal: $('castleModal'),
  castleBackdrop: $('castleBackdrop'),
  castleTrailer: $('castleTrailer'),
  castleKicker: $('castleKicker'),
  castleLogo: $('castleLogo'),
  castleMute: $('castleMute'),
  castleTitle: $('castleTitle'),
  castleMeta: $('castleMeta'),
  castlePlot: $('castlePlot'),
  castleSeasonDownload: $('castleSeasonDownload'),
  castleSeasonDelete: $('castleSeasonDelete'),
  castleList: $('castleList'),
  castleResume: $('castleResume'),
  castleDownloadBlock: $('castleDownloadBlock'),
  castleSize: $('castleSize'),
  castleSource: $('castleSource'),
  settingsModal: $('settingsModal'),
  castleFallbackBtn: $('castleFallbackBtn'),
  castleFallbackLabel: $('castleFallbackLabel'),
  autoplaySoundBtn: $('autoplaySoundBtn'),
  autoplaySoundLabel: $('autoplaySoundLabel'),
  dlMaxActiveInput: $('dlMaxActiveInput'),
  dlMaxActiveSave: $('dlMaxActiveSave'),
  dlSpeedInput: $('dlSpeedInput'),
  dlSpeedSave: $('dlSpeedSave'),
  dlLimitError: $('dlLimitError'),
  libraryRootInput: $('libraryRootInput'),
  libraryRootSave: $('libraryRootSave'),
  libraryRootHint: $('libraryRootHint'),
  libraryRootError: $('libraryRootError'),
  libraryRestartRow: $('libraryRestartRow'),
  libraryRestartBtn: $('libraryRestartBtn'),
  castleSeasonTabs: $('castleSeasonTabs'),
  castleEpisodes: $('castleEpisodes'),
  castleStatus: $('castleStatus'),
  toast: $('toast'),
  profile: $('profile'),
  profileBtn: $('profileBtn'),
  profileMenu: $('profileMenu'),
  menuSettings: $('menuSettings'),
  menuRescan: $('menuRescan'),
  menuQuit: $('menuQuit'),
  menuPath: $('menuPath'),
  avatar: $('avatar'),
  avatarMenu: $('avatarMenu'),
  profileName: $('profileName'),
  onlineView: $('onlineView'),
  onlineGrid: $('onlineGrid'),
  onlineEmpty: $('onlineEmpty'),
  onlineLoading: $('onlineLoading'),
  onlineNote: $('onlineNote'),
  onlineShuffle: $('onlineShuffle'),
  onlineFilters: $('onlineFilters'),
  onlineModes: $('onlineModes'),
  onlineGenres: $('onlineGenres'),
  downloadsBtn: $('downloadsBtn'),
  downloadsBadge: $('downloadsBadge'),
  downloadsPanel: $('downloadsPanel'),
  downloadsList: $('downloadsList'),
  downloadsEmpty: $('downloadsEmpty'),
  downloadsCount: $('downloadsCount'),
  downloadsRoot: $('downloadsRoot'),
  dlGroups: $('dlGroups'),
  dlClear: $('dlClear'),
  dlSettings: $('dlSettings'),
  notif: $('notif'),
  bellBtn: $('bellBtn'),
  notifMenu: $('notifMenu'),
  notifList: $('notifList'),
  notifEmpty: $('notifEmpty'),
  notifBadge: $('notifBadge'),
  notifRead: $('notifRead'),
  notifClear: $('notifClear'),
};

/* ---------- boot ---------- */

const BOOT_KEY = 'netflix-home:startup-done';

function initBoot() {
  const overlay = $('bootScreen');
  const video = $('bootVideo');
  if (!overlay || !video) return;
  let finished = false;

  const cleanup = () => {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch { /* ignore */ }
    overlay.remove();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    overlay.classList.add('is-done');
    setTimeout(cleanup, 450);
  };

  let seen = false;
  try { seen = sessionStorage.getItem(BOOT_KEY) === '1'; } catch { /* storage blocked */ }
  if (seen || prefersReducedMotion()) {
    overlay.remove();
    return;
  }
  try { sessionStorage.setItem(BOOT_KEY, '1'); } catch { /* storage blocked */ }

  // The logo film always plays with sound, at a moderate level.
  video.volume = 0.4;
  const safety = setTimeout(finish, 6500);
  video.addEventListener('ended', finish, { once: true });
  video.addEventListener('error', finish, { once: true });

  const unmuteOnGesture = () => {
    video.muted = false;
    document.removeEventListener('pointerdown', unmuteOnGesture, true);
    document.removeEventListener('keydown', unmuteOnGesture, true);
  };

  video.muted = false;
  video.play().catch(() => {
    // Browsers block audible autoplay until the first interaction. Start muted
    // and restore the sound as soon as the page is touched.
    video.muted = true;
    document.addEventListener('pointerdown', unmuteOnGesture, true);
    document.addEventListener('keydown', unmuteOnGesture, true);
    video.play().catch(finish);
  });
}

/* Placeholders for panels that are filled by the network: the search result
 * grids and the downloads drawer. Everything else builds its skeleton on demand. */
function initSkeletons() {
  const loaders = [
    [els.searchCastleLoading, 'Checking the download catalog'],
    [els.searchOnlineLoading, 'Searching movies and series'],
  ];
  for (const [el, label] of loaders) {
    el.classList.add('sk-loading');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', label);
    const grid = createEl('div', 'online-grid');
    grid.append(...Array.from({ length: 6 }, skelPoster));
    el.replaceChildren(grid);
  }
  els.downloadsCount.replaceChildren(skel('sk-line', '120px', '11px'));
  els.dlSkeleton.replaceChildren(...Array.from({ length: 3 }, skelDownload));
  els.downloadsEmpty.hidden = true;
}

async function boot() {
  initBoot();
  initSkeletons();
  bindStaticEvents();
  getSettings()
    .then((settings) => {
      state.offline = Boolean(settings.offline);
      applyOfflineUi();
      state.castleFallback = settings.castleFallback !== false;
      applyCastleFallbackUi();
      state.autoplaySound = settings.autoplaySound !== false;
      applyAutoplaySoundUi();
      state.libraryRoot = settings.libraryRoot || '';
      state.libraryRootSetting = settings.libraryRootSetting || state.libraryRoot;
      state.libraryRestartPending = Boolean(settings.libraryRootPending);
      applyLibraryRootUi();
    })
    .catch(() => { /* older server: leave the switch online */ });
  await loadLibrary({ first: true });

  // One call for the artwork and the show names of everything opened once, so
  // the downloads drawer can still paint a poster after its files are gone.
  getSavedCastle()
    .then((data) => {
      state.savedTitles = Array.isArray(data.results) ? data.results : [];
    })
    .catch(() => { /* drawer falls back to the job poster */ });

  // The player links here when the next episode is not on disk:
  //   /?open=<episode id>&season=2&episode=3
  // Open that series sheet on the requested season.
  const deepLink = readSheetDeepLink();
  if (deepLink && state.byId.has(deepLink.open)) {
    state.sheetTarget = deepLink.season
      ? { season: deepLink.season, episode: deepLink.episode || 0 }
      : null;
    openModal(deepLink.open);
  }

  schedulePoll();
  refreshDownloads({ initial: true });
  scheduleDownloadPoll();
}

/* Cheap identity of the library: length plus every mtime. An ETag miss or a
 * poll that returns the same titles must not rebuild the DOM. */
function libraryFingerprint(items) {
  let hash = items.length;
  for (const item of items) hash = (Math.imul(hash, 31) + (Number(item.mtime) || 0)) | 0;
  return `${items.length}:${hash}`;
}

async function loadLibrary({ first = false } = {}) {
  try {
    const data = await getLibrary();
    const previousUpdated = state.library?.updatedAt;
    const previousPrint = state.libraryPrint;
    state.library = data;
    state.items = (data.items || []).map(ensureSeriesFields);
    state.byId = new Map(state.items.map((i) => [i.id, i]));
    state.libraryPrint = libraryFingerprint(state.items);
    if (els.emptyPath) els.emptyPath.textContent = data.root || 'G:\\Movies';
    els.menuPath.textContent = data.root ? `Library: ${data.root}` : '';
    if (first) setProfile();

    // A 304 (or a rescan that produced the same rows) leaves the DOM alone.
    const changed = previousUpdated !== data.updatedAt || previousPrint !== state.libraryPrint;
    if (changed || first) renderAll();
    updateLoadingState();
  } catch (err) {
    console.error(err);
    if (first) {
      els.loading.hidden = false;
      els.loading.classList.add('is-error');
      els.emptyHero.hidden = true;
    }
  }
}

function readSheetDeepLink() {
  const params = new URLSearchParams(location.search);
  const open = params.get('open');
  if (!open) return null;
  const season = Number(params.get('season'));
  const episode = Number(params.get('episode'));
  return {
    open,
    season: Number.isFinite(season) && season > 0 ? season : 0,
    episode: Number.isFinite(episode) && episode > 0 ? episode : 0,
  };
}

function updateLoadingState() {
  els.loading.classList.remove('is-error');
  const noItems = state.items.length === 0;
  const scanning = Boolean(state.library?.scanning);
  els.loading.hidden = !noItems || !scanning;
  els.emptyHero.hidden = !(noItems && !scanning);
  els.hero.hidden = noItems;
  els.emptyScan.disabled = scanning;
  els.emptyStatus.textContent = scanning ? 'Scanning folders…' : '';
}

function schedulePoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    const scanning = Boolean(state.library?.scanning);
    const stillEmpty = !state.items.length;
    const early = Date.now() - state.bootAt < 120000;
    if (scanning || (stillEmpty && early)) {
      await loadLibrary();
    }
  }, 2500);

  setInterval(() => {
    if (!document.hidden) loadLibrary();
  }, 300000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadLibrary();
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      loadLibrary();
      if (state.view === 'home') setupPreview(state.byId.get(state.heroId));
    }
  });
}

/* ---------- series grouping + ambient color + fades ---------- */

const EPISODE_FILE_RE = /\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i;
const FILE_NOISE_RE = /\b(?:2160p|1440p|1080p|720p|576p|480p|360p|4k|uhd|hdr10?|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdrip|dvdrip|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|dts|ddp?\d(?:\.\d)?)\b/gi;
const AMBIENT_KEY = 'netflix-home:colors';
const ambientCache = readJson(AMBIENT_KEY, {}) || {};

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function fadeOut(fn, ms = 180) {
  if (prefersReducedMotion()) {
    fn();
    return;
  }
  document.body.classList.add('leaving');
  setTimeout(fn, ms);
  setTimeout(() => document.body.classList.remove('leaving'), ms + 500);
}

/* The server supplies these fields; this keeps an older payload working. */
function ensureSeriesFields(item) {
  if (typeof item.isSeries === 'boolean') return item;
  const source = String(item.fileName || item.title || '');
  const match = EPISODE_FILE_RE.exec(source);
  if (!match) {
    return { ...item, isSeries: false, seriesKey: null, seriesTitle: null, season: null, episode: null, episodeLabel: null, displayTitle: item.title };
  }
  const season = Number(match[1]);
  const episode = Number(match[2]);
  const seriesTitle = source
    .replace(/\.[^.]+$/, '')
    .replace(match[0], ' ')
    .replace(/[._]+/g, ' ')
    .replace(FILE_NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim() || item.title;
  const episodeLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return {
    ...item,
    title: seriesTitle,
    seriesTitle,
    seriesKey: `local:${item.collection || ''}:${seriesTitle.toLowerCase()}`,
    season,
    episode,
    episodeLabel,
    displayTitle: `${seriesTitle} · ${episodeLabel}`,
    isSeries: true,
  };
}

function episodeScore(episode) {
  return (Number(episode.height) || 0) * 1000000 + (Number(episode.size) || 0);
}

/* Two files for the same episode are two qualities, not two episodes. */
function dedupeEpisodes(list) {
  const best = new Map();
  for (const episode of list) {
    const key = `${episode.season}x${episode.episode}`;
    const previous = best.get(key);
    if (!previous || episodeScore(episode) > episodeScore(previous)) best.set(key, episode);
  }
  return [...best.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function primaryEpisode(group) {
  const episodes = group.episodes || [];
  if (!episodes.length) return group;
  return episodes.find((episode) => {
    const p = progressFor(episode.id);
    return !p || (!p.finished && p.t / p.d < 0.965);
  }) || episodes[0];
}

/* One card per title: a series is one card with every episode attached. The key
 * is the title, not the folder: the same show in "Downloads" and
 * "Movies\Downloads" used to produce two identical cards. */
function groupLibrary(items = state.items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.isSeries
      ? `series:${normalizeSearchText(item.seriesTitle || item.title)}`
      : `movie:${item.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { ...item, episodes: item.isSeries ? [item] : null };
      groups.set(key, group);
      continue;
    }
    if (!item.isSeries) continue;
    group.episodes.push(item);
    if (item.mtime > group.mtime) {
      const episodes = group.episodes;
      Object.assign(group, item);
      group.episodes = episodes;
    }
  }
  for (const group of groups.values()) {
    if (!group.episodes) continue;
    // Remember every file id before duplicate qualities collapse, so a search
    // or My List entry pointing at the other copy still finds this card.
    group.ids = group.episodes.map((episode) => episode.id);
    group.episodes = dedupeEpisodes(group.episodes);
    group.episodeCount = group.episodes.length;
    group.seasons = [...new Set(group.episodes.map((episode) => episode.season))].sort((a, b) => a - b);
    group.playId = primaryEpisode(group).id;
  }
  return [...groups.values()];
}

function groupIndex(groups) {
  const index = new Map();
  for (const group of groups) {
    index.set(group.id, group);
    if (group.ids) for (const id of group.ids) index.set(id, group);
    if (group.episodes) for (const episode of group.episodes) index.set(episode.id, group);
  }
  return index;
}

/* Turn a mixed list of episode/movie ids into unique title groups. */
function groupItems(groups, ids) {
  const index = groupIndex(groups);
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const group = index.get(id);
    if (!group || seen.has(group.id)) continue;
    seen.add(group.id);
    out.push(group);
  }
  return out;
}

function progressOfGroup(group) {
  if (!group?.episodes) {
    const p = progressFor(group.id);
    if (!p || p.finished || !(p.t > 5) || !(p.d > 0)) return null;
    return { ratio: Math.min(1, p.t / p.d), episode: group, updatedAt: p.updatedAt || 0 };
  }
  let best = null;
  for (const episode of group.episodes) {
    const p = progressFor(episode.id);
    if (!p || p.finished || !(p.t > 5) || !(p.d > 0) || p.t / p.d >= 0.965) continue;
    if (!best || (p.updatedAt || 0) > best.updatedAt) {
      best = { ratio: Math.min(1, p.t / p.d), episode, updatedAt: p.updatedAt || 0 };
    }
  }
  return best;
}

function sampleDominant(img) {
  if (!img?.naturalWidth) return null;
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 180) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
    if (lum < 24 || lum > 234) continue;
    const sat = max === 0 ? 0 : (max - min) / max;
    const key = `${r >> 5}:${g >> 5}:${b >> 5}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { r: 0, g: 0, b: 0, n: 0, weight: 0 };
      buckets.set(key, entry);
    }
    entry.r += r;
    entry.g += g;
    entry.b += b;
    entry.n += 1;
    entry.weight += 0.3 + sat * 1.6;
  }
  let best = null;
  let score = -1;
  for (const entry of buckets.values()) {
    const value = entry.weight * Math.sqrt(entry.n);
    if (value > score) {
      score = value;
      best = entry;
    }
  }
  if (!best || !best.n) return null;
  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
  };
}

function ambientFallback(id) {
  const hue = hash(id) % 360;
  return { hex: `hsl(${hue} 52% 46%)`, glow: `hsla(${hue}, 52%, 46%, 0.32)` };
}

function setAmbient(card, entry) {
  card.style.setProperty('--ambient', entry.hex);
  card.style.setProperty('--ambient-glow', entry.glow);
}

function applyAmbient(card, img, item) {
  const cached = ambientCache[item.id];
  if (cached?.hex) {
    setAmbient(card, cached);
    return;
  }
  const run = () => {
    try {
      const rgb = sampleDominant(img);
      if (!rgb) {
        setAmbient(card, ambientFallback(item.id));
        return;
      }
      const hex = `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const entry = { hex, glow: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.34)` };
      ambientCache[item.id] = entry;
      writeJson(AMBIENT_KEY, ambientCache);
      setAmbient(card, entry);
    } catch {
      setAmbient(card, ambientFallback(item.id));
    }
  };
  if (img.complete && img.naturalWidth) run();
  else img.addEventListener('load', run, { once: true });
  img.addEventListener('error', () => setAmbient(card, ambientFallback(item.id)), { once: true });
}

/* ---------- rendering ---------- */

function renderAll() {
  renderHero();
  renderRows();
  renderGridForCurrentView();
  updateLoadingState();
}

/* A random title every time the page opens, so the billboard is never stuck on
 * the last thing watched. The pick stays put while the session lasts. */
function pickHero() {
  const groups = groupLibrary();
  if (!groups.length) return null;
  const current = state.heroPickId && groups.find((group) => group.id === state.heroPickId);
  if (current) return current;
  const pick = groups[Math.floor(Math.random() * groups.length)];
  state.heroPickId = pick.id;
  return pick;
}

function renderHero() {
  const item = pickHero();
  if (!item) {
    state.heroId = null;
    state.heroPlayId = null;
    stopPreview();
    return;
  }
  const same = state.heroId === item.id;
  state.heroId = item.id;
  state.heroPlayId = item.playId || item.id;
  els.hero.hidden = false;

  els.heroTitle.textContent = item.title;
  els.heroImg.alt = item.title;
  // The title's main picture: official artwork first, cached hero still as the fallback.
  heroArt(item);
  heroLogo(item);
  els.heroRating.textContent = item.rating || (item.height >= 1000 ? 'HD' : 'NR');

  const progress = progressOfGroup(item);
  const meta = [
    item.year || null,
    item.episodes ? `${item.episodes.length} episode${item.episodes.length === 1 ? '' : 's'}` : formatDuration(item.durationSec),
    item.genres?.length ? item.genres.slice(0, 2).join(' · ') : null,
  ].filter(Boolean);
  els.heroMeta.replaceChildren();
  meta.forEach((part, i) => {
    if (i > 0) els.heroMeta.append(createEl('span', 'dot', '•'));
    els.heroMeta.append(createEl('span', '', part));
  });
  if (item.rating) els.heroMeta.append(createEl('span', 'chip', item.rating));
  if (qualityLabel(item)) els.heroMeta.append(createEl('span', 'chip hd', qualityLabel(item)));

  els.heroPlot.textContent = item.plot
    || `Streaming from your library in ${qualityLabel(item) || 'full'} quality. ${item.genres?.length ? item.genres.join(', ') + '.' : ''}`.trim();

  const resume = progress && !progress.finished;
  els.heroPlayLabel.textContent = resume ? 'Resume' : 'Play';

  if (!same) setupPreview(item);
}

/* Hero picture: the title's official artwork, with the cached still as a
 * fallback when the catalog has no image for it. */
function heroArt(item) {
  const img = els.heroImg;
  img.onerror = () => {
    img.onerror = null;
    img.classList.remove('img-ready');
    setImg(img, heroImageUrl(item));
  };
  // Full-size backdrop: this is the largest thing on screen and the one image
  // worth downloading at native width.
  img.fetchPriority = 'high';
  setImg(img, thumbUrl(item, 0));
}

/* Hero logo: the catalog wordmark replaces the text title. The heading keeps
 * its space until the image has actually loaded, so a missing logo simply
 * leaves the text in place. */
function heroLogo(item) {
  const logo = els.heroLogo;
  logo.classList.remove('loaded');
  els.heroTitle.classList.remove('has-logo');
  logo.onload = () => {
    logo.classList.add('loaded');
    els.heroTitle.classList.add('has-logo');
  };
  logo.onerror = () => {
    logo.classList.remove('loaded');
    els.heroTitle.classList.remove('has-logo');
    logo.removeAttribute('src');
  };
  logo.src = logoUrl(item);
}

function setupPreview(item) {
  stopPreview();
  if (!item || item.durationSec < 90) return;
  state.previewStart = Math.min(Math.max(20, item.durationSec * 0.12), Math.max(20, item.durationSec - 80));
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    if (document.hidden || state.view !== 'home' || !state.heroVisible || isModalOpen() || !els.searchOverlay.hidden) return;
    playPreview(item);
  }, 4000);
}

function playPreview(item) {
  const video = els.heroVideo;
  const id = item.playId || item.id;
  video.volume = HERO_PREVIEW_VOLUME;
  /* A fresh title starts a fresh preview: never leave a scroll pause in place. */
  state.heroPausedForScroll = false;
  /* The sound setting is the default; the speaker button overrides it for this
   * visit (state.previewMuted). */
  video.muted = state.previewMuted || state.autoplaySound === false;
  // Keep the title's own artwork on screen while the trailer buffers.
  video.poster = thumbUrl(item, 960);
  syncHeroMute();
  video.classList.remove('playing');
  const start = state.previewStart;

  const attempt = () => {
    const playing = video.play();
    if (playing && typeof playing.catch === 'function') {
      playing.catch((err) => {
        if (err?.name !== 'NotAllowedError' || video.muted) return;
        video.muted = true;
        syncHeroMute(true);
        video.play().catch(() => {});
      });
    }
  };

  const useStream = () => {
    // No cached clip and no trailer: stream the real file and seek.
    state.previewMode = 'stream';
    video.onerror = null;
    video.loop = false;
    video.src = `/api/stream/${encodeURIComponent(id)}`;
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = start; } catch { /* seek may fail on some formats */ }
    }, { once: true });
    attempt();
  };

  const useClip = () => {
    state.previewMode = 'clip';
    video.loop = true;
    video.onerror = useStream;
    video.src = heroPreviewUrl({ id });
    attempt();
  };

  // Prefer the cached official trailer (Netflix clip first, Cinemeta/YouTube
  // fallback); the generated clip and then the real stream are fallbacks while
  // the file is still being fetched.
  // `v=2` steps around the copy browsers cached before Netflix became the
  // first source; the route itself is `no-cache`, so later swaps revalidate.
  state.previewMode = 'trailer';
  video.loop = true;
  video.onerror = useClip;
  video.src = `/api/hero/${encodeURIComponent(item.id)}/trailer.mp4?v=2`;
  attempt();
}

function syncHeroMute(blocked = false) {
  const muted = els.heroVideo.muted;
  els.heroMute.classList.toggle('is-muted', muted);
  els.heroMute.classList.toggle('blocked', blocked && muted);
  const label = muted
    ? (blocked ? 'Sound blocked — click to hear the preview' : 'Unmute preview')
    : 'Mute preview';
  els.heroMute.setAttribute('aria-label', label);
  els.heroMute.title = label;
}

const HERO_PREVIEW_VOLUME = 0.65;
const SCROLL_FADE_MS = 420;

function stopHeroVolumeFade() {
  if (state.heroVolumeTimer) clearTimeout(state.heroVolumeTimer);
  state.heroVolumeTimer = 0;
}

/* Same timer-based fade the sheet uses: the trailer is silent before it pauses
 * and fades back up where it left off, so scrolling never cuts the sound. */
function fadeHeroVolume(target, done) {
  const video = els.heroVideo;
  stopHeroVolumeFade();
  const from = Number.isFinite(video.volume) ? video.volume : 0;
  const to = Math.max(0, Math.min(1, target));
  const startedAt = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - startedAt) / SCROLL_FADE_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    try { video.volume = from + (to - from) * eased; } catch { /* ignore */ }
    if (t < 1) {
      state.heroVolumeTimer = setTimeout(step, 16);
      return;
    }
    state.heroVolumeTimer = 0;
    if (done) done();
  };
  state.heroVolumeTimer = setTimeout(step, 16);
}

/* Scrolling the billboard away pauses the trailer instead of leaving it
 * playing to an empty screen; scrolling back resumes it at the same spot. */
function setHeroPreviewVisible(visible) {
  const video = els.heroVideo;
  state.heroVisible = visible;
  if (!visible) {
    if (!video.src || video.paused) return;
    state.heroPausedForScroll = true;
    fadeHeroVolume(0, () => {
      if (state.heroVisible) return;
      try { video.pause(); } catch { /* ignore */ }
    });
    return;
  }
  if (!state.heroPausedForScroll) return;
  state.heroPausedForScroll = false;
  if (!video.src || state.view !== 'home' || document.hidden) return;
  const playing = video.play();
  if (playing && typeof playing.catch === 'function') {
    playing.then(() => {
      if (!video.muted) fadeHeroVolume(HERO_PREVIEW_VOLUME);
    }).catch(() => {});
  }
}

videoLoop();
function videoLoop() {
  els.heroVideo.addEventListener('timeupdate', () => {
    if (state.previewMode !== 'stream') return;
    if (!els.heroVideo.duration) return;
    if (els.heroVideo.currentTime > state.previewStart + 50) {
      try { els.heroVideo.currentTime = state.previewStart; } catch { /* ignore */ }
    }
  });
}

function stopPreview() {
  clearTimeout(state.previewTimer);
  stopHeroVolumeFade();
  state.heroPausedForScroll = false;
  const video = els.heroVideo;
  try {
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
  } catch { /* ignore */ }
  video.classList.remove('playing');
}

/* Clicking the preview skips it and goes back to the still frame. */
function skipPreview() {
  if (!els.heroVideo.classList.contains('playing')) return;
  stopPreview();
  syncHeroMute(false);
}

function renderRows() {
  els.rows.replaceChildren();
  const items = state.items;
  if (!items.length) return;

  const groups = groupLibrary(items);
  const progressMap = new Map();
  const episodeMap = new Map();

  // The same show can sit in two folders (Movies + Downloads). Continue
  // Watching lists it once: the latest episode of the season watched last.
  const watching = [];
  const watchingSeen = new Map();
  for (const group of groups) {
    const progress = progressOfGroup(group);
    if (!progress) continue;
    const ep = progress.episode || {};
    const candidate = {
      group,
      progress,
      updatedAt: progress.updatedAt || 0,
      season: Number(ep.season) || 0,
      episode: Number(ep.episode) || 0,
    };
    const key = group.isSeries
      ? `series:${String(group.seriesTitle || group.title).toLowerCase()}`
      : `movie:${group.id}`;
    const current = watchingSeen.get(key);
    if (!current) {
      watchingSeen.set(key, candidate);
      watching.push(candidate);
      continue;
    }
    const newer = candidate.updatedAt > current.updatedAt
      || (candidate.updatedAt === current.updatedAt
        && (candidate.season > current.season
          || (candidate.season === current.season && candidate.episode > current.episode)));
    if (!newer) continue;
    watching[watching.indexOf(current)] = candidate;
    watchingSeen.set(key, candidate);
  }

  for (const { group, progress } of watching) {
    progressMap.set(group.id, progress.ratio);

    // Continue Watching cards name the episode and how much is left.
    if (group.episodes && progress.episode) {
      const ep = progress.episode;
      const total = Number(ep.durationSec) || 0;
      const left = total > 0 ? Math.max(0, total * (1 - progress.ratio)) : 0;
      const label = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
      episodeMap.set(group.id, [label, left ? `${formatDuration(left)} left` : ''].filter(Boolean).join(' • '));
    }
  }
  watching.sort((a, b) => b.updatedAt - a.updatedAt);

  const list = getMyList();
  const listGroups = groupItems(groups, list);
  const remoteList = remoteListCards();
  const recent = [...groups].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

  const rows = [];
  if (watching.length) {
    rows.push({ title: 'Continue Watching', items: watching.map((entry) => entry.group), progressMap, episodeMap });
  }
  rows.push({ title: 'Recently Added', items: recent.slice(0, 14) });

  if (groups.length >= 5) {
    rows.push({ title: 'Top 10 in Your Library Today', type: 'top10', items: topTen(groups) });
  }

  for (const col of state.library.collections || []) {
    if (col.name === 'Movies' || col.items.length < 2) continue;
    const rowItems = groupItems(groups, col.items);
    if (rowItems.length >= 2) {
      rows.push({ title: col.name, items: rowItems, sub: `${rowItems.length} title${rowItems.length === 1 ? '' : 's'}` });
    }
  }

  if (listGroups.length || remoteList.length) {
    rows.push({ title: 'Favourite', items: [...listGroups, ...remoteList], seeAll: 'favourite' });
  }

  rows.push({ title: 'In Your Library', items: groups, seeAll: 'local' });

  for (const row of rows) {
    els.rows.append(buildRow(row));
  }
}

function topTen(items) {
  return [...items]
    .map((item) => ({ item, score: hash(item.id) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map((x) => x.item);
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

function buildRow({ title, items, progressMap, episodeMap, type, sub, seeAll }) {
  const row = createEl('div', `row${type === 'top10' ? ' top10' : ''}`);
  const head = createEl('div', 'row-head');
  const h2 = createEl('h2', 'row-title', title);
  if (sub) h2.append(createEl('span', 'row-sub', sub));
  head.append(h2);
  if (seeAll) {
    const link = createEl('button', 'row-see-all', 'Explore all');
    link.addEventListener('click', () => {
      if (seeAll === 'favourite') showFavourite();
      else showLocal();
    });
    head.append(link);
  }
  row.append(head);

  const wrap = createEl('div', 'row-wrap');
  const track = createEl('div', 'row-track');
  track.dataset.track = title;

  items.forEach((item, index) => {
    if (type === 'top10') {
      track.append(buildTop10Card(item, index + 1, progressMap?.get(item.id)));
    } else {
      track.append(buildCard(item, { progress: progressMap?.get(item.id), episode: episodeMap?.get(item.id) }));
    }
  });

  const left = arrowButton('left');
  const right = arrowButton('right');
  left.hidden = true;
  const step = () => Math.max(300, track.clientWidth * 0.86);
  left.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
  right.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
  const sync = () => {
    left.hidden = track.scrollLeft <= 4;
    right.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  };
  track.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(track);
  requestAnimationFrame(sync);

  wrap.append(left, track, right);
  row.append(wrap);
  return row;
}

function arrowButton(dir) {
  const btn = createEl('button', `row-arrow ${dir}`);
  btn.setAttribute('aria-label', dir === 'left' ? 'Scroll left' : 'Scroll right');
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4"><path d="${dir === 'left' ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'}"/></svg>`;
  return btn;
}

function buildCard(item, { progress, width = 480, episode = '' } = {}) {
  const card = createEl('div', 'card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', item.title);
  const remote = Boolean(item.remote && item.castleId);
  const open = () => (remote ? openCastleModal(item) : openModal(item.id));

  const fallback = createEl('div', 'card-fallback');
  fallback.append(createEl('span', '', item.title));

  const img = document.createElement('img');
  img.className = 'card-img';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.fetchPriority = 'low';
  img.alt = '';
  // Catalog snapshots carry absolute CDN URLs. Offline mode must not touch the
  // network, not even for a picture, so the title fallback stays instead.
  if (!remote || !state.offline) img.src = remote ? (item.background || item.poster || '') : thumbUrl(item, width);
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());

  const overlay = createEl('div', 'card-overlay');
  // The title's official wordmark, when the catalog has one. The text title
  // stays in the DOM and takes over again if the image 404s or fails to load.
  if (!remote) {
    const logo = document.createElement('img');
    logo.className = 'card-logo';
    logo.loading = 'lazy';
    logo.decoding = 'async';
    logo.alt = '';
    logo.addEventListener('load', () => {
      overlay.classList.add('has-logo');
      logo.classList.add('loaded');
    });
    logo.addEventListener('error', () => logo.remove());
    logo.src = logoUrl(item);
    overlay.append(logo);
  }
  overlay.append(createEl('div', 'card-title', item.title));
  const meta = createEl('div', 'card-meta');
  const runtime = remote
    ? (item.type === 'series'
      ? `${Number(item.seasonCount) || 1} season${Number(item.seasonCount) === 1 ? '' : 's'}`
      : 'Movie')
    : item.episodes
      ? `${item.episodes.length} episode${item.episodes.length === 1 ? '' : 's'}`
      : formatDuration(item.durationSec);
  const bits = episode
    ? [episode, qualityLabel(item)].filter(Boolean)
    : [item.year, runtime, remote ? '' : qualityLabel(item)].filter(Boolean);
  meta.textContent = bits.join(' • ');
  if (episode) meta.classList.add('card-episode-meta');
  overlay.append(meta);

  const play = createEl('button', 'card-play');
  play.setAttribute('aria-label', remote ? `Open ${item.title}` : `Play ${item.title}`);
  play.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>';
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    if (remote) open();
    else goWatch(item.playId || item.id);
  });

  card.append(fallback, img, overlay, play);
  if (Number.isFinite(progress) && progress > 0.01) {
    card.classList.add('has-progress');
    const bar = createEl('div', 'card-progress');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
    bar.append(fill);
    card.append(bar);
  }

  applyAmbient(card, img, item);

  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return card;
}

function buildTop10Card(item, rank, progress) {
  const card = createEl('div', 'top10-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${rank}. ${item.title}`);
  const number = createEl('div', 'top10-rank', String(rank));
  const art = createEl('div', 'top10-art');
  const fallback = createEl('div', 'card-fallback');
  fallback.append(createEl('span', '', item.title));
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.fetchPriority = 'low';
  img.alt = '';
  img.src = thumbUrl(item, 480);
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());
  const title = createEl('div', 'card-title', item.title);
  art.append(fallback, img, title);
  if (Number.isFinite(progress)) {
    const bar = createEl('div', 'card-progress');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
    bar.append(fill);
    art.append(bar);
  }
  card.append(number, art);
  applyAmbient(card, img, item);
  card.addEventListener('click', () => openModal(item.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(item.id);
    }
  });
  return card;
}

/* ---------- views ---------- */

function setView(view) {
  const changed = state.view !== view;
  state.view = view;
  const isHome = view === 'home';
  const isOnline = view === 'online';
  els.homeView.hidden = !isHome;
  els.gridView.hidden = isHome || isOnline;
  els.onlineView.hidden = !isOnline;
  if (isHome) {
    stopPreview();
    if (changed || !els.rows.childElementCount) {
      state.heroId = null;
      renderHero();
      renderRows();
    }
  }
  if (isOnline) stopPreview();
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === view);
  });
  setMobileActive(['home', 'local', 'favourite', 'online'].includes(view) ? view : null);
  window.scrollTo(0, 0);
  if (changed && els.main && !prefersReducedMotion()) {
    els.main.classList.remove('view-in');
    els.main.classList.add('view-fade');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        els.main.classList.remove('view-fade');
        els.main.classList.add('view-in');
      });
    });
    setTimeout(() => els.main.classList.remove('view-in'), 400);
  }
}

function setMobileActive(name) {
  document.querySelectorAll('.mobile-nav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mview === name);
  });
}

function showHome() {
  setView('home');
}

/* Library not read yet: card-shaped placeholders instead of an empty page. */
function gridLoading(title) {
  els.gridTitle.textContent = title;
  els.gridSub.replaceChildren(skel('grid-sub-sk'));
  els.grid.replaceChildren(...skelCards(12));
  els.gridEmpty.hidden = true;
}

function showLocal() {
  setView('local');
  if (!state.library) return gridLoading('Local');
  const groups = groupLibrary();
  els.gridTitle.textContent = 'Local';
  els.gridSub.textContent = `${groups.length} title${groups.length === 1 ? '' : 's'} in ${state.library?.root || 'your library'}`;
  fillGrid(els.grid, groups, els.gridEmpty, 'Nothing in your library yet.');
}

function remoteListCards() {
  return getRemoteList().map((entry) => ({
    ...entry,
    id: entry.castleId || String(entry.key).replace(/^castle:/, ''),
    remote: true,
  }));
}

function showFavourite() {
  setView('favourite');
  if (!state.library) return gridLoading('Favourite');
  const groups = groupLibrary();
  const items = [...groupItems(groups, getMyList()), ...remoteListCards()];
  els.gridTitle.textContent = 'Favourite';
  els.gridSub.textContent = `${items.length} saved title${items.length === 1 ? '' : 's'}`;
  fillGrid(els.grid, items, els.gridEmpty, 'Add titles with the + button on any detail page.');
}

/* ---------- online: random castle catalog ---------- */

function renderOnlineFilters() {
  for (const button of els.onlineModes.querySelectorAll('[data-online-mode]')) {
    const active = button.dataset.onlineMode === state.onlineMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = state.offline;
  }
  for (const button of els.onlineGenres.querySelectorAll('[data-online-genre]')) {
    const active = button.dataset.onlineGenre === state.onlineGenre;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = state.offline;
  }
  els.onlineShuffle.disabled = state.offline;
}

function showOnline() {
  setView('online');
  renderOnlineFilters();
  if (state.offline) {
    showSavedCatalogue();
    return;
  }
  if (!state.onlineBrowse.length && !state.onlineBrowseLoading) loadOnlineBrowse();
  else if (state.onlineBrowse.every((item) => item.saved)) loadOnlineBrowse();
}

/* Offline mode still shows the catalogue: every title opened at least once is
 * in catalog.db with its seasons, episodes and saved pictures. Only the
 * Download buttons change, because the transfer needs internet. */
let savedCatalogueToken = 0;
async function showSavedCatalogue() {
  const token = ++savedCatalogueToken;
  els.onlineEmpty.hidden = true;
  els.onlineLoading.hidden = true;
  try {
    const data = await getSavedCastle();
    if (token !== savedCatalogueToken) return;
    const results = Array.isArray(data.results) ? data.results : [];
    state.onlineBrowse = results;
    state.savedTitles = results;
    renderOnlineGrid();
    els.onlineEmpty.hidden = results.length > 0;
    if (!results.length) {
      const heading = els.onlineEmpty.querySelector('h2');
      const body = els.onlineEmpty.querySelector('p');
      if (heading) heading.textContent = 'No saved titles yet';
      if (body) body.textContent = 'Go online and open a title once — its seasons, episodes and artwork are then kept for offline.';
    }
    showOnlineNote(results.length
      ? `Offline mode — ${results.length} saved title${results.length === 1 ? '' : 's'} from your catalogue. Downloads stay disabled until you go online.`
      : 'Offline mode is on — no saved catalogue yet. Go online once to fill it.');
  } catch (err) {
    if (token !== savedCatalogueToken) return;
    state.onlineBrowse = [];
    els.onlineGrid.replaceChildren();
    els.onlineEmpty.hidden = false;
    const heading = els.onlineEmpty.querySelector('h2');
    const body = els.onlineEmpty.querySelector('p');
    if (heading) heading.textContent = 'Could not read the catalogue';
    if (body) body.textContent = err.message;
    showOnlineNote(`Could not read the saved catalogue (${err.message}).`);
  }
}

function showOnlineNote(message) {
  if (!message) {
    els.onlineNote.hidden = true;
    els.onlineNote.textContent = '';
    return;
  }
  els.onlineNote.textContent = message;
  els.onlineNote.hidden = false;
}

function setOnlineBusy(busy) {
  state.onlineBrowseLoading = busy;
  els.onlineLoading.hidden = !busy;
  els.onlineGrid.setAttribute('aria-busy', String(busy));
  if (busy && !state.onlineBrowse.length) els.onlineGrid.replaceChildren();
}

async function loadOnlineBrowse({ fresh = false } = {}) {
  const token = ++state.onlineBrowseToken;
  state.onlineBrowseAbort?.abort();
  const controller = new AbortController();
  state.onlineBrowseAbort = controller;
  setOnlineBusy(true);
  els.onlineEmpty.hidden = true;
  showOnlineNote('');
  try {
    const data = await browseCastle({
      fresh,
      mode: state.onlineMode,
      genre: state.onlineGenre,
      signal: controller.signal,
    });
    if (token !== state.onlineBrowseToken) return;
    const results = Array.isArray(data.results) ? data.results : [];
    state.onlineBrowse = results;
    renderOnlineGrid();
    if (!results.length) {
      els.onlineEmpty.hidden = false;
      showOnlineNote('The catalog returned nothing — press Shuffle to try again.');
    }
  } catch (err) {
    if (err.name === 'AbortError' || token !== state.onlineBrowseToken) return;
    state.onlineBrowse = [];
    els.onlineGrid.replaceChildren();
    els.onlineEmpty.hidden = false;
    showOnlineNote(`Could not load the catalog (${err.message}). Check your connection and press Shuffle.`);
  } finally {
    if (token === state.onlineBrowseToken) {
      state.onlineBrowseAbort = null;
      setOnlineBusy(false);
    }
  }
}

function renderOnlineGrid() {
  els.onlineGrid.replaceChildren(
    ...state.onlineBrowse.map((item) => buildOnlineCard(item, { castle: true })),
  );
}

const STATUS_LABELS = {
  queued: 'Queued',
  downloading: 'Downloading',
  cancelling: 'Cancelling…',
  cancelled: 'Cancelled',
  paused: 'Paused',
  failed: 'Failed',
  completed: 'Completed',
};

/* Queued jobs report progress in stages before the byte count has any meaning. */
const STAGE_LABELS = {
  searching: 'Picking release…',
  metadata: 'Fetching torrent…',
  verifying: 'Checking tracks…',
  installing: 'Installing…',
  remuxing: 'Remuxing to MP4…',
  subtitles: 'Extracting subtitles…',
};

/* ---------- download manager ---------- */

function scheduleDownloadPoll() {
  clearInterval(state.downloadPoll);
  state.downloadPoll = setInterval(() => {
    if (document.hidden) return;
    const active = state.downloads.some((job) => ACTIVE_STATUSES.has(job.status));
    if (!active && els.downloadsPanel.hidden) return;
    refreshDownloads();
  }, 2200);
}

async function refreshDownloads({ initial = false } = {}) {
  try {
    const data = await getDownloads();
    const previous = new Map(state.downloads.map((job) => [job.id, job.status]));
    const jobs = data.jobs || [];
    state.downloads = jobs;
    state.downloadsLoaded = true;
    if (data.root) els.downloadsRoot.textContent = `Saving to ${data.root}`;
    renderDownloads();
    updateDownloadsBadge();
    syncCastleSheet();

    if (!state.downloadsSynced) {
      state.downloadsSynced = true;
      return;
    }
    if (initial) return;

    const completed = jobs.filter((job) => job.status === 'completed' && previous.get(job.id) !== 'completed');
    const failed = jobs.filter((job) => job.status === 'failed' && previous.get(job.id) !== 'failed');
    if (completed.length) {
      toast(completed.length === 1
        ? `Download complete — ${completed[0].title}`
        : `${completed.length} downloads complete`);
      await loadLibrary();
      completed.forEach((job) => notify('done', job.title || job.fileName, 'Download complete — ready to watch', {
        fileName: job.fileName,
        seriesTitle: job.seriesTitle,
      }));
    }
    if (failed.length) {
      toast(`Download failed — ${failed[0].title}`);
      failed.forEach((job) => notify('fail', job.title || job.fileName, job.error || 'Download failed', {
        fileName: job.fileName,
        seriesTitle: job.seriesTitle,
      }));
    }
  } catch {
    /* keep the last known list when the server is unreachable */
    if (!state.downloadsLoaded) {
      state.downloadsLoaded = true; // stop the skeleton; the poll keeps retrying
      renderDownloads();
      updateDownloadsBadge();
    }
  }
}

function updateDownloadsBadge() {
  const active = state.downloads.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
  const paused = state.downloads.filter((job) => job.status === 'paused').length;
  els.downloadsBadge.hidden = active === 0;
  els.downloadsBadge.textContent = active > 9 ? '9+' : String(active);
  els.downloadsBtn.classList.toggle('busy', active > 0);
  if (active) {
    els.downloadsCount.textContent = `${active} active download${active === 1 ? '' : 's'}`
      + (paused ? ` · ${paused} paused` : '');
  } else if (paused) {
    els.downloadsCount.textContent = `${paused} paused download${paused === 1 ? '' : 's'}`;
  } else {
    els.downloadsCount.textContent = 'No active downloads';
  }
}

function formatSpeed(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

const dlRows = new Map();
const dlDrag = { active: false };
const QUEUE_ORDER_KEY = 'netflix-home:queue-order';

function formatEta(job) {
  if (!job.speed || !job.total || job.total <= job.bytes) return '';
  const sec = Math.round((job.total - job.bytes) / job.speed);
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m left`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s left`;
  return `${sec}s left`;
}

function orderedQueue(jobs) {
  const saved = readJson(QUEUE_ORDER_KEY, []);
  const rank = new Map((Array.isArray(saved) ? saved : []).map((id, i) => [id, i]));
  return jobs
    .map((job, i) => ({ job, i }))
    .sort((x, y) => (rank.has(x.job.id) ? rank.get(x.job.id) : 1e6 + x.i) - (rank.has(y.job.id) ? rank.get(y.job.id) : 1e6 + y.i))
    .map((x) => x.job);
}

/* ---------- downloads: one group per show ---------- */

const dlHeads = new Map();

/* "Cyberpunk: Edgerunners S01E10" -> "Cyberpunk: Edgerunners" */
function downloadShow(job) {
  const raw = String(job.title || job.fileName || 'Download').trim();
  const show = raw
    .replace(/\s*[-_.]?\s*[Ss]\d{1,2}\s*[Ee]\d{1,3}\b.*$/, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s+\d{3,4}p\b.*$/i, '')
    .trim();
  return show || raw;
}

function downloadShowKey(job) {
  return `${downloadShow(job).toLowerCase()}|${job.identifier || ''}`;
}

function downloadEpisodeLabel(job) {
  const season = Number(job.season) || 0;
  const episode = Number(job.episode) || 0;
  if (season && episode) return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  if (episode) return `E${String(episode).padStart(2, '0')}`;
  return '';
}

/* A finished episode is in the library already, so its poster and wordmark are
 * cached on disk and load instantly; an in-flight job only has the remote
 * poster it was started with. A show already in the library lends its wordmark
 * to the episodes still downloading. */
function normalizeShowName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* The saved catalogue keeps a poster for every title opened once, which is the
 * only artwork left when a download's files were deleted and the library row
 * is gone. That is what a finished show with no picture falls back to. */
function savedShowPoster(show) {
  const saved = Array.isArray(state.savedTitles) ? state.savedTitles : [];
  const wanted = normalizeShowName(show);
  if (!wanted) return '';
  const hit = saved.find((row) => row?.poster && normalizeShowName(row.title) === wanted);
  return hit ? String(hit.poster) : '';
}

function downloadArt(job) {
  const items = state.library?.items || [];
  const file = String(job.fileName || '');
  const show = normalizeShowName(downloadShow(job));
  const exact = file ? items.find((row) => row.fileName === file) : null;
  const sameShow = show
    ? items.find((row) => normalizeShowName(row.title) === show)
    : null;
  const item = exact || sameShow;

  /* Candidates in the order they are most likely to exist: the library row that
   * was just scanned, the saved catalogue, then whatever the job was started
   * with. A 404 on the first one moves to the next instead of leaving the group
   * with no picture at all. */
  const sources = [];
  if (item) sources.push(`/api/art/${encodeURIComponent(item.id)}/poster?w=240`);
  const saved = savedShowPoster(downloadShow(job));
  if (saved && !sources.includes(saved)) sources.push(saved);
  const fromJob = String(job.poster || '');
  if (fromJob && !sources.includes(fromJob)) sources.push(fromJob);

  return { sources, logo: item ? logoUrl(item) : '' };
}

function buildDownloadHead(job, artwork = downloadArt(job)) {
  const head = createEl('div', 'dl-group');
  const show = downloadShow(job);
  const { sources, logo } = artwork;
  head._art = `${sources.join('|')}|${logo}`;

  const art = createEl('div', 'dl-group-art');
  art.append(createEl('span', 'dl-group-initial', show.slice(0, 2).toUpperCase()));
  if (sources.length) {
    const img = document.createElement('img');
    img.className = 'dl-group-poster';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('loaded'));
    // Next candidate on error; the last one removes the picture and the
    // group keeps its initials.
    img.addEventListener('error', () => {
      sources.shift();
      if (!sources.length) {
        img.remove();
        return;
      }
      img.src = sources[0];
    });
    img.src = sources[0];
    art.append(img);
  }

  const copy = createEl('div', 'dl-group-copy');
  const name = createEl('span', 'dl-group-title', show);
  copy.append(name);
  if (logo) {
    const mark = document.createElement('img');
    mark.className = 'dl-group-logo';
    mark.alt = show;
    mark.loading = 'lazy';
    mark.decoding = 'async';
    mark.addEventListener('load', () => {
      mark.classList.add('loaded');
      name.hidden = true;
    });
    mark.addEventListener('error', () => mark.remove());
    mark.src = logo;
    copy.append(mark);
  }
  const meta = createEl('p', 'dl-group-meta');
  copy.append(meta);
  head.append(art, copy);
  head._meta = meta;
  return head;
}

function updateDownloadHead(head, jobs) {
  const season = Number(jobs[0]?.season) || 0;
  const qualities = [...new Set(jobs.map((job) => job.quality).filter(Boolean))];
  const bytes = jobs.reduce((sum, job) => sum
    + (Number(job.status === 'completed' ? job.bytes : job.total) || 0), 0);
  const parts = [];
  if (season) parts.push(`Season ${season}`);
  if (qualities.length === 1) parts.push(qualities[0]);
  if (season) parts.push(`${jobs.length} episode${jobs.length === 1 ? '' : 's'}`);
  if (bytes) parts.push(formatSize(bytes));
  head._meta.textContent = parts.join(' · ');
}

/* The group head already names the show, so a row only repeats what it adds. */
function downloadRowTitle(job) {
  const raw = String(job.title || '').trim();
  const label = downloadEpisodeLabel(job);
  if (!label || !raw) return raw;
  const show = downloadShow(job);
  let rest = raw.toLowerCase().startsWith(show.toLowerCase()) ? raw.slice(show.length) : raw;
  rest = rest
    .replace(new RegExp(label, 'i'), '')
    .replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '')
    .trim();
  return rest;
}

const LIVE = new Set(['queued', 'downloading', 'paused', 'cancelling']);
const DL_RANK = { downloading: 0, cancelling: 0, paused: 1, queued: 2, failed: 3, completed: 4 };
const DISMISS_KEY = 'netflix-home:dl-dismissed';
const dlDismissed = new Set(readJson(DISMISS_KEY, []));
const dlCards = new Map();
const dlOpen = new Map();
const X_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const CHEV_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function dismissJobs(ids) {
  ids.forEach((id) => dlDismissed.add(id));
  writeJson(DISMISS_KEY, [...dlDismissed].slice(-300));
}
function dismissRow(id) { dismissJobs([id]); renderDownloads(); }

/* X on a finished download only drops the row: the server forgets the record,
 * the file and its library entry stay. Unfinished rows use the cancel path,
 * which also deletes whatever bytes were fetched. */
async function removeFinishedJob(job, button) {
  if (button) button.disabled = true;
  try {
    await cancelDownload(job.id);
  } catch (err) {
    // A restarted server no longer knows the record. It is still only a
    // notification here, so drop the row instead of failing forever.
    if (!/\b404\b/.test(err.message)) {
      if (button) button.disabled = false;
      toast(`Could not remove the download: ${err.message}`, { type: 'warn' });
      return false;
    }
  }
  dismissRow(job.id);
  return true;
}

function dlGroupState(jobs) {
  if (jobs.some((j) => j.status === 'downloading' || j.status === 'cancelling')) return 'downloading';
  if (jobs.some((j) => j.status === 'queued')) return 'queued';
  if (jobs.some((j) => j.status === 'paused')) return 'paused';
  if (jobs.some((j) => j.status === 'failed')) return 'failed';
  return 'completed';
}

function buildDlCard(key) {
  const el = createEl('article', 'dl-card');
  const top = createEl('div', 'dl-card-top');
  const acts = createEl('div', 'dl-card-actions');
  const toggle = createEl('button', 'dl-icon dl-chev');
  toggle.type = 'button';
  toggle.innerHTML = CHEV_SVG;
  const x = createEl('button', 'dl-icon dl-x');
  x.type = 'button';
  x.innerHTML = `${X_SVG}<span>Cancel all</span>`;
  acts.append(toggle, x);
  top.append(acts);
  const prog = createEl('div', 'dl-card-prog');
  const bar = createEl('div', 'download-bar');
  const fill = document.createElement('i');
  bar.append(fill);
  const line = createEl('p', 'dl-card-line');
  prog.append(bar, line);
  const wrap = createEl('div', 'dl-collapse');
  const rows = createEl('div', 'dl-rows');
  wrap.append(rows);
  el.append(top, prog, wrap);
  const card = { key, el, top, toggle, x, prog, bar, fill, line, wrap, rows, head: null, jobs: [], armed: 0 };
  toggle.addEventListener('click', () => { dlOpen.set(key, el.classList.contains('is-collapsed')); applyDlOpen(card); });
  x.addEventListener('click', () => removeDlGroup(card));
  return card;
}

function applyDlOpen(card) {
  const multi = card.jobs.length > 1;
  const open = !multi || (dlOpen.has(card.key) ? dlOpen.get(card.key) : card.jobs.some((j) => j.status !== 'completed'));
  card.el.classList.toggle('is-collapsed', !open);
  card.wrap.inert = !open;
  card.toggle.hidden = !multi;
  card.toggle.setAttribute('aria-expanded', String(open));
  card.toggle.setAttribute('aria-label', open ? 'Hide episodes' : 'Show episodes');
}

async function removeDlGroup(card) {
  const unfinished = card.jobs.filter((j) => j.status !== 'completed' && j.status !== 'cancelled');
  if (unfinished.length && !card.armed) {
    card.el.classList.add('is-armed');
    card.armed = setTimeout(() => { card.armed = 0; card.el.classList.remove('is-armed'); }, 3200);
    return;
  }
  clearTimeout(card.armed);
  card.armed = 0;
  card.el.classList.remove('is-armed');
  card.el.classList.add('is-busy');
  // Unfinished jobs cancel and drop their partial files; completed ones only
  // lose the record. The file in the library is never touched.
  const results = await Promise.allSettled(card.jobs.map((j) => cancelDownload(j.id)));
  dismissJobs(card.jobs.filter((_, i) => results[i].status === 'fulfilled').map((j) => j.id));
  card.el.classList.remove('is-busy');
  if (results.some((result) => result.status === 'rejected')) {
    toast('Could not remove every download. Try again.');
  }
  refreshDownloads();
}

function updateDlCard(card, g, qpos) {
  const list = g.list;
  const n = list.length;
  card.jobs = list;
  card.el.dataset.state = g.state;
  card.el.toggleAttribute('data-single', n === 1);
  const art = downloadArt(list[0]);
  if (!card.head || card.head._art !== `${art.sources.join('|')}|${art.logo}`) {
    const head = buildDownloadHead(list[0], art);
    if (card.head) card.head.replaceWith(head); else card.top.prepend(head);
    card.head = head;
  }
  updateDownloadHead(card.head, list);

  let sum = 0, speed = 0, bytes = 0, total = 0;
  list.forEach((j) => {
    sum += j.status === 'completed' ? 1 : (j.progress || 0);
    if (j.status === 'downloading') speed += Number(j.speed) || 0;
    total += Number(j.total) || 0;
    bytes += Number(j.bytes) || 0;
  });
  const pct = Math.round((sum / n) * 100);
  const done = list.filter((j) => j.status === 'completed').length;
  const failed = list.filter((j) => j.status === 'failed').length;
  const label = { downloading: 'Downloading', queued: 'Waiting in queue', paused: 'Paused', failed: `${failed} failed`, completed: 'Finished' }[g.state];
  const eta = formatEta({ speed, total, bytes });
  const parts = [label];
  if (n > 1 && g.state !== 'completed') parts.push(`${done} of ${n} done`);
  if (speed) parts.push(formatSpeed(speed));
  if (eta) parts.push(eta);
  card.line.replaceChildren(...parts.map((t) => createEl('span', '', t)), createEl('b', 'dl-card-pct', `${pct}%`));
  card.prog.hidden = !list.some((j) => LIVE.has(j.status));
  card.fill.style.width = `${pct}%`;
  card.bar.classList.toggle('is-paused', g.state === 'paused');
  const pending = list.some((j) => j.status !== 'completed' && j.status !== 'cancelled');
  card.x.querySelector('span').textContent = pending ? 'Cancel all' : 'Remove';
  card.x.setAttribute('aria-label', pending
    ? 'Cancel unfinished downloads and delete their partial data for this title'
    : 'Remove from list (downloaded files stay)');
  card.x.title = pending
    ? 'Cancel unfinished downloads and delete partial data'
    : 'Remove from list — the file stays in the library';

  if (!dlDrag.active) {
    const sorted = [...list].sort((x, y) => (DL_RANK[x.status] - DL_RANK[y.status])
      || (x.status === 'queued' ? qpos.get(x.id) - qpos.get(y.id)
        : (Number(x.season) || 0) - (Number(y.season) || 0) || (Number(x.episode) || 0) - (Number(y.episode) || 0)));
    sorted.forEach((j, i) => {
      const el = dlRows.get(j.id);
      if (card.rows.children[i] !== el) card.rows.insertBefore(el, card.rows.children[i] || null);
    });
    while (card.rows.children.length > sorted.length) card.rows.lastElementChild.remove();
  }
  applyDlOpen(card);
}

function renderDownloads() {
  const jobs = state.downloads.filter((j) => j.status !== 'cancelled' && !dlDismissed.has(j.id));
  const queue = orderedQueue(jobs.filter((j) => j.status === 'queued'));
  const qpos = new Map(queue.map((j, i) => [j.id, i]));
  const ids = new Set(jobs.map((j) => j.id));

  dlRows.forEach((row, id) => { if (!ids.has(id)) { row.remove(); dlRows.delete(id); } });
  jobs.forEach((job) => {
    let row = dlRows.get(job.id);
    if (!row) { row = buildDownloadRow(job); dlRows.set(job.id, row); }
    updateDownloadRow(row, job);
    if (qpos.has(job.id)) row.querySelector('.dl-pos').textContent = String(qpos.get(job.id) + 1);
  });

  const groups = new Map();
  jobs.forEach((job) => {
    const k = downloadShowKey(job);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(job);
  });
  const order = [...groups].map(([key, list], i) => ({ key, list, i, state: dlGroupState(list) }))
    .sort((p, q) => DL_RANK[p.state] - DL_RANK[q.state] || p.i - q.i);
  const desired = order.map((g) => {
    let card = dlCards.get(g.key);
    if (!card) { card = buildDlCard(g.key); dlCards.set(g.key, card); }
    card.el.classList.remove('is-leaving');
    updateDlCard(card, g, qpos);
    return card.el;
  });
  dlCards.forEach((card, key) => {
    if (groups.has(key) || card.el.classList.contains('is-leaving')) return;
    card.el.classList.add('is-leaving');
    setTimeout(() => {
      if (card.el.classList.contains('is-leaving')) { card.el.remove(); dlCards.delete(key); }
    }, 340);
  });
  if (!dlDrag.active) {
    desired.forEach((el, i) => {
      if (els.dlGroups.children[i] !== el) els.dlGroups.insertBefore(el, els.dlGroups.children[i] || null);
    });
  }
  els.dlClear.hidden = !state.downloads.some((j) => j.status === 'completed' && !dlDismissed.has(j.id));
  els.dlSkeleton.hidden = state.downloadsLoaded;
  els.downloadsEmpty.hidden = jobs.length > 0 || !state.downloadsLoaded;
}

function tweenNumber(el, to) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  if (from === to) { el.textContent = `${to}%`; return; }
  const t0 = performance.now();
  const dur = 1800;
  const step = (now) => {
    if (Number(el.dataset.v) !== to) return;
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = `${Math.round(from + (to - from) * p)}%`;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function buildDownloadRow(job) {
  const row = createEl('div', 'download-row');
  row.dataset.id = job.id;

  const grip = createEl('button', 'dl-grip');
  grip.type = 'button';
  grip.setAttribute('aria-label', 'Drag to reorder (or use arrow keys)');
  grip.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';
  grip.addEventListener('pointerdown', (e) => startDrag(e, row));
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const sib = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sib || !sib.classList.contains('is-queued')) return;
    const box = row.parentElement;
    animateReorder(box, () => (e.key === 'ArrowUp' ? box.insertBefore(row, sib) : box.insertBefore(sib, row)));
    commitQueueOrder(box);
    grip.focus();
  });

  const pos = createEl('span', 'dl-pos', '');
  const main = createEl('div', 'download-main');
  const top = createEl('div', 'download-top');
  const ep = createEl('span', 'download-ep', '');
  const title = createEl('span', 'download-title');
  const pct = createEl('span', 'download-pct');
  top.append(ep, title, pct);
  const file = createEl('div', 'download-file');
  const bar = createEl('div', 'download-bar');
  const fillEl = document.createElement('i');
  bar.append(fillEl);
  const meta = createEl('div', 'download-meta');
  main.append(top, file, bar, meta);
  const actions = createEl('div', 'download-actions');
  row.append(grip, pos, main, actions);
  row._r = { ep, title, pct, file, bar, fillEl, meta, actions };
  return row;
}

function updateDownloadRow(row, job) {
  const r = row._r;
  row.className = `download-row is-${job.status}${row.classList.contains('dragging') ? ' dragging' : ''}`;
  const label = downloadEpisodeLabel(job);
  r.ep.textContent = label;
  r.ep.hidden = !label;
  const title = downloadRowTitle(job);
  r.title.textContent = title;
  r.title.hidden = !title;
  r.file.textContent = job.fileName || '';
  const pct = job.status === 'completed' ? 100 : Math.round((job.progress || 0) * 100);
  const showPct = job.status !== 'queued' && job.status !== 'failed';
  r.pct.hidden = !showPct;
  if (showPct) tweenNumber(r.pct, pct);
  r.fillEl.style.width = `${pct}%`;
  r.bar.classList.toggle('indeterminate', job.status === 'cancelling');
  /* A failed transfer has no progress to show; the bar just reads as broken. */
  r.bar.hidden = job.status === 'failed' || job.status === 'cancelled';

  r.meta.replaceChildren();
  r.meta.append(createEl('span', `download-status ${job.status}`, STATUS_LABELS[job.status] || job.status));
  if (job.sourceLabel) r.meta.append(createEl('span', 'download-source', job.sourceLabel));
  if (job.stage && job.stage !== 'downloading' && job.status !== 'completed' && STAGE_LABELS[job.stage]) {
    r.meta.append(createEl('span', 'download-stage', STAGE_LABELS[job.stage]));
  }
  if (job.total && job.status !== 'queued') {
    r.meta.append(createEl('span', '', job.bytes
      ? `${formatSize(job.bytes)} of ${formatSize(job.total)}`
      : formatSize(job.total)));
  } else if (job.status === 'completed') r.meta.append(createEl('span', '', formatSize(job.bytes)));
  if (job.status === 'downloading') {
    if (job.speed) r.meta.append(createEl('span', '', formatSpeed(job.speed)));
    const eta = formatEta(job);
    if (eta) r.meta.append(createEl('span', 'download-eta', eta));
  }
  if (job.error) r.meta.append(createEl('span', 'download-error', job.error));

  r.actions.replaceChildren();
  const live = job.status === 'queued' || job.status === 'downloading' || job.status === 'paused';
  const mk = (cls, text, fn) => {
    const b = createEl('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  if (job.status === 'queued' || job.status === 'downloading') {
    r.actions.append(mk('download-action', 'Pause', (e) => downloadAction(job.id, 'pause', e.currentTarget)));
  }
  if (job.status === 'paused') {
    r.actions.append(mk('download-action primary', 'Resume', (e) => downloadAction(job.id, 'resume', e.currentTarget)));
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    r.actions.append(mk('download-action primary', 'Retry', (e) => downloadAction(job.id, 'retry', e.currentTarget)));
  } else if (job.status === 'completed') {
    r.actions.append(createEl('span', 'download-done', '✓'));
  }
  const finished = job.status === 'completed';
  const x = mk('download-x', '', (e) => (finished
    ? removeFinishedJob(job, e.currentTarget)
    : downloadAction(job.id, 'cancel', e.currentTarget)));
  x.innerHTML = X_SVG;
  x.title = finished
    ? 'Remove from list — the file stays in the library'
    : live ? 'Cancel and delete partial data' : 'Delete unfinished download';
  x.setAttribute('aria-label', x.title);
  r.actions.append(x);
}

/* FLIP: smoothly slide siblings when the order changes */
function animateReorder(box, mutate, skip) {
  const rows = [...box.children];
  const before = new Map(rows.map((el) => [el, el.getBoundingClientRect().top]));
  mutate();
  rows.forEach((el) => {
    if (el === skip) return;
    const dy = before.get(el) - el.getBoundingClientRect().top;
    if (!dy) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform .22s var(--ease)';
      el.style.transform = '';
    });
  });
}

function commitQueueOrder(box) {
  const mine = [...box.querySelectorAll('.download-row.is-queued')].map((el) => el.dataset.id);
  const set = new Set(mine);
  const queued = orderedQueue(state.downloads.filter((j) => j.status === 'queued')).map((j) => j.id);
  let k = 0;
  const ids = queued.map((id) => (set.has(id) ? mine[k++] : id));
  ids.forEach((id, i) => { dlRows.get(id)?.querySelector('.dl-pos')?.replaceChildren(String(i + 1)); });
  writeJson(QUEUE_ORDER_KEY, ids);
  reorderDownloads(ids);
}

function startDrag(e, row) {
  if (e.button !== undefined && e.button !== 0) return;
  const box = row.parentElement;
  if (!box || box.querySelectorAll('.download-row.is-queued').length < 2) return;
  e.preventDefault();
  dlDrag.active = true;
  document.body.classList.add('dl-dragging');
  row.classList.add('dragging');
  const grabOffset = e.clientY - row.getBoundingClientRect().top;
  const scroller = els.downloadsList;
  let lastY = e.clientY;
  let raf = 0;
  // Group heads sit between rows, so compare against the row that was last
  // chosen instead of `nextElementSibling`.
  let placed = row.nextElementSibling;

  const place = () => {
    row.style.transform = 'none';
    const natural = row.getBoundingClientRect().top;
    row.style.transform = `translateY(${lastY - grabOffset - natural}px)`;
  };
  const move = (ev) => {
    lastY = ev.clientY;
    place();
    const center = lastY - grabOffset + row.offsetHeight / 2;
    const sibs = [...box.querySelectorAll('.download-row.is-queued')].filter((el) => el !== row);
    let target = null;
    for (const el of sibs) {
      const rc = el.getBoundingClientRect();
      if (center < rc.top + rc.height / 2) { target = el; break; }
    }
    const dest = target || (sibs.length ? sibs[sibs.length - 1].nextElementSibling : null);
    if (dest !== placed) {
      animateReorder(box, () => box.insertBefore(row, dest), row);
      place();
      placed = dest;
    }
    const sr = scroller.getBoundingClientRect();
    cancelAnimationFrame(raf);
    if (lastY < sr.top + 40) raf = requestAnimationFrame(function s() { scroller.scrollTop -= 8; place(); raf = requestAnimationFrame(s); });
    else if (lastY > sr.bottom - 40) raf = requestAnimationFrame(function s() { scroller.scrollTop += 8; place(); raf = requestAnimationFrame(s); });
  };
  const end = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    row.style.transition = 'transform .2s var(--ease)';
    row.style.transform = 'translateY(0)';
    setTimeout(() => {
      row.style.transition = '';
      row.style.transform = '';
      row.classList.remove('dragging');
      document.body.classList.remove('dl-dragging');
      dlDrag.active = false;
      commitQueueOrder(box);
    }, 200);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

async function downloadAction(id, action, button) {
  button.disabled = true;
  try {
    if (action === 'cancel') await cancelDownload(id);
    else if (action === 'pause') await pauseDownload(id);
    else if (action === 'resume') await resumeDownload(id);
    else await retryDownload(id);
    await refreshDownloads();
  } catch {
    toast('Could not update the download. Try again.');
    button.disabled = false;
  }
}

let dlCloseTimer = 0;

function openDownloads() {
  const panel = els.downloadsPanel;
  clearTimeout(dlCloseTimer);
  const wasHidden = panel.hidden;
  panel.hidden = false;
  syncBodyLock();
  if (wasHidden) void panel.offsetWidth; // commit the closed state so the slide-in animates
  panel.classList.add('is-open');
  refreshDownloads();
  setTimeout(() => panel.querySelector('.downloads-close')?.focus({ preventScroll: true }), 60);
}

function closeDownloads() {
  const panel = els.downloadsPanel;
  if (panel.hidden) return;
  panel.classList.remove('is-open');
  clearTimeout(dlCloseTimer);
  dlCloseTimer = setTimeout(() => { panel.hidden = true; syncBodyLock(); }, 340);
  els.downloadsBtn.focus({ preventScroll: true });
}

function syncBodyLock() {
  const open = !els.searchOverlay.hidden
    || isModalOpen()
    || !els.onlineModal.hidden
    || !els.castleModal.hidden
    || !els.settingsModal.hidden
    || !els.downloadsPanel.hidden;
  document.body.classList.toggle('modal-open', open);
}

function renderGridForCurrentView() {
  if (state.view === 'local') showLocal();
  else if (state.view === 'favourite') showFavourite();
  else if (state.view === 'collection') {
    const name = els.gridTitle.textContent;
    const col = state.library.collections.find((c) => c.name === name);
    if (col) {
      const groups = groupLibrary();
      fillGrid(els.grid, groupItems(groups, col.items), els.gridEmpty, '');
    }
  }
}

function fillGrid(container, items, emptyEl, emptyText) {
  container.replaceChildren();
  items.forEach((item) => container.append(buildCard(item, { width: 640 })));
  emptyEl.hidden = items.length > 0;
  if (!items.length && emptyText) emptyEl.querySelector('p').textContent = emptyText;
}

/* ---------- search ---------- */

const ONLINE_MIN_CHARS = 2;

function resetOnlineSearch() {
  state.onlineToken += 1;
  state.onlineAbort?.abort();
  state.onlineAbort = null;
  state.onlineResults = [];
  state.onlineLoading = false;
  state.onlineError = '';
  els.searchOnlineSection.hidden = true;
  els.searchOnlineResults.replaceChildren();
  els.searchOnlineLoading.hidden = true;
  els.searchOnlineEmpty.hidden = true;
  els.searchOnlineError.hidden = true;
  els.searchOnlineCount.textContent = '';
}

function resetCastleSearch() {
  state.castleToken += 1;
  state.castleAbort?.abort();
  state.castleAbort = null;
  state.castleResults = [];
  state.castleLoading = false;
  els.searchCastleSection.hidden = true;
  els.searchCastleResults.replaceChildren();
  els.searchCastleLoading.hidden = true;
  els.searchCastleEmpty.hidden = true;
  els.searchCastleError.hidden = true;
  els.searchCastleCount.textContent = '';
}

function renderSearchHistory() {
  const box = els.searchHistory;
  if (!box) return;
  box.replaceChildren();
  const list = state.searchHistory;
  box.hidden = list.length === 0 || Boolean(els.searchInput.value.trim());
  for (const entry of list) {
    const chip = createEl('div', 'history-chip');
    const pick = createEl('button', 'history-query', entry);
    pick.type = 'button';
    pick.dataset.q = entry;
    const remove = createEl('button', 'history-remove', '✕');
    remove.type = 'button';
    remove.dataset.remove = entry;
    remove.setAttribute('aria-label', `Remove “${entry}” from search history`);
    chip.append(pick, remove);
    box.append(chip);
  }
}

function rememberSearch(raw) {
  const query = String(raw || '').trim();
  if (query.length < 2) return;
  const key = query.toLowerCase();
  state.searchHistory = [query, ...state.searchHistory.filter((entry) => entry.toLowerCase() !== key)]
    .slice(0, SEARCH_HISTORY_LIMIT);
  writeJson(SEARCH_HISTORY_KEY, state.searchHistory);
  renderSearchHistory();
}

function removeSearchHistory(entry) {
  const key = String(entry || '').toLowerCase();
  state.searchHistory = state.searchHistory.filter((item) => item.toLowerCase() !== key);
  writeJson(SEARCH_HISTORY_KEY, state.searchHistory);
  renderSearchHistory();
}

function applyOfflineUi() {
  els.offlineBtn.setAttribute('aria-checked', String(state.offline));
  els.offlineBtn.classList.toggle('is-offline', state.offline);
  els.offlineLabel.textContent = state.offline ? 'Offline' : 'Online';
  const label = state.offline
    ? 'Offline mode is on — the app makes no internet requests'
    : 'Offline mode is off — internet enabled';
  els.offlineBtn.title = label;
  els.offlineBtn.setAttribute('aria-label', label);
  document.body.classList.toggle('is-offline', state.offline);
  renderOnlineFilters();
  if (state.offline) {
    resetOnlineSearch();
    resetCastleSearch();
    // Pictures already handed to the browser stay in the DOM. Drop remote ones
    // so a lazy image cannot fire a request after the switch flips; local
    // endpoints and the cached sheet art are untouched.
    els.onlineModal?.querySelectorAll('img').forEach((img) => img.remove());
    if (!els.castleModal.hidden && state.castleTitle) renderCastleDownloads(state.castleTitle);
  } else if (!els.castleModal.hidden && state.castleTitle) {
    // Coming back online puts the Download buttons back.
    renderCastleDownloads(state.castleTitle);
  }
  // Cards already on screen keep their <img src>, so a remote CDN picture
  // would still be fetched after the switch flips. Re-render swaps those out
  // (offline) or back in (online); cached local art is unaffected.
  if (state.library) renderAll();
}

async function toggleOffline() {
  els.offlineBtn.disabled = true;
  try {
    const settings = await setOfflineMode(!state.offline);
    state.offline = Boolean(settings.offline);
    applyOfflineUi();
    toast(state.offline
      ? 'Offline mode on — no internet access'
      : 'Offline mode off — internet access restored');
    if (state.offline) {
      if (!els.searchOverlay.hidden) runSearch(els.searchInput.value);
    }
    if (state.view === 'online') {
      if (state.offline) showOnline();
      else loadOnlineBrowse();
    }
    refreshDownloads();
  } catch (err) {
    toast(`Could not switch offline mode: ${err.message}`);
  } finally {
    els.offlineBtn.disabled = false;
  }
}

/* ---------- settings sheet ---------- */

function applyCastleFallbackUi() {
  const on = state.castleFallback !== false;
  els.castleFallbackBtn.setAttribute('aria-checked', String(on));
  els.castleFallbackBtn.classList.toggle('is-off', !on);
  els.castleFallbackLabel.textContent = on ? 'On' : 'Off';
  els.castleFallbackBtn.title = on
    ? 'Torrentio first, Castle 720p when it has no release'
    : 'Torrentio only — no Castle fallback';
}

function openSettings() {
  closeProfile();
  applyCastleFallbackUi();
  applyAutoplaySoundUi();
  applyDownloadLimitUi();
  applyLibraryRootUi();
  showLibraryError('');
  showDlLimitError('');
  els.settingsModal.hidden = false;
  syncBodyLock();
  setTimeout(() => els.settingsModal.querySelector('.modal-close')?.focus(), 40);
  /* The app itself (after a restart) or another tab may have changed these. */
  getSettings()
    .then((settings) => {
      state.castleFallback = settings.castleFallback !== false;
      state.autoplaySound = settings.autoplaySound !== false;
      state.downloadMaxActive = Number(settings.downloadMaxActive) || state.downloadMaxActive;
      state.downloadLimitMBps = Number(settings.downloadLimitMBps) || 0;
      state.libraryRoot = settings.libraryRoot || state.libraryRoot;
      state.libraryRootSetting = settings.libraryRootSetting || state.libraryRoot;
      state.libraryRestartPending = Boolean(settings.libraryRootPending);
      applyCastleFallbackUi();
      applyAutoplaySoundUi();
      applyDownloadLimitUi();
      applyLibraryRootUi();
    })
    .catch(() => { /* keep what boot found */ });
}

function closeSettings() {
  els.settingsModal.hidden = true;
  syncBodyLock();
}

async function toggleCastleFallback() {
  els.castleFallbackBtn.disabled = true;
  try {
    const settings = await setCastleFallback(!(state.castleFallback !== false));
    state.castleFallback = settings.castleFallback !== false;
    applyCastleFallbackUi();
    // The open sheet's source line and totals depend on this, so re-plan it.
    state.castlePlanCache.clear();
    if (!els.castleModal.hidden && state.castleTitle) renderCastleDownloads(state.castleTitle);
    toast(state.castleFallback
      ? 'Castle fallback on — 720p when Torrentio has no release'
      : 'Torrentio only — no Castle fallback');
  } catch (err) {
    toast(`Could not change the download source: ${err.message}`);
  } finally {
    els.castleFallbackBtn.disabled = false;
  }
}

function applyAutoplaySoundUi() {
  const on = state.autoplaySound !== false;
  els.autoplaySoundBtn.setAttribute('aria-checked', String(on));
  els.autoplaySoundBtn.classList.toggle('is-off', !on);
  els.autoplaySoundLabel.textContent = on ? 'On' : 'Off';
  els.autoplaySoundBtn.title = on
    ? 'Preview and player start with sound'
    : 'Preview and player start muted';
}

async function toggleAutoplaySound() {
  els.autoplaySoundBtn.disabled = true;
  try {
    const settings = await setAutoplaySound(!(state.autoplaySound !== false));
    state.autoplaySound = settings.autoplaySound !== false;
    applyAutoplaySoundUi();
    // A running preview has to follow the new default straight away.
    if (!state.autoplaySound) {
      els.heroVideo.muted = true;
      syncHeroMute(false);
    }
    toast(state.autoplaySound
      ? 'Auto-play sound on'
      : 'Auto-play sound off — videos start muted');
  } catch (err) {
    toast(`Could not change the sound setting: ${err.message}`, { type: 'warn' });
  } finally {
    els.autoplaySoundBtn.disabled = false;
  }
}

function applyDownloadLimitUi() {
  const max = Number(state.downloadMaxActive) || 3;
  const limit = Number(state.downloadLimitMBps) || 0;
  if (document.activeElement !== els.dlMaxActiveInput) els.dlMaxActiveInput.value = String(max);
  if (document.activeElement !== els.dlSpeedInput) els.dlSpeedInput.value = String(limit);
  els.dlMaxActiveInput.placeholder = '3';
  els.dlSpeedInput.placeholder = '0';
}

function showDlLimitError(message) {
  els.dlLimitError.textContent = message || '';
  els.dlLimitError.hidden = !message;
}

async function saveDownloadMaxActive() {
  const wanted = Math.round(Number(els.dlMaxActiveInput.value));
  if (!Number.isFinite(wanted) || wanted < 1 || wanted > 20) {
    showDlLimitError('Parallel downloads must be a whole number from 1 to 20.');
    return;
  }
  showDlLimitError('');
  els.dlMaxActiveSave.disabled = true;
  try {
    const settings = await setDownloadLimits({ maxActive: wanted });
    state.downloadMaxActive = Number(settings.downloadMaxActive) || 3;
    applyDownloadLimitUi();
    toast(`${state.downloadMaxActive} video${state.downloadMaxActive === 1 ? '' : 's'} download at a time`);
  } catch (err) {
    showDlLimitError(err.message);
  } finally {
    els.dlMaxActiveSave.disabled = false;
  }
}

async function saveDownloadSpeedLimit() {
  const wanted = Number(els.dlSpeedInput.value);
  if (!Number.isFinite(wanted) || wanted < 0 || wanted > 1000) {
    showDlLimitError('Speed limit must be 0 (no limit) or a number up to 1000 MB/s.');
    return;
  }
  showDlLimitError('');
  els.dlSpeedSave.disabled = true;
  try {
    const settings = await setDownloadLimits({ limitMBps: wanted });
    state.downloadLimitMBps = Number(settings.downloadLimitMBps) || 0;
    applyDownloadLimitUi();
    toast(state.downloadLimitMBps > 0
      ? `Download speed limited to ${state.downloadLimitMBps} MB/s`
      : 'Download speed is unlimited');
  } catch (err) {
    showDlLimitError(err.message);
  } finally {
    els.dlSpeedSave.disabled = false;
  }
}

function applyLibraryRootUi() {
  const current = state.libraryRoot || 'G:\\NETFLIX';
  if (document.activeElement !== els.libraryRootInput) {
    els.libraryRootInput.value = state.libraryRootSetting || current;
  }
  els.libraryRootHint.textContent = `Scanning ${current}. Films and the .cache folder (catalog, artwork, downloads) live here.`;
  els.libraryRestartRow.hidden = !state.libraryRestartPending;
}

function showLibraryError(message) {
  els.libraryRootError.textContent = message || '';
  els.libraryRootError.hidden = !message;
}

async function saveLibraryRoot() {
  const wanted = els.libraryRootInput.value.trim();
  showLibraryError('');
  els.libraryRootSave.disabled = true;
  try {
    const settings = await setLibraryRoot(wanted);
    state.libraryRoot = settings.libraryRoot || state.libraryRoot;
    state.libraryRootSetting = settings.libraryRootSetting || wanted;
    state.libraryRestartPending = Boolean(settings.libraryRootPending);
    applyLibraryRootUi();
    toast(state.libraryRestartPending
      ? 'Folder saved — restart the app to scan it'
      : 'That folder is already the library');
  } catch (err) {
    showLibraryError(err.message);
  } finally {
    els.libraryRootSave.disabled = false;
  }
}

async function restartLibraryApp() {
  els.libraryRestartBtn.disabled = true;
  try {
    await restartApp();
    toast('Restarting the app — this page reconnects in a moment', { type: 'info' });
  } catch (err) {
    els.libraryRestartBtn.disabled = false;
    toast(`Could not restart: ${err.message}`, { type: 'warn' });
  }
}

function openSearch() {
  stopPreview();
  setMobileActive('search');
  els.searchOverlay.hidden = false;
  syncBodyLock();
  els.searchInput.value = '';
  els.searchResults.replaceChildren();
  els.searchLocalEmpty.hidden = true;
  els.searchLocalCount.textContent = '';
  resetOnlineSearch();
  resetCastleSearch();
  renderSearchHistory();
  els.searchHint.textContent = state.offline
    ? `Offline mode — searching ${state.items.length} local title${state.items.length === 1 ? '' : 's'} only`
    : (state.items.length
      ? `Search ${state.items.length} title${state.items.length === 1 ? '' : 's'} in your library, the download catalog, and movies online`
      : 'Search the download catalog and thousands of movies and series online');
  setTimeout(() => els.searchInput.focus(), 30);
}

function closeSearch() {
  els.searchOverlay.hidden = true;
  syncBodyLock();
  rememberSearch(els.searchInput.value);
  els.searchInput.blur();
  setMobileActive(['home', 'local', 'favourite', 'online'].includes(state.view) ? state.view : null);
  if (state.view === 'home' && !isModalOpen() && els.onlineModal.hidden && els.castleModal.hidden) {
    setupPreview(state.byId.get(state.heroId));
  }
}

const runSearch = debounce((raw) => {
  const query = String(raw || '').trim();
  const q = query.toLowerCase();

  if (!q) {
    els.searchResults.replaceChildren();
    els.searchLocalEmpty.hidden = true;
    els.searchLocalCount.textContent = '';
      resetOnlineSearch();
    resetCastleSearch();
    renderSearchHistory();
    els.searchHint.textContent = state.offline
      ? `Offline mode — searching ${state.items.length} local title${state.items.length === 1 ? '' : 's'}`
      : (state.items.length
        ? `Search ${state.items.length} title${state.items.length === 1 ? '' : 's'} in your library, the download catalog, and movies online`
        : 'Search the download catalog and thousands of movies and series online');
    return;
  }

  els.searchHistory.hidden = true;
  els.searchHint.textContent = `Results for “${query}”`;
  renderLocalResults(query, q);

  if (state.offline) {
    resetOnlineSearch();
    resetCastleSearch();
    els.searchHint.textContent = `Offline mode — local results for “${query}”`;
    return;
  }

  if (q.length < ONLINE_MIN_CHARS) {
    resetOnlineSearch();
    resetCastleSearch();
    return;
  }

  els.searchCastleSection.hidden = false;
  const castleCached = state.castleCache.get(q);
  if (castleCached) {
    state.castleToken += 1;
    state.castleAbort?.abort();
    state.castleAbort = null;
    renderCastleResults(castleCached, query);
  } else {
    state.castleResults = [];
    els.searchCastleResults.replaceChildren();
    els.searchCastleCount.textContent = '';
    els.searchCastleEmpty.hidden = true;
    els.searchCastleError.hidden = true;
    els.searchCastleLoading.hidden = false;
    fetchCastleResults(query);
  }

  els.searchOnlineSection.hidden = false;
  const cached = state.onlineCache.get(q);
  if (cached) {
    state.onlineToken += 1;
    state.onlineAbort?.abort();
    state.onlineAbort = null;
    renderOnlineResults(cached, query);
    return;
  }

  state.onlineResults = [];
  els.searchOnlineResults.replaceChildren();
  els.searchOnlineCount.textContent = '';
  els.searchOnlineEmpty.hidden = true;
  els.searchOnlineError.hidden = true;
  els.searchOnlineLoading.hidden = false;
  fetchOnlineResults(query);
}, 280);

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Bounded Levenshtein distance: stop as soon as it exceeds `max`. */
function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function tokenScore(token, word) {
  if (word === token) return 1;
  if (word.startsWith(token)) return 0.95;
  if (word.includes(token)) return 0.9;
  // Allow typos: one for medium words, two for long ones.
  const allowed = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0;
  if (!allowed) return 0;
  return editDistance(token, word, allowed) <= allowed ? 0.7 : 0;
}

/* Fuzzy local search: exact and prefix matches rank first, then titles whose
 * words are one or two letters off, so "cyberpunck" still finds Cyberpunk. */
function searchScore(query, item) {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  const title = normalizeSearchText(item.title);
  const hay = normalizeSearchText([
    item.title,
    item.fileName,
    item.collection,
    item.year,
    ...(item.genres || []),
  ].filter(Boolean).join(' '));
  if (!hay) return 0;

  if (title === q) return 120;
  if (title.startsWith(q)) return 110;
  if (hay.includes(q)) return 100;

  const tokens = q.split(' ').filter(Boolean);
  const words = hay.split(' ').filter(Boolean);
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const word of words) best = Math.max(best, tokenScore(token, word));
    if (!best) return 0; // every query word has to match something
    total += best;
  }
  return 60 + (total / tokens.length) * 30;
}

function renderLocalResults(query, q) {
  const groups = groupLibrary();
  const index = groupIndex(groups);
  const best = new Map();
  state.items.forEach((item, i) => {
    const score = searchScore(q, item);
    if (score <= 0) return;
    const group = index.get(item.id) || item;
    const previous = best.get(group.id);
    if (!previous || score > previous.score) best.set(group.id, { item: group, score, order: i });
  });
  const results = [...best.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.item);
  els.searchResults.replaceChildren();
  results.forEach((item) => els.searchResults.append(buildCard(item)));
  els.searchLocalCount.textContent = results.length
    ? `${results.length} title${results.length === 1 ? '' : 's'}`
    : '';
  els.searchLocalEmpty.hidden = results.length > 0;
  if (!results.length) {
    els.searchLocalEmpty.textContent = state.offline
      ? `Nothing in your library matches “${query}”. Try a shorter word or check the spelling.`
      : `Nothing in your library matches “${query}”. Downloadable and online results are below.`;
  }
}

async function fetchCastleResults(query) {
  const token = ++state.castleToken;
  const q = query.toLowerCase();
  state.castleAbort?.abort();
  const controller = new AbortController();
  state.castleAbort = controller;
  state.castleLoading = true;

  try {
    const data = await searchCastle(query, { signal: controller.signal });
    if (token !== state.castleToken) return;
    const results = Array.isArray(data.results) ? data.results : [];
    state.castleCache.set(q, results);
    renderCastleResults(results, query);
  } catch (err) {
    if (token !== state.castleToken || err?.name === 'AbortError') return;
    state.castleResults = [];
    els.searchCastleResults.replaceChildren();
    els.searchCastleCount.textContent = '';
    els.searchCastleEmpty.hidden = true;
    els.searchCastleError.textContent = `Could not load the download catalog (${err.message}).`;
    els.searchCastleError.hidden = false;
  } finally {
    if (token === state.castleToken) {
      state.castleLoading = false;
      els.searchCastleLoading.hidden = true;
    }
  }
}

function renderCastleResults(items, query) {
  const downloadable = items.filter((item) => item.downloadable !== false);
  els.searchCastleResults.replaceChildren();
  downloadable.forEach((item) => els.searchCastleResults.append(buildOnlineCard(item, { castle: true })));
  els.searchCastleCount.textContent = downloadable.length
    ? `${downloadable.length} title${downloadable.length === 1 ? '' : 's'}`
    : '';
  els.searchCastleLoading.hidden = true;
  els.searchCastleError.hidden = true;
  els.searchCastleEmpty.hidden = downloadable.length > 0;
  if (!downloadable.length) {
    els.searchCastleEmpty.textContent = `No downloadable titles found for “${query}”.`;
  }
}

async function fetchOnlineResults(query) {
  const token = ++state.onlineToken;
  const q = query.toLowerCase();
  state.onlineAbort?.abort();
  const controller = new AbortController();
  state.onlineAbort = controller;
  state.onlineLoading = true;

  try {
    const data = await searchOnline(query, { signal: controller.signal });
    if (token !== state.onlineToken) return;
    const results = Array.isArray(data.results) ? data.results : [];
    state.onlineCache.set(q, results);
    renderOnlineResults(results, query);
  } catch (err) {
    if (token !== state.onlineToken || err?.name === 'AbortError') return;
    state.onlineResults = [];
    state.onlineError = err?.message || 'unknown error';
    els.searchOnlineResults.replaceChildren();
    els.searchOnlineCount.textContent = '';
    els.searchOnlineEmpty.hidden = true;
    els.searchOnlineError.textContent = `Could not load online results (${state.onlineError}). Check your connection and try again.`;
    els.searchOnlineError.hidden = false;
  } finally {
    if (token === state.onlineToken) {
      state.onlineLoading = false;
      els.searchOnlineLoading.hidden = true;
    }
  }
}

function renderOnlineResults(items, query) {
  els.searchOnlineResults.replaceChildren();
  items.forEach((item) => els.searchOnlineResults.append(buildOnlineCard(item)));
  els.searchOnlineCount.textContent = items.length
    ? `${items.length} title${items.length === 1 ? '' : 's'}`
    : '';
  els.searchOnlineLoading.hidden = true;
  els.searchOnlineError.hidden = true;
  els.searchOnlineEmpty.hidden = items.length > 0;
  if (!items.length) {
    els.searchOnlineEmpty.textContent = `No movies or series found online for “${query}”.`;
  }
}

function buildOnlineCard(item, { castle = false } = {}) {
  const card = createEl('article', 'online-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', castle
    ? `View download options for ${item.title}`
    : `View details for ${item.title}`);

  const art = createEl('div', 'online-card-art');
  const fallback = createEl('div', 'online-card-fallback');
  fallback.append(createEl('span', '', item.title));

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  if (item.poster) img.src = item.poster;
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());

  const kind = item.type === 'series' || item.type === 'anime' ? 'Series' : 'Film';
  const badgeText = castle ? 'Download' : kind;
  const badge = createEl('span', `online-badge${castle ? ' castle-badge' : ''}`, badgeText);
  const overlay = createEl('div', 'online-card-overlay');
  overlay.append(createEl('strong', '', item.title));
  overlay.append(createEl('span', '', [item.year, kind].filter(Boolean).join(' • ')));

  art.append(fallback, img, badge);
  const rating = Number(item.rating) || 0;
  if (rating > 0) {
    art.append(createEl('span', 'online-rating', `★ ${rating.toFixed(1)}`));
  }
  art.append(overlay);
  card.append(art);

  const open = () => (castle ? openCastleModal(item) : openOnlineModal(item));
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return card;
}

/* ---------- online title modal ---------- */

let onlineFocusEl = null;
let onlineDetailToken = 0;

async function openOnlineModal(item) {
  if (!els.searchOverlay.hidden) closeSearch();
  if (!els.castleModal.hidden) closeCastleModal();
  stopPreview();
  onlineFocusEl = document.activeElement;
  state.onlineTitle = item;
  const token = ++onlineDetailToken;
  els.onlineModal.hidden = false;
  syncBodyLock();
  els.onlineModal.scrollTop = 0;
  populateOnlineModal(item, { loading: !state.onlineCache.has(`title:${item.type}:${item.id}`) });
  setTimeout(() => els.onlineModal.querySelector('.modal-close')?.focus(), 40);

  const cacheKey = `title:${item.type}:${item.id}`;
  const cached = state.onlineCache.get(cacheKey);
  if (cached) {
    populateOnlineModal(cached);
    return;
  }

  try {
    const detail = await getOnlineTitle(item.type, item.id);
    if (token !== onlineDetailToken) return;
    state.onlineCache.set(cacheKey, detail);
    populateOnlineModal(detail);
  } catch {
    if (token !== onlineDetailToken) return;
    populateOnlineModal(item); // drops the skeletons, keeps what we already know
    els.onlinePlot.textContent = item.description
      || 'Full details are unavailable right now. The IMDb link below still works.';
  }
}

function populateOnlineModal(item, { loading = false } = {}) {
  state.onlineTitle = item;
  setImg(els.onlineBackdrop, item.background || item.poster || '');
  els.onlineBackdrop.hidden = !(item.background || item.poster);
  els.onlineTitle.textContent = item.title;
  els.onlineKicker.textContent = item.type === 'series' ? 'SERIES' : 'FILM';

  const seasonCount = Array.isArray(item.seasons) ? item.seasons.length : 0;
  const episodeCount = Number(item.episodeCount) || (Array.isArray(item.seasons)
    ? item.seasons.reduce((sum, s) => sum + (s.episodes?.length || 0), 0)
    : 0);

  els.onlineMeta.replaceChildren();
  const bits = [
    item.year,
    item.rating ? `★ ${Number(item.rating).toFixed(1)}` : '',
    item.type === 'series' && seasonCount
      ? `${seasonCount} season${seasonCount === 1 ? '' : 's'} · ${episodeCount} episode${episodeCount === 1 ? '' : 's'}`
      : item.runtime,
    Array.isArray(item.genres) ? item.genres.slice(0, 3).join(' · ') : '',
  ].filter(Boolean);
  bits.forEach((bit, index) => {
    if (index > 0) els.onlineMeta.append(createEl('span', 'dot', '•'));
    els.onlineMeta.append(createEl('span', index === 0 ? 'year' : '', bit));
  });
  if (loading && !bits.length) els.onlineMeta.append(skelMeta());

  if (!item.description && loading) els.onlinePlot.replaceChildren(skelLines(3));
  else els.onlinePlot.textContent = item.description || 'No overview available for this title yet.';
  els.onlineWatchLink.href = `https://www.justwatch.com/us/search?q=${encodeURIComponent(item.title)}`;
  els.onlineImdbLink.href = `https://www.imdb.com/title/${encodeURIComponent(item.id)}/`;
  renderOnlineSeasons(item);
  if (loading && item.type === 'series' && !(item.seasons || []).length) renderOnlineSeasonSkeleton();
}

function renderOnlineSeasonSkeleton() {
  els.onlineSeasonBlock.hidden = false;
  els.onlineSeasonTabs.replaceChildren(skel('sk-pill'), skel('sk-pill'), skel('sk-pill'));
  els.onlineEpisodes.replaceChildren(...skelEpisodes(3, { button: false }));
}

function renderOnlineSeasons(item) {
  const seasons = Array.isArray(item.seasons) ? item.seasons : [];
  els.onlineSeasonBlock.hidden = seasons.length === 0;
  els.onlineSeasonTabs.replaceChildren();
  els.onlineEpisodes.replaceChildren();
  if (!seasons.length) return;

  const buttons = new Map();
  const renderEpisodes = (entry) => {
    els.onlineEpisodes.replaceChildren();
    for (const episode of entry.episodes) {
      const row = createEl('article', 'episode-row');

      // Catalog thumbnails are remote CDN pictures; offline mode skips them.
      if (episode.thumbnail && !state.offline) {
        const thumb = document.createElement('img');
        thumb.className = 'episode-thumb';
        thumb.loading = 'lazy';
        thumb.alt = '';
        thumb.src = episode.thumbnail;
        thumb.addEventListener('error', () => thumb.remove());
        row.append(thumb);
      }

      const main = createEl('div', 'episode-main');
      const head = createEl('div', 'episode-head');
      head.append(createEl('span', 'episode-number', `E${episode.episode}`));
      head.append(createEl('strong', '', episode.title));
      main.append(head);

      const date = new Date(episode.released);
      if (!Number.isNaN(date.getTime())) {
        main.append(createEl('span', 'episode-date', date.toLocaleDateString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
        })));
      }
      if (episode.overview) main.append(createEl('p', 'episode-overview', episode.overview));
      row.append(main);
      els.onlineEpisodes.append(row);
    }
  };

  seasons.forEach((entry, index) => {
    const btn = createEl('button', 'season-tab', `Season ${entry.season}`);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      buttons.forEach((value) => value.classList.remove('active'));
      btn.classList.add('active');
      renderEpisodes(entry);
      els.onlineEpisodes.scrollTop = 0;
    });
    buttons.set(entry.season, btn);
    els.onlineSeasonTabs.append(btn);
    if (index === 0) btn.classList.add('active');
  });
  renderEpisodes(seasons[0]);
}

function closeOnlineModal() {
  if (els.onlineModal.hidden) return;
  els.onlineModal.hidden = true;
  state.onlineTitle = null;
  onlineDetailToken += 1;
  syncBodyLock();
  onlineFocusEl?.focus?.();
  if (state.view === 'home' && !isModalOpen()) {
    setupPreview(state.byId.get(state.heroId));
  }
}

/* ---------- castle download modal ---------- */

const CASTLE_QUALITY = { 1: '480p', 2: '720p', 3: '1080p' };
/* 1080p is premium-only on this source, so the sheet downloads 720p. */
const CASTLE_RESOLUTION = 2;
let castleFocusEl = null;

function qualityName(resolution) {
  return CASTLE_QUALITY[Number(resolution)] || `${resolution}K`;
}

function castleEpisodesOf(detail) {
  if (!detail) return [];
  if (detail.type !== 'series') return Array.isArray(detail.episodes) ? detail.episodes : [];
  const active = (detail.seasons || []).find((entry) => entry.season === detail.activeSeason)
    || (detail.seasons || []).find((entry) => entry.episodes?.length);
  return Array.isArray(active?.episodes) ? active.episodes : [];
}

const LIST_PLUS_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>';
const LIST_CHECK_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12 5 5 9-10"/></svg>';

/* The sheet can save either a local group or a catalog title. Catalog titles
 * store a small snapshot so the My List row renders them without a lookup. */
function castleListEntry(detail) {
  const group = state.castleLocal?.group || null;
  if (group?.id) return { local: true, id: group.id };
  if (!detail?.id) return null;
  return {
    local: false,
    entry: {
      key: `castle:${detail.id}`,
      castleId: String(detail.id),
      title: detail.title,
      poster: detail.poster || '',
      background: detail.background || '',
      year: detail.year || '',
      rating: detail.rating || 0,
      type: detail.type || 'movie',
      description: detail.description || '',
      seasonCount: detail.seasonCount || 0,
      genres: Array.isArray(detail.genres) ? detail.genres : [],
    },
  };
}

function updateCastleListButton(detail) {
  const info = castleListEntry(detail);
  if (!info) {
    els.castleList.hidden = true;
    return;
  }
  const inList = info.local ? isInMyList(info.id) : isInRemoteList(info.entry.key);
  els.castleList.hidden = false;
  els.castleList.classList.toggle('in-list', inList);
  els.castleList.innerHTML = inList ? LIST_CHECK_ICON : LIST_PLUS_ICON;
  els.castleList.setAttribute('aria-label', inList ? 'Remove from Favourite' : 'Add to Favourite');
  els.castleList.title = inList ? 'Remove from Favourite' : 'Add to Favourite';
}

function toggleCastleList() {
  const detail = state.castleTitle;
  const info = castleListEntry(detail);
  if (!info) return;
  const added = info.local ? toggleMyList(info.id) : toggleRemoteList(info.entry);
  updateCastleListButton(detail);
  toast(added ? 'Added to Favourite' : 'Removed from Favourite');
  renderRows();
  if (state.view === 'favourite') showFavourite();
}

/* Shimmer placeholders while a catalogue sheet loads its seasons/episodes. */
function castleSkeletonRows(count) {
  return Array.from({ length: count }, () => {
    const row = createEl('div', 'castle-skel-row');
    row.append(createEl('div', 'skeleton castle-skel-thumb'));
    const lines = createEl('div', 'castle-skel-lines');
    lines.append(createEl('div', 'skeleton castle-skel-title'));
    lines.append(createEl('div', 'skeleton castle-skel-sub'));
    row.append(lines);
    row.append(createEl('div', 'skeleton castle-skel-btn'));
    return row;
  });
}

/* Quality chips, size line, "Download all" and the episode rows all become
 * placeholders; renderCastleDownloads swaps in the real ones. */
function renderCastleSkeleton(count = 5, { series = true } = {}) {
  els.castleStatus.textContent = '';
  els.castleStatus.hidden = false;
  els.castleSeasonTabs.hidden = false;
  els.castleSeasonTabs.replaceChildren();
  for (let i = 0; i < 2; i += 1) {
    els.castleSeasonTabs.append(createEl('div', 'season-tab skeleton skeleton-pill'));
  }
  els.castleSize.replaceChildren(skel('sk-line', '150px', '12px'));
  els.castleSeasonDownload.hidden = !series;
  els.castleSeasonDownload.disabled = true;
  els.castleSeasonDownload.textContent = 'Download all';
  els.castleSeasonDownload.classList.add('is-skeleton');
  els.castleEpisodes.replaceChildren(...castleSkeletonRows(count));
}

function clearCastleSkeleton() {
  els.castleSeasonDownload.classList.remove('is-skeleton');
  els.castleSize.replaceChildren();
}

/* Keep the open sheet in step with the download queue: queued turns into a
 * percentage, finished episodes turn into Play after the library rescans. */
function castleSignature() {
  return state.downloads
    .map((job) => `${job.id}:${job.status}:${Math.round((job.progress || 0) * 20)}`)
    .sort()
    .join('|');
}

function syncCastleSheet() {
  if (els.castleModal.hidden || !state.castleTitle) return;
  const sig = castleSignature();
  if (sig === state.castleSig) return;
  state.castleSig = sig;
  const group = state.castleLocal?.group;
  if (group) {
    const fresh = groupLibrary().find((entry) => entry.id === group.id) || group;
    state.castleLocal = { ...state.castleLocal, group: fresh, local: localEpisodesFor(fresh) };
  }
  renderCastleDownloads(state.castleTitle);
}

function populateCastleModal(item, { loading = false } = {}) {
  // Saved titles point at this app's own art routes, which keep working
  // offline; only an unsaved CDN picture has to be dropped.
  const art = item.background || item.poster || '';
  const remoteArt = state.offline && !art.startsWith('/api/') ? '' : art;
  setImg(els.castleBackdrop, remoteArt);
  els.castleBackdrop.hidden = !remoteArt;
  setCastleLogo(item);
  els.castleKicker.textContent = 'DOWNLOAD';
  if (!item.description && loading) els.castlePlot.replaceChildren(skelLines(3));
  else els.castlePlot.textContent = item.description || 'No overview available for this title yet.';
  els.castleModal.scrollTop = 0;

  const bits = [
    item.year,
    item.rating ? `★ ${Number(item.rating).toFixed(1)}` : '',
    item.type === 'series' && item.seasonCount
      ? `${item.seasonCount} season${item.seasonCount === 1 ? '' : 's'}`
      : '',
    Array.isArray(item.genres) ? item.genres.slice(0, 3).join(' · ') : '',
  ].filter(Boolean);

  els.castleMeta.replaceChildren();
  bits.forEach((bit, index) => {
    if (index > 0) els.castleMeta.append(createEl('span', 'dot', '•'));
    els.castleMeta.append(createEl('span', index === 0 ? 'year' : '', bit));
  });
  if (loading && !bits.length) els.castleMeta.append(skelMeta());
  updateCastleListButton(item);
}

async function openCastleModal(item) {
  if (!els.searchOverlay.hidden) closeSearch();
  if (!els.onlineModal.hidden) closeOnlineModal();
  stopPreview();
  stopCastleTrailer();
  castleFocusEl = document.activeElement;
  state.castleTitle = item;
  state.castleLocal = null;
  state.castleSeason = 0;
  state.castleBusy = false;
  resetCastleDeleteAll();
  const token = ++state.castleDetailToken;
  els.castleModal.hidden = false;
  syncBodyLock();
  populateCastleModal(item, { loading: true });
  els.castleDownloadBlock.hidden = false;
  els.castleResume.hidden = true;
  renderCastleSkeleton(5, { series: item.type === 'series' });
  setTimeout(() => els.castleModal.querySelector('.modal-close')?.focus(), 40);

  try {
    const detail = await getCastleTitle(item.id);
    if (token !== state.castleDetailToken) return;
    const merged = { ...item, ...detail };
    state.castleTitle = merged;
    state.castleSeason = detail.activeSeason || 0;
    state.castleCatalog = null;
    state.castleCache.set(`${detail.id}:${detail.activeSeason || 0}`, detail);
    populateCastleModal(merged);
    renderCastleDownloads(merged);
    startCastleTrailer(merged, 'castle');
    if (detail.type === 'series') {
      // "Download all" needs every season, but the sheet must not wait for them.
      getCastleSeriesEpisodes(detail.id).then((full) => {
        if (token !== state.castleDetailToken) return;
        if (!full || !Array.isArray(full.seasons)) return;
        state.castleCatalog = { seasons: full.seasons };
        if (!els.castleModal.hidden && state.castleTitle === merged) {
          els.castleSeasonDownload.disabled = state.castleBusy || state.offline || castleAllLocal(merged);
        }
      }).catch(() => { /* the button falls back to the open season */ });
    }
  } catch (err) {
    if (token !== state.castleDetailToken) return;
    clearCastleSkeleton();
    populateCastleModal(item);
    els.castleEpisodes.replaceChildren();
    els.castleSeasonTabs.replaceChildren();
    els.castleSeasonDownload.hidden = true;
    els.castleStatus.textContent = `Could not load download options (${err.message}).`;
    els.castleStatus.hidden = false;
  }
}

/* The sheet shows what a click actually fetches. Torrentio is the download
 * source, so the sheet asks the server which release would win for each episode
 * and paints that quality and size; Castle's free 720p numbers stay as the
 * fallback when Torrentio has nothing with English audio. */
const CASTLE_PLAN_TTL = 5 * 60 * 1000;
let castlePlanInFlight = '';

function castlePlanKey(detail, season) {
  return `${detail?.id || ''}:${Number(season) || 0}`;
}

function castlePlanFor(detail, episode) {
  const season = detail?.activeSeason ?? state.castleSeason ?? 0;
  const entry = state.castlePlanCache.get(castlePlanKey(detail, season));
  if (!entry) return null;
  return entry.episodes.get(Number(episode)) || null;
}

function renderCastleSizes(detail, episodes) {
  const season = detail.activeSeason ?? state.castleSeason ?? 0;
  const entry = state.castlePlanCache.get(castlePlanKey(detail, season));
  const plans = episodes.map((episode) => castlePlanFor(detail, episode.episode));
  const planned = plannedSummary(plans);

  if (planned) {
    const label = detail.type === 'series' && episodes.length
      ? `${episodes.length} episode${episodes.length === 1 ? '' : 's'} · ${planned.quality}`
      : planned.quality;
    els.castleSize.textContent = [label, `≈ ${formatSize(planned.total)}`].filter(Boolean).join(' · ');
    return CASTLE_RESOLUTION;
  }

  /* Torrentio-only mode never shows Castle's 720p numbers: they are not what a
   * click would fetch. Report Torrentio's coverage of the open season instead. */
  if (state.castleFallback === false) {
    const count = episodes.length;
    const head = detail.type === 'series' && count
      ? `${count} episode${count === 1 ? '' : 's'}`
      : '';
    if (!entry) {
      els.castleSize.textContent = [head, 'Torrentio only'].filter(Boolean).join(' · ');
      return CASTLE_RESOLUTION;
    }
    const found = plans.filter((plan) => plan?.quality);
    const total = found.reduce((sum, plan) => sum + (Number(plan.sizeBytes) || 0), 0);
    els.castleSize.textContent = [
      detail.type === 'series' && count ? `${found.length} of ${count} episodes` : '',
      found.length ? 'Torrentio' : 'Torrentio only',
      total ? `≈ ${formatSize(total)}` : '',
    ].filter(Boolean).join(' · ');
    return CASTLE_RESOLUTION;
  }

  let total = 0;
  episodes.forEach((episode) => {
    const match = (episode.resolutions || []).find((entry) => entry.resolution === CASTLE_RESOLUTION);
    if (match) total += Number(match.size) || 0;
  });
  const label = detail.type === 'series' && episodes.length
    ? `${episodes.length} episode${episodes.length === 1 ? '' : 's'} at ${qualityName(CASTLE_RESOLUTION)}`
    : qualityName(CASTLE_RESOLUTION);
  els.castleSize.textContent = [label, total ? `≈ ${formatSize(total)}` : ''].filter(Boolean).join(' · ');
  return CASTLE_RESOLUTION;
}

/* Only a complete set of per-episode plans is shown: mixing Torrentio sizes
 * with Castle's 720p sizes would total two different things. */
function plannedSummary(plans) {
  if (!plans.length || plans.some((plan) => !plan?.quality)) return null;
  const total = plans.reduce((sum, plan) => sum + (Number(plan.sizeBytes) || 0), 0);
  if (!total) return null;
  const counts = new Map();
  plans.forEach((plan) => counts.set(plan.quality, (counts.get(plan.quality) || 0) + 1));
  const quality = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const codec = plans.find((plan) => plan.codec)?.codec;
  return { total, quality: codec === 'hevc' ? `${quality} HEVC` : codec ? `${quality} H.264` : quality };
}

/* Paint a plan the server already answered: header total, per-episode quality
 * and size, and one line naming the source (with subtitles). */
function applyCastlePlan(detail, episodes) {
  const season = detail.activeSeason ?? state.castleSeason ?? 0;
  const entry = state.castlePlanCache.get(castlePlanKey(detail, season));
  if (!entry) return;
  renderCastleSizes(detail, episodes);
  const fallback = entry.fallback !== false;
  els.castleSource.textContent = entry.source === 'torrentio'
    ? 'Video + subtitles from Torrentio'
    : entry.partial
      ? 'Torrentio did not answer - tap an episode to retry'
      : fallback
        ? `Castle fallback · ${qualityName(CASTLE_RESOLUTION)}`
        : 'Torrentio only · no release found';

  const localMap = state.castleLocal?.local || null;
  els.castleEpisodes.querySelectorAll('.castle-episode').forEach((row) => {
    const number = Number(row.dataset.episode);
    const local = localMap ? localMap.get(`${season}x${number}`) : null;
    if (local) return;
    const plan = entry.episodes.get(number);
    const meta = row.querySelector('.episode-date');
    if (!meta) return;
    const episode = episodes.find((item) => Number(item.episode) === number);

    /* A failed Torrentio call is not "no release": keep the button usable so a
     * tap asks again, and say what happened instead of greying the episode out
     * for the whole session. */
    if (entry.failed?.has(number) && !plan?.quality) {
      meta.textContent = [formatDuration(episode?.duration), 'Torrentio unreachable - tap to retry'].filter(Boolean).join(' · ');
      const btn = row.querySelector('.castle-dl-btn');
      if (btn && !btn.classList.contains('is-play') && !btn.classList.contains('queued')
        && !btn.classList.contains('is-active') && !btn.classList.contains('is-paused')
        && !btn.classList.contains('is-retry')) {
        btn.disabled = false;
        btn.title = 'Torrentio did not answer; try the download again';
        btn.querySelector('span').textContent = 'Retry';
      }
      return;
    }

    if (!plan?.quality) {
      /* Torrentio has nothing here and the fallback is off: say so on the row
       * and take the Download button away instead of offering a 409. */
      if (fallback) return;
      meta.textContent = [formatDuration(episode?.duration), 'No Torrentio release'].filter(Boolean).join(' · ');
      const btn = row.querySelector('.castle-dl-btn');
      const idle = btn && !btn.classList.contains('is-play') && !btn.classList.contains('queued')
        && !btn.classList.contains('is-active') && !btn.classList.contains('is-paused')
        && !btn.classList.contains('is-retry');
      if (idle) {
        btn.disabled = true;
        btn.title = state.offline
          ? 'Offline mode — go online to download'
          : 'Torrentio has no release with English audio and Castle fallback is off';
        btn.querySelector('span').textContent = state.offline ? 'Download' : 'Unavailable';
      }
      return;
    }
    meta.textContent = [
      formatDuration(episode?.duration),
      plan.quality,
      plan.sizeBytes ? formatSize(plan.sizeBytes) : '',
    ].filter(Boolean).join(' · ');

    /* The row was painted before this plan arrived, and Castle may have no file
     * for it at all. Turn the idle button into a real Download now. */
    const btn = row.querySelector('.castle-dl-btn');
    const idle = btn && !btn.classList.contains('is-play') && !btn.classList.contains('queued')
      && !btn.classList.contains('is-active') && !btn.classList.contains('is-paused')
      && !btn.classList.contains('is-retry');
    if (idle) {
      btn.disabled = state.offline;
      btn.title = state.offline
        ? 'Offline mode — go online to download'
        : `${plan.quality}${plan.sizeBytes ? ` · ${formatSize(plan.sizeBytes)}` : ''} · Torrentio`;
      btn.querySelector('span').textContent = 'Download';
    }
  });
}

function loadCastlePlan(detail, episodes) {
  if (!/^\d{6,20}$/.test(String(detail?.id || ''))) return;
  const numbers = episodes.map((episode) => Number(episode.episode)).filter((value) => Number.isFinite(value));
  if (!numbers.length) return;

  const season = detail.activeSeason ?? state.castleSeason ?? 0;
  const key = castlePlanKey(detail, season);
  const cached = state.castlePlanCache.get(key);
  if (cached && !cached.partial && Date.now() - cached.at < CASTLE_PLAN_TTL) return;
  if (castlePlanInFlight === key) return;
  castlePlanInFlight = key;

  const token = ++state.castlePlanToken;
  els.castleSource.textContent = 'Checking Torrentio releases…';

  const params = new URLSearchParams({
    movieId: String(detail.id),
    episodeId: String(episodes[0]?.episodeId || ''),
    title: detail.title,
    year: String(detail.year || ''),
    season: String(season),
    episodes: numbers.join(','),
    // The server ranks with this: a HEVC release it can copy is the fastest
    // install, one it would have to transcode is not. Without the flag the
    // sheet could label a different release than the click downloads.
    copyVideo: String(decodesHevc()),
  });

  fetch(`/api/castle/plan?${params}`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || token !== state.castlePlanToken) return;
      state.castlePlanCache.set(key, {
        at: Date.now(),
        source: data.source,
        fallback: data.fallback !== false,
        partial: Boolean(data.partial),
        failed: new Set((data.failedEpisodes || []).map(Number)),
        episodes: new Map((data.episodes || []).map((row) => [Number(row.episode), row])),
      });
      applyCastlePlan(detail, episodes);
    })
    .catch(() => {
      if (token === state.castlePlanToken) els.castleSource.textContent = '';
    })
    .finally(() => {
      if (castlePlanInFlight === key) castlePlanInFlight = '';
    });
}

const EP_DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>';
const EP_PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>';

/* The job that is currently handling one episode of the open sheet. HLS jobs
 * carry season/episode and the series title, so parallel downloads of another
 * show never leak into this list. */
function castleJobFor(detail, season, episode) {
  // Download titles carry " SxxExx" and the catalogue spelling (colons, dashes),
  // so compare the bare show name after normalising punctuation.
  const clean = (value) => String(value || '')
    .replace(/\s*[._-]?\s*s\d{1,2}\s*e\d{1,2}\b.*$/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const wanted = clean(detail?.title);
  return state.downloads.find((job) => {
    if (!job.season && !job.episode) return false;
    if (Number(job.season) !== Number(season) || Number(job.episode) !== Number(episode)) return false;
    if (!wanted) return true;
    return clean(job.title) === wanted || clean(job.seriesTitle) === wanted;
  }) || null;
}

/* Every catalogue episode, across every season, in one flat list. */
function castleCatalogEpisodes() {
  const catalog = state.castleCatalog;
  if (!catalog || !Array.isArray(catalog.seasons)) return [];
  return catalog.seasons.flatMap((row) => (row.episodes || []).map((episode) => ({
    ...episode,
    season: Number(row.season) || 0,
  })));
}

/* Every episode of this series that already sits anywhere in the library,
 * across collections, keyed "SxE". Download all skips those. */
function seriesLocalEpisodes(detail) {
  const norm = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const wanted = norm(detail?.title || detail?.seriesTitle);
  const map = new Map();
  if (!wanted) return map;
  for (const item of state.items) {
    if (!item.isSeries) continue;
    if (norm(item.seriesTitle || item.title) !== wanted) continue;
    map.set(`${item.season}x${item.episode}`, item);
  }
  return map;
}

function castleAllLocal(detail) {
  const episodes = castleCatalogEpisodes();
  if (!episodes.length) return false;
  const localMap = seriesLocalEpisodes(detail);
  if (!localMap.size) return false;
  return episodes.every((episode) => localMap.has(`${episode.season}x${episode.episode}`));
}

const EP_TRASH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/></svg>';

/* Grey delete button. First click arms it ("Sure?"), second click deletes. */
function buildDeleteButton(local) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'castle-del-btn';
  del.title = 'Delete this episode from disk';
  del.setAttribute('aria-label', `Delete episode ${local.episode}`);
  const paint = (text) => {
    del.innerHTML = EP_TRASH_ICON;
    del.append(createEl('span', '', text));
  };
  paint('Delete');
  let armTimer = 0;
  del.addEventListener('click', async () => {
    if (!del.classList.contains('is-armed')) {
      del.classList.add('is-armed');
      paint('Sure?');
      armTimer = setTimeout(() => { del.classList.remove('is-armed'); paint('Delete'); }, 3000);
      return;
    }
    clearTimeout(armTimer);
    del.disabled = true;
    paint('Deleting…');
    try {
      await deleteLibraryItem(local.id);
      await loadLibrary();
      refreshCastleLocal();
      toast('Episode deleted');
      renderCastleDownloads(state.castleTitle);
    } catch (err) {
      del.disabled = false;
      del.classList.remove('is-armed');
      paint('Delete');
      toast(`Could not delete: ${err.message}`);
    }
  });
  return del;
}

/* "Delete all" is series-wide: every local episode, whatever the season tab.
 * The first click arms the button, the second one deletes. */
let castleDeleteArmTimer = 0;

function resetCastleDeleteAll() {
  clearTimeout(castleDeleteArmTimer);
  castleDeleteArmTimer = 0;
  const btn = els.castleSeasonDelete;
  if (!btn) return;
  btn.classList.remove('is-armed');
  btn.disabled = false;
  btn.textContent = 'Delete all';
  btn.title = 'Delete every episode of this title from disk';
}

function bindCastleDeleteAll() {
  els.castleSeasonDelete.addEventListener('click', async () => {
    if (state.castleBusy) return;
    const ids = [...(state.castleLocal?.local?.values() || [])].map((entry) => entry.id).filter(Boolean);
    if (!ids.length) return;
    const btn = els.castleSeasonDelete;
    if (!btn.classList.contains('is-armed')) {
      btn.classList.add('is-armed');
      btn.textContent = `Delete all ${ids.length}?`;
      btn.title = 'Click again to delete every local episode of this title';
      clearTimeout(castleDeleteArmTimer);
      castleDeleteArmTimer = setTimeout(resetCastleDeleteAll, 3500);
      return;
    }
    clearTimeout(castleDeleteArmTimer);
    castleDeleteArmTimer = 0;
    state.castleBusy = true;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const result = await deleteLibraryItems(ids);
      const removed = Number(result?.removed) || 0;
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      await loadLibrary();
      refreshCastleLocal();
      if (!failed.length) {
        toast(removed === 1 ? 'Episode deleted' : `${removed} episodes deleted`);
        closeCastleModal();
        return;
      }
      toast(`Could not delete ${failed.length} episode${failed.length === 1 ? '' : 's'}: ${failed[0].error}`);
      if (removed) toast(`${removed} deleted, ${failed.length} still on disk`);
      state.castleBusy = false;
      resetCastleDeleteAll();
      renderCastleDownloads(state.castleTitle);
    } catch (err) {
      state.castleBusy = false;
      resetCastleDeleteAll();
      toast(`Could not delete: ${err.message}`);
    }
  });
}

function appendCastleAction(row, detail, episode, local, quality, plan) {
  const season = detail.activeSeason ?? state.castleSeason;
  const action = createEl('div', 'castle-ep-action');
  const job = local ? null : castleJobFor(detail, season, episode.episode);
  /* Castle's own 720p row is not the only way to download: Torrentio plans are
   * complete releases too. An episode with a plan must never read "Unavailable"
   * just because the Castle source has no file for it. */
  const available = Boolean(quality || plan?.quality);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'castle-dl-btn';

  const label = document.createElement('span');
  const paint = (icon, text) => {
    btn.innerHTML = icon;
    label.textContent = text;
    btn.append(label);
  };

  const showProgress = (value) => {
    action.querySelector('.castle-ep-bar')?.remove();
    const bar = createEl('div', 'castle-ep-bar');
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(100, Math.round(value)))}%`;
    bar.append(fill);
    action.append(bar);
  };

  if (local) {
    btn.classList.add('is-play');
    btn.setAttribute('aria-label', `Play episode ${local.episode}`);
    paint(EP_PLAY_ICON, 'Play');
    btn.addEventListener('click', () => goWatch(local.id));
    action.append(buildDeleteButton(local));
  } else if (job && (job.status === 'downloading' || job.status === 'cancelling')) {
    btn.classList.add('is-active');
    btn.title = 'Open downloads';
    paint(EP_DOWNLOAD_ICON, `${Math.round((job.progress || 0) * 100)}%`);
    showProgress((job.progress || 0) * 100);
    btn.addEventListener('click', openDownloads);
  } else if (job && job.status === 'queued') {
    btn.classList.add('queued');
    btn.title = 'Open downloads';
    paint(EP_DOWNLOAD_ICON, 'Queued');
    btn.addEventListener('click', openDownloads);
  } else if (job && job.status === 'paused') {
    btn.classList.add('is-paused');
    btn.title = 'Open downloads';
    paint(EP_DOWNLOAD_ICON, 'Paused');
    btn.addEventListener('click', openDownloads);
  } else if (job && job.status === 'failed') {
    btn.classList.add('is-retry');
    paint(EP_DOWNLOAD_ICON, 'Retry');
    btn.title = state.offline ? 'Go online to download' : (job.error || 'The last attempt failed');
    btn.disabled = !available || state.offline;
    btn.addEventListener('click', () => queueCastleEpisode(episode, btn));
  } else {
    // Offline the plan is unknowable, and the requirement is one greyed
    // "Download" per episode, not "Unavailable" for a row that simply cannot
    // ask Torrentio right now.
    paint(EP_DOWNLOAD_ICON, state.offline || available ? 'Download' : 'Unavailable');
    btn.disabled = state.offline || !available;
    btn.title = state.offline
      ? 'Offline mode — go online to download'
      : available && plan?.quality ? `${plan.quality} · Torrentio` : '';
    btn.addEventListener('click', () => queueCastleEpisode(episode, btn));
  }

  action.prepend(btn);
  row.append(action);
}

const SEASON_CHEV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const SEASON_TICK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
document.addEventListener('pointerdown', (e) => {
  document.querySelectorAll('.season-menu.is-open').forEach((m) => { if (!m.contains(e.target)) m.classList.remove('is-open'); });
});

function buildSeasonMenu(seasons, active, onPick) {
  const menu = createEl('div', 'season-menu');
  const trigger = createEl('button', 'season-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `<span>Season ${active}</span>${SEASON_CHEV}`;
  const pop = createEl('div', 'season-pop');
  pop.setAttribute('role', 'listbox');
  const opts = seasons.map((entry) => {
    const o = createEl('button', `season-opt${entry.season === active ? ' is-active' : ''}`);
    o.type = 'button';
    o.setAttribute('role', 'option');
    o.setAttribute('aria-selected', String(entry.season === active));
    o.innerHTML = `<span>Season ${entry.season}</span>${SEASON_TICK}`;
    o.addEventListener('click', () => {
      menu.classList.remove('is-open');
      if (entry.season !== active) onPick(Number(entry.season));
    });
    pop.append(o);
    return o;
  });
  const setOpen = (open) => {
    menu.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => (pop.querySelector('.is-active') || opts[0])?.focus({ preventScroll: true }), 30);
  };
  trigger.addEventListener('click', () => setOpen(!menu.classList.contains('is-open')));
  menu.addEventListener('keydown', (e) => {
    const open = menu.classList.contains('is-open');
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); trigger.focus(); }
    else if (e.key === 'ArrowDown' && !open && e.target === trigger) { e.preventDefault(); setOpen(true); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) {
      e.preventDefault();
      const i = opts.indexOf(document.activeElement);
      opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }
  });
  menu.append(trigger, pop);
  return menu;
}

function renderCastleDownloads(detail) {
  clearCastleSkeleton();
  const episodes = castleEpisodesOf(detail);
  els.castleDownloadBlock.hidden = false;
  els.castleEpisodes.replaceChildren();
  els.castleSeasonTabs.replaceChildren();
  els.castleStatus.textContent = '';
  els.castleStatus.hidden = false;
  els.castleSource.textContent = state.offline
    ? 'Offline mode — showing the saved catalogue'
    : 'Checking Torrentio releases…';
  updateCastleListButton(detail);

  const localMap = state.castleLocal?.local || null;
  const localFor = (season, episode) => (localMap ? localMap.get(`${season}x${episode}`) || null : null);

  const playTarget = castlePlayTarget();
  const isSeries = detail.type === 'series';
  els.castleResume.hidden = false;
  els.castleResume.dataset.mode = playTarget ? 'play' : 'download';
  els.castleResume.innerHTML = playTarget
    ? `${EP_PLAY_ICON}<span>${playTarget.label}</span>`
    : `${EP_DOWNLOAD_ICON}<span>${isSeries ? `Download Season ${detail.activeSeason || 1}` : 'Download'}</span>`;
  els.castleResume.disabled = !playTarget && state.offline;
  els.castleResume.title = !playTarget && state.offline ? 'Offline mode — go online to download' : '';

  const selected = renderCastleSizes(detail, episodes);

  const seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
  const canPickSeason = detail.type === 'series' && seasons.length > 1;
  els.castleSeasonTabs.hidden = !canPickSeason;
  if (canPickSeason) {
    els.castleSeasonTabs.append(buildSeasonMenu(seasons, Number(detail.activeSeason), (n) => selectCastleSeason(n)));
  }

  const allDone = castleAllLocal(detail);
  els.castleSeasonDownload.hidden = !(detail.type === 'series' && episodes.length);
  els.castleSeasonDownload.disabled = state.castleBusy || allDone || state.offline;
  els.castleSeasonDownload.title = state.offline ? 'Offline mode — go online to download' : '';
  els.castleSeasonDownload.classList.toggle('is-done', allDone);
  els.castleSeasonDownload.textContent = allDone ? 'Everything downloaded' : 'Download all';

  const localCount = localMap ? localMap.size : 0;
  els.castleSeasonDelete.hidden = !localCount;
  els.castleSeasonDelete.disabled = state.castleBusy;
  if (!localCount) resetCastleDeleteAll();
  else if (!els.castleSeasonDelete.classList.contains('is-armed')) {
    els.castleSeasonDelete.textContent = 'Delete all';
  }

  if (!episodes.length) {
    const seasonNo = detail.activeSeason ?? state.castleSeason ?? 0;
    els.castleStatus.textContent = state.offline
      ? `Season ${seasonNo} has no saved episodes yet. Go online once so the whole catalogue is stored.`
      : 'No downloadable episodes are listed for this title.';
    return;
  }

  episodes.forEach((episode) => {
    const row = createEl('article', 'episode-row castle-episode');
    row.dataset.episode = String(episode.episode);

    const local = localFor(detail.activeSeason ?? state.castleSeason, episode.episode);

    // Saved Castle artwork is served by this app, not a CDN, so it works
    // offline too; only a missing row falls back to the local file's frame.
    const thumbSrc = episode.thumbnail || (local ? thumbUrl(local, 320) : '');
    if (thumbSrc) {
      const thumb = document.createElement('img');
      thumb.className = 'episode-thumb';
      if (local) {
        thumb.classList.add('is-playable');
        thumb.title = 'Play episode';
        thumb.tabIndex = 0;
        thumb.setAttribute('role', 'button');
        thumb.setAttribute('aria-label', `Play episode ${local.episode}`);
        thumb.addEventListener('click', () => goWatch(local.id));
        thumb.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            goWatch(local.id);
          }
        });
      }
      thumb.loading = 'lazy';
      thumb.alt = '';
      thumb.src = thumbSrc;
      thumb.addEventListener('error', () => thumb.remove());
      row.append(thumb);
    }

    const main = createEl('div', 'episode-main');
    const head = createEl('div', 'episode-head');
    head.append(createEl('span', 'episode-number', detail.type === 'series' ? `E${episode.episode}` : 'FILM'));
    head.append(createEl('strong', '', detail.type === 'series' ? episode.title : detail.title));
    main.append(head);

    const quality = (episode.resolutions || []).find((entry) => entry.resolution === selected)
      || (episode.quality && episode.quality.resolution === selected ? episode.quality : null);
    const job = local ? null : castleJobFor(detail, detail.activeSeason ?? state.castleSeason, episode.episode);
    const plan = local ? null : castlePlanFor(detail, episode.episode);
    const sub = local
      ? [
        local.episodeLabel || `S${String(local.season).padStart(2, '0')}E${String(local.episode).padStart(2, '0')}`,
        formatDuration(local.durationSec),
        formatSize(local.size),
      ].filter(Boolean).join(' · ')
      : [
        formatDuration(episode.duration),
        plan?.quality || (quality ? qualityName(quality.resolution) : 'Not available'),
        plan?.sizeBytes ? formatSize(plan.sizeBytes) : quality?.size ? formatSize(quality.size) : '',
        job && job.status === 'downloading' ? 'Downloading' : '',
      ].filter(Boolean).join(' · ');
    main.append(createEl('span', 'episode-date', sub));

    /* A failed job keeps its reason on the row: "Retry" alone hides why. */
    if (job && job.status === 'failed' && job.error) {
      main.append(createEl('span', 'episode-error', job.error));
    }

    if (local) {
      const progress = progressFor(local.id);
      if (progress && progress.d > 0 && progress.t > 5) {
        const bar = createEl('div', 'series-ep-bar castle-progress');
        const fill = document.createElement('i');
        fill.style.width = `${Math.round(Math.min(1, progress.t / progress.d) * 100)}%`;
        bar.append(fill);
        main.append(bar);
      }
      row.classList.add('is-local');
    }
    row.append(main);

    appendCastleAction(row, detail, episode, local, quality, plan);
    els.castleEpisodes.append(row);
  });

  const planSeason = detail.activeSeason ?? state.castleSeason ?? 0;
  if (state.offline) return;
  const planCached = state.castlePlanCache.get(castlePlanKey(detail, planSeason));
  if (planCached && Date.now() - planCached.at < CASTLE_PLAN_TTL) applyCastlePlan(detail, episodes);
  else loadCastlePlan(detail, episodes);
}

async function selectCastleSeason(season) {
  const detail = state.castleTitle;
  if (!detail || detail.type !== 'series' || state.castleBusy) return;
  if (Number(season) === Number(detail.activeSeason)) return;

  const token = ++state.castleSeasonToken;
  const cacheKey = `${detail.id}:${season}`;
  const cached = state.castleCache.get(cacheKey);

  const apply = (data) => {
    if (token !== state.castleSeasonToken) return;
    state.castleTitle = {
      ...detail,
      seasons: data.seasons,
      activeSeason: data.activeSeason,
      episodeCount: data.episodeCount,
    };
    state.castleSeason = data.activeSeason;
    renderCastleDownloads(state.castleTitle);
  };

  if (cached) {
    apply(cached);
    return;
  }

  els.castleStatus.textContent = `Loading season ${season}…`;
  els.castleEpisodes.replaceChildren(...castleSkeletonRows(4));
  if (!/^\d{6,20}$/.test(String(detail.id || ''))) {
    // Library preview is on screen before the catalog answered: switch tabs
    // from local data and let the catalog merge pick the season up.
    const preview = localSheetDetail(state.castleLocal?.group, season);
    if (preview) {
      state.castleSeason = preview.activeSeason;
      state.castleTitle = preview;
      renderCastleDownloads(preview);
    }
    return;
  }
  try {
    const data = await getCastleTitle(detail.id, { season });
    state.castleCache.set(cacheKey, data);
    apply(data);
  } catch (err) {
    if (token !== state.castleSeasonToken) return;
    els.castleStatus.textContent = `Could not load season ${season} (${err.message}).`;
  }
}

async function queueCastleEpisode(episode, btn) {
  const detail = state.castleTitle;
  if (!detail) return;
  if (state.offline) {
    toast('Go online to download.', { type: 'warn' });
    return;
  }
  const quality = (episode.resolutions || []).find((entry) => entry.resolution === CASTLE_RESOLUTION)
    || episode.quality
    || null;
  // A Torrentio plan is a download too, even when Castle lists no file.
  const plan = castlePlanFor(detail, episode.episode);

  const isSeries = detail.type === 'series';
  const label = isSeries
    ? `S${String(state.castleSeason).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`
    : detail.title;

  btn.disabled = true;
  btn.querySelector('span').textContent = 'Starting…';
  els.castleStatus.textContent = '';

  try {
    const result = await startCastleDownload({
      movieId: episode.movieId,
      episodeId: episode.episodeId,
      resolution: CASTLE_RESOLUTION,
      title: detail.title,
      year: detail.year,
      season: isSeries ? state.castleSeason : 0,
      episode: episode.episode,
      size: quality?.size || plan?.sizeBytes || 0,
      poster: detail.poster,
    });
    if (Array.isArray(result?.skipped) && result.skipped.length) {
      btn.classList.add('queued');
      btn.querySelector('span').textContent = 'In library';
      toast(`${label} is already in your library`);
      return;
    }
    const queuedQuality = result?.quality || qualityName(CASTLE_RESOLUTION);
    btn.classList.add('queued');
    btn.querySelector('span').textContent = 'Queued';
    toast(`${label} queued — ${queuedQuality}`);
    notify('start', label, `Queued — ${queuedQuality}${result?.source === 'torrentio' ? ' · Torrentio' : ''}`);
    openDownloads();
    refreshDownloads();
  } catch (err) {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Retry';
    btn.title = err.message;
    const message = `Could not queue ${label}: ${err.message}`;
    els.castleStatus.textContent = message;
    toast(message);
  }
}

/* "Download all" covers every season of the series, not just the open tab. */
async function queueCastleSeason() {
  const detail = state.castleTitle;
  if (!detail || detail.type !== 'series' || state.castleBusy) return;
  if (state.offline) {
    toast('Go online to download.', { type: 'warn' });
    return;
  }

  state.castleBusy = true;
  els.castleSeasonDownload.disabled = true;

  let all = castleCatalogEpisodes();
  if (!all.length) {
    // The sheet renders before the catalog arrives; pull it in now so
    // "Download all" still covers every season, not just the open tab.
    els.castleSeasonDownload.textContent = 'Loading episodes…';
    const group = state.castleLocal?.group;
    if (group?.seriesKey) {
      const catalog = state.seriesCatalog.get(group.seriesKey)
        || await getSeriesCatalog(group.seriesKey).catch(() => null);
      if (catalog) {
        state.seriesCatalog.set(group.seriesKey, catalog);
        state.castleCatalog = catalog;
        all = castleCatalogEpisodes();
      }
    }
    if (!all.length && /^\d{6,20}$/.test(String(detail.id || ''))) {
      const full = await getCastleSeriesEpisodes(detail.id).catch(() => null);
      if (full && Array.isArray(full.seasons)) state.castleCatalog = { seasons: full.seasons };
      all = castleCatalogEpisodes();
    }
  }
  const episodes = all.length ? all : castleEpisodesOf(detail).map((episode) => ({
    ...episode,
    season: detail.activeSeason ?? state.castleSeason,
  }));
  if (!episodes.length) {
    state.castleBusy = false;
    els.castleSeasonDownload.disabled = false;
    els.castleSeasonDownload.textContent = 'Download all';
    return;
  }

  state.castleBusy = true;
  els.castleSeasonDownload.disabled = true;
  els.castleStatus.textContent = '';
  let queued = 0;
  let skipped = 0;
  let torrentio = 0;
  let lastQuality = '';
  const localMap = seriesLocalEpisodes(detail);
  const localGroupMap = state.castleLocal?.local || null;

  for (let index = 0; index < episodes.length; index += 1) {
    const episode = episodes[index];
    // Episodes already on disk anywhere in the library do not need a second copy.
    if (localMap.has(`${episode.season}x${episode.episode}`)
      || (localGroupMap && localGroupMap.has(`${episode.season}x${episode.episode}`))) {
      skipped += 1;
      continue;
    }
    const current = castleJobFor(detail, episode.season, episode.episode);
    if (current && current.status !== 'failed') {
      skipped += 1;
      continue;
    }
    els.castleSeasonDownload.textContent = `Queueing ${index + 1}/${episodes.length}…`;
    // Every download from this sheet is 720p; use the matching catalog entry
    // for its size estimate when the catalog lists one.
    const quality = (episode.resolutions || []).find((entry) => entry.resolution === CASTLE_RESOLUTION)
      || episode.quality
      || null;
    // A Torrentio plan is a source too: "Download all" must not skip an episode
    // just because Castle has no 720p file for it.
    const planEntry = state.castlePlanCache.get(castlePlanKey(detail, episode.season));
    const plan = planEntry?.episodes?.get(Number(episode.episode)) || null;
    if (!quality && !plan?.quality) {
      skipped += 1;
      continue;
    }
    try {
      const result = await startCastleDownload({
        movieId: episode.movieId,
        episodeId: episode.episodeId,
        resolution: CASTLE_RESOLUTION,
        title: detail.title,
        year: detail.year,
        season: episode.season,
        episode: episode.episode,
        size: quality?.size || plan?.sizeBytes || 0,
        poster: detail.poster,
      });
      // The file was already on disk: the server queued nothing.
      if (Array.isArray(result?.skipped) && result.skipped.length) {
        skipped += 1;
        continue;
      }
      queued += 1;
      if (result?.source === 'torrentio') torrentio += 1;
      if (result?.quality) lastQuality = result.quality;
    } catch {
      skipped += 1;
    }
  }

  state.castleBusy = false;
  els.castleSeasonDownload.disabled = false;
  const summary = [
    queued ? `${queued} episode${queued === 1 ? '' : 's'} queued` : '',
    skipped ? `${skipped} already here or unavailable` : '',
  ].filter(Boolean).join(' · ') || 'Nothing was queued.';
  els.castleStatus.textContent = summary;

  if (queued) {
    const quality = lastQuality || qualityName(CASTLE_RESOLUTION);
    const mix = torrentio ? ` (${torrentio} Torrentio, ${queued - torrentio} Castle)` : '';
    toast(`${queued} episode${queued === 1 ? '' : 's'} queued${mix} — ${quality}`);
    notify('start', detail.title, `${queued} episode${queued === 1 ? '' : 's'} queued${mix} — ${quality}`);
    openDownloads();
  }
  await refreshDownloads();
  if (!els.castleModal.hidden && state.castleTitle) {
    // Re-rendering clears the status line, so put the summary back.
    renderCastleDownloads(state.castleTitle);
    els.castleStatus.textContent = summary;
  }
}

async function openCastleForTitle(title) {
  const name = String(title || '').trim();
  if (!name) return;
  const btn = els.onlineCastleBtn;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Looking up…';
  try {
    const data = await searchCastle(name);
    const results = Array.isArray(data.results) ? data.results : [];
    const match = results.find((entry) => entry.title.toLowerCase() === name.toLowerCase()) || results[0];
    if (!match) {
      toast(`No download found for “${name}”`);
      return;
    }
    closeOnlineModal();
    openCastleModal(match);
  } catch (err) {
    toast(`Could not reach the download catalog (${err.message})`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function closeCastleModal() {
  if (els.castleModal.hidden) return;
  els.castleModal.hidden = true;
  stopCastleTrailer();
  state.castleTitle = null;
  state.castleCatalog = null;
  state.castleSig = '';
  state.castleDetailToken += 1;
  state.castleSeasonToken += 1;
  state.castleBusy = false;
  resetCastleDeleteAll();
  syncBodyLock();
  castleFocusEl?.focus?.();
  if (state.view === 'home' && !isModalOpen()) {
    setupPreview(state.byId.get(state.heroId));
  }
}

/* ---------- modal ---------- */

function isModalOpen() {
  return !els.modal.hidden;
}

let modalItemId = null;
let seriesToken = 0;
let lastFocusEl = null;

function openModal(id) {
  const item = state.byId.get(id);
  if (!item) return;
  const groups = groupLibrary();
  const index = groupIndex(groups);
  const group = index.get(id) || item;
  const isSeries = Boolean(group.episodes && group.episodes.length);

  // A series opens the catalog sheet: show art, Resume, Download season and a
  // Play/Download button for every episode. Everything else keeps the library
  // detail panel.
  if (isSeries && group.seriesKey) {
    openSeriesSheet(group, id);
    return;
  }
  openLibraryModal(id);
}

/* ---------- series sheet (library + download catalog) ---------- */

function localEpisodesFor(group) {
  const map = new Map();
  for (const ep of group.episodes || []) map.set(`${ep.season}x${ep.episode}`, ep);
  return map;
}

/* After a delete the group's primary id can move to another episode, so look
 * the group up by its stable series key, not by id. The last local episode
 * leaves the sheet open but with an empty map, so every row becomes a
 * download row and "Delete all" disappears. */
function refreshCastleLocal() {
  const group = state.castleLocal?.group;
  if (!group) return;
  const fresh = groupLibrary().find((entry) => (group.seriesKey
    ? entry.seriesKey === group.seriesKey
    : entry.id === group.id));
  if (fresh) {
    state.castleLocal = { ...state.castleLocal, group: fresh, local: localEpisodesFor(fresh) };
  } else {
    state.castleLocal = {
      ...state.castleLocal,
      group: { ...group, episodes: [], ids: [] },
      local: new Map(),
    };
  }
}

/* The library already knows its own episodes, so draw them before the catalog
 * answers: Play buttons appear immediately instead of a long skeleton. */
function localSheetDetail(group, season) {
  const all = group.episodes || [];
  if (!group.isSeries || !all.length) return null;
  const seasons = [...new Set(all.map((ep) => ep.season))].sort((a, b) => a - b);
  const activeSeason = seasons.includes(Number(season)) ? Number(season) : seasons[0];
  const episodes = all
    .filter((ep) => ep.season === activeSeason)
    .sort((a, b) => a.episode - b.episode)
    .map((ep) => ({
      episode: ep.episode,
      season: ep.season,
      movieId: ep.id,
      episodeId: ep.id,
      thumbnail: thumbUrl(ep, 320),
      resolutions: [],
    }));
  return {
    id: group.id,
    type: 'series',
    title: group.title,
    activeSeason,
    seasons: seasons.map((value) => ({ season: value, episodes: value === activeSeason ? episodes : [] })),
    episodeCount: all.length,
    episodes,
  };
}

function resumeTarget(group) {
  let best = null;
  for (const ep of group.episodes || []) {
    const progress = progressFor(ep.id);
    if (!progress || progress.t <= 5 || progress.finished || !(progress.d > 0)) continue;
    const key = progress.updatedAt || 0;
    if (!best || key > best.key) best = { key, id: ep.id, episode: ep, progress };
  }
  return best;
}

/* Main button of the sheet: resume the episode in progress, otherwise play the
 * first episode on disk. Catalog-only titles have no local file, so no button. */
function castlePlayTarget() {
  const group = state.castleLocal?.group;
  if (!group) return null;
  const resume = resumeTarget(group);
  if (resume) {
    const ep = resume.episode;
    return {
      id: resume.id,
      label: `Resume S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`,
    };
  }
  if (group.episodes?.length) {
    const ep = primaryEpisode(group);
    return ep ? { id: ep.id, label: 'Play' } : null;
  }
  if (!state.byId.get(group.id)) return null;
  const progress = progressFor(group.id);
  return {
    id: group.id,
    label: progress && progress.t > 5 && !progress.finished ? 'Resume' : 'Play',
  };
}

/* The sheet uses the same picture as the card (the title's backdrop), not the
 * download catalog's background. The trailer covers it once it is ready. */
function populateSeriesHero(group, detail) {
  const img = els.castleBackdrop;
  img.onerror = () => {
    img.onerror = null;
    img.classList.remove('img-ready');
    setImg(img, heroImageUrl({ id: group.id }));
  };
  setImg(img, thumbUrl(group, 0));
  img.hidden = false;
  setCastleLogo(group);
  els.castleKicker.textContent = 'IN YOUR LIBRARY';
  els.castlePlot.textContent = group.plot
    || detail?.description
    || 'A title from your personal library, streamed directly from your drive.';
  els.castleModal.scrollTop = 0;

  const seasons = new Set((group.episodes || []).map((entry) => entry.season));
  const bits = [
    group.year,
    group.rating ? `★ ${Number(group.rating).toFixed(1)}` : '',
    `${group.episodes.length} episode${group.episodes.length === 1 ? '' : 's'}`,
    seasons.size > 1 ? `${seasons.size} seasons` : '',
    Array.isArray(group.genres) ? group.genres.slice(0, 3).join(' · ') : '',
  ].filter(Boolean);

  els.castleMeta.replaceChildren();
  bits.forEach((bit, index) => {
    if (index > 0) els.castleMeta.append(createEl('span', 'dot', '•'));
    els.castleMeta.append(createEl('span', index === 0 ? 'year' : '', bit));
  });
  updateCastleListButton(group);
}

/* Official wordmark for the sheet hero. Remotes fall back to the text title. */
function setCastleLogo(item) {
  const logo = els.castleLogo;
  const title = els.castleTitle;
  title.textContent = item?.title || '';
  logo.classList.remove('loaded');
  title.classList.remove('has-logo');
  logo.onload = () => {
    logo.classList.add('loaded');
    title.classList.add('has-logo');
  };
  logo.onerror = () => {
    logo.classList.remove('loaded');
    title.classList.remove('has-logo');
    logo.removeAttribute('src');
  };
  const src = item?.id ? logoUrl(item) : '';
  if (!src) {
    logo.removeAttribute('src');
    return;
  }
  if (logo.getAttribute('src') === src && logo.complete && logo.naturalWidth) {
    logo.classList.add('loaded');
    title.classList.add('has-logo');
    return;
  }
  logo.src = src;
}

/* The sheet trailer is the same cached file as the billboard. The server
 * resolves Netflix first, then Cinemeta, and reports when the MP4 is on disk.
 * The card picture holds for two seconds, then the video crossfades in with
 * sound; the mute button fades the volume instead of cutting it. */
const CASTLE_TRAILER_DELAY = 2000;
const CASTLE_TRAILER_VOLUME = 0.6;
const CASTLE_FADE_MS = 500;

function stopCastleVolumeFade() {
  if (state.castleVolumeTimer) clearTimeout(state.castleVolumeTimer);
  state.castleVolumeTimer = 0;
}

function fadeCastleVolume(target, done) {
  const video = els.castleTrailer;
  stopCastleVolumeFade();
  const from = Number.isFinite(video.volume) ? video.volume : 0;
  const to = Math.max(0, Math.min(1, target));
  const startedAt = performance.now();
  // A timer, not requestAnimationFrame: Chrome pauses rAF in a hidden window,
  // which used to leave the trailer silent at volume 0.
  const step = () => {
    const t = Math.min(1, (performance.now() - startedAt) / CASTLE_FADE_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    try { video.volume = from + (to - from) * eased; } catch { /* ignore */ }
    if (t < 1) {
      state.castleVolumeTimer = setTimeout(step, 16);
      return;
    }
    state.castleVolumeTimer = 0;
    if (done) done();
  };
  state.castleVolumeTimer = setTimeout(step, 16);
}

function syncCastleMute(blocked = false) {
  const muted = state.castleMuted;
  els.castleMute.classList.toggle('is-muted', muted);
  els.castleMute.classList.toggle('blocked', blocked && muted);
  const label = muted
    ? (blocked ? 'Sound blocked — click to hear the trailer' : 'Unmute trailer')
    : 'Mute trailer';
  els.castleMute.setAttribute('aria-label', label);
  els.castleMute.title = label;
}

function toggleCastleMute() {
  const video = els.castleTrailer;
  const nextMuted = !state.castleMuted;
  state.castleMuted = nextMuted;
  if (nextMuted) {
    fadeCastleVolume(0, () => {
      if (state.castleMuted) video.muted = true;
    });
  } else {
    video.muted = false;
    try { video.volume = 0; } catch { /* ignore */ }
    fadeCastleVolume(CASTLE_TRAILER_VOLUME);
  }
  syncCastleMute();
}

function stopCastleTrailer() {
  state.castleTrailerToken += 1;
  clearTimeout(state.castleTrailerTimer);
  state.castleTrailerTimer = null;
  clearTimeout(state.castleTrailerPlayTimer);
  state.castleTrailerPlayTimer = null;
  stopCastleVolumeFade();
  state.castlePausedForScroll = false;
  const video = els.castleTrailer;
  video.classList.remove('playing');
  els.castleModal.querySelector('.online-hero')?.classList.remove('is-playing');
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* ignore */ }
  try { video.volume = 0; } catch { /* ignore */ }
  video.muted = true;
  state.castleMuted = false;
  syncCastleMute();
}

function playCastleTrailer(url) {
  const video = els.castleTrailer;
  if (!url) return;
  video.src = url;
  video.muted = state.castleMuted;
  try { video.volume = 0; } catch { /* ignore */ }
  const attempt = (first) => {
    const playing = video.play();
    if (playing && typeof playing.catch === 'function') {
      playing.catch((err) => {
        if (err?.name !== 'NotAllowedError' || video.muted || !first) return;
        // Audible autoplay was blocked: keep the clip, but play it muted and
        // flag the mute button so the sound is one click away.
        state.castleMuted = true;
        video.muted = true;
        try { video.volume = 0; } catch { /* ignore */ }
        syncCastleMute(true);
        video.play().catch(() => {});
      });
    }
  };
  attempt(true);
}

function scheduleCastleTrailer(url, token) {
  if (state.castleTrailerPlayTimer) return;
  const wait = Math.max(0, (state.castleOpenedAt || 0) + CASTLE_TRAILER_DELAY - Date.now());
  state.castleTrailerPlayTimer = setTimeout(() => {
    state.castleTrailerPlayTimer = null;
    if (token !== state.castleTrailerToken || els.castleModal.hidden || !state.castleVisible) return;
    playCastleTrailer(url);
  }, wait);
}

function askCastleTrailer(item, token, deadline, source = 'local') {
  if (token !== state.castleTrailerToken || els.castleModal.hidden) return;
  // Library items use the trailer keyed by their local id; a catalog-only
  // title reads the saved Castle row and shares the trailer with a local copy
  // of the same show when one exists.
  const url = source === 'castle'
    ? `/api/castle/trailer/${encodeURIComponent(item.id)}`
    : `/api/trailer/${encodeURIComponent(item.id)}`;
  fetch(url, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (token !== state.castleTrailerToken || els.castleModal.hidden) return;
      if (data?.status === 'ready' && data.url) {
        scheduleCastleTrailer(data.url, token);
        return;
      }
      if (!data || data.status === 'failed' || data.status === 'none') return;
      if (Date.now() > deadline) return;
      state.castleTrailerTimer = setTimeout(() => askCastleTrailer(item, token, deadline, source), 1500);
    })
    .catch(() => {
      if (token !== state.castleTrailerToken || els.castleModal.hidden) return;
      if (Date.now() > deadline) return;
      state.castleTrailerTimer = setTimeout(() => askCastleTrailer(item, token, deadline, source), 2500);
    });
}

function startCastleTrailer(item, source = 'local') {
  stopCastleTrailer();
  state.castleOpenedAt = Date.now();
  if (!item?.id) return;
  askCastleTrailer(item, state.castleTrailerToken, Date.now() + 120000, source);
}

/* The sheet trailer follows the same rule as the billboard: scrolling down to
 * the episodes fades it out and pauses it, scrolling back fades it in again. */
function setCastleTrailerVisible(visible) {
  const video = els.castleTrailer;
  state.castleVisible = visible;
  if (!visible) {
    if (!video.src || video.paused) return;
    state.castlePausedForScroll = true;
    fadeCastleVolume(0, () => {
      if (state.castleVisible) return;
      try { video.pause(); } catch { /* ignore */ }
    });
    return;
  }
  if (!state.castlePausedForScroll) return;
  state.castlePausedForScroll = false;
  if (!video.src || els.castleModal.hidden || document.hidden) return;
  const playing = video.play();
  if (playing && typeof playing.then === 'function') {
    playing.then(() => {
      if (!state.castleMuted) fadeCastleVolume(CASTLE_TRAILER_VOLUME);
    }).catch(() => {});
  }
}

function bindCastleTrailer() {
  els.castleTrailer.addEventListener('playing', () => {
    els.castleTrailer.classList.add('playing');
    els.castleModal.querySelector('.online-hero')?.classList.add('is-playing');
    if (!state.castleMuted) fadeCastleVolume(CASTLE_TRAILER_VOLUME);
  });
  els.castleTrailer.addEventListener('error', () => {
    els.castleTrailer.classList.remove('playing');
    els.castleModal.querySelector('.online-hero')?.classList.remove('is-playing');
  });
  els.castleMute.addEventListener('click', toggleCastleMute);
}

/* Watch both hero video elements: the billboard scrolls with the window, the
 * sheet trailer scrolls inside the modal. IntersectionObserver keeps this to
 * one callback per threshold crossing instead of a scroll handler. */
function bindScrollPreviews() {
  const watch = (target, root, onChange) => {
    if (!target) return;
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        onChange(Boolean(last?.isIntersecting));
      }, { root: root || null, threshold: 0 });
      io.observe(target);
      return;
    }

    // Very old engines: fall back to geometry on scroll/resize.
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = target.getBoundingClientRect();
      const view = root
        ? root.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight || document.documentElement.clientHeight };
      onChange(box.bottom > view.top + 1 && box.top < view.bottom - 1);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };
    (root || window).addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    measure();
  };

  watch(els.heroVideo, null, setHeroPreviewVisible);
  watch(els.castleTrailer, els.castleModal, setCastleTrailerVisible);
}

function highlightSheetTarget() {
  const target = state.sheetTarget;
  state.sheetTarget = null;
  if (!target?.episode) return;
  const row = [...els.castleEpisodes.querySelectorAll('.castle-episode')]
    .find((el) => Number(el.dataset.episode) === target.episode);
  if (!row) return;
  row.classList.add('is-target');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function openSeriesSheet(group, focusId) {
  if (!els.searchOverlay.hidden) closeSearch();
  if (!els.onlineModal.hidden) closeOnlineModal();
  stopPreview();
  lastFocusEl = document.activeElement;
  castleFocusEl = lastFocusEl;
  modalItemId = group.id;

  const local = localEpisodesFor(group);
  state.castleLocal = { group, local, focusId };
  state.castleTitle = { type: 'series', title: group.title, seasons: [] };
  state.castleCatalog = null;
  state.castleSig = '';
  state.castleSeason = state.sheetTarget?.season
    || (state.byId.get(focusId)?.season)
    || group.episodes[0]?.season
    || 1;
  state.castleBusy = false;
  resetCastleDeleteAll();
  const token = ++state.castleDetailToken;

  els.castleModal.hidden = false;
  syncBodyLock();
  populateSeriesHero(group, null);
  startCastleTrailer(group);
  els.castleDownloadBlock.hidden = false;
  els.castleEpisodes.replaceChildren();
  els.castleSeasonTabs.replaceChildren();
  els.castleSeasonDownload.hidden = true;
  els.castleResume.hidden = true;
  els.castleStatus.hidden = false;
  renderCastleSkeleton();
  setTimeout(() => els.castleModal.querySelector('.modal-close')?.focus(), 40);

  // Draw the library's own episodes first; the catalog merge follows right after.
  const preview = localSheetDetail(group, state.castleSeason);
  if (preview) {
    state.castleTitle = preview;
    renderCastleDownloads(preview);
  }

  try {
    const catalog = state.seriesCatalog.get(group.seriesKey) || await getSeriesCatalog(group.seriesKey);
    state.seriesCatalog.set(group.seriesKey, catalog);
    state.castleCatalog = catalog;
    if (!catalog?.catalogId) throw new Error('series is not in the download catalog');
    const detail = await getCastleTitle(catalog.catalogId);
    if (token !== state.castleDetailToken) return;

    const merged = { ...detail, title: group.title, type: 'series', localGroup: group };
    state.castleTitle = merged;
    if (!(merged.seasons || []).some((entry) => entry.season === state.castleSeason)) {
      state.castleSeason = detail.activeSeason || 0;
    }
    state.castleCache.set(`${detail.id}:${detail.activeSeason || 0}`, detail);
    populateSeriesHero(group, detail);
    if (state.castleSeason !== detail.activeSeason
      && (merged.seasons || []).some((entry) => entry.season === state.castleSeason)) {
      // Open on the season the clicked episode belongs to; this renders too.
      await selectCastleSeason(state.castleSeason);
    } else {
      renderCastleDownloads(merged);
    }
    highlightSheetTarget();
  } catch (err) {
    if (token !== state.castleDetailToken) return;
    // The catalog is optional. Offline mode, an unknown show or a catalog
    // error must not swap this sheet for the old library panel: keep the same
    // layout and show the episodes that are on disk.
    const fallback = localSheetDetail(group, state.castleSeason) || preview;
    state.castleTitle = fallback || { ...state.castleTitle, seasons: [], episodes: [] };
    state.castleSeason = fallback?.activeSeason || state.castleSeason;
    state.castleCatalog = null;
    clearCastleSkeleton();
    els.castleModal.hidden = false;
    syncBodyLock();
    populateSeriesHero(group, null);
    renderCastleDownloads(state.castleTitle);
    // Download-only controls have nothing to act on without the catalog.
    els.castleSeasonDownload.hidden = true;
    els.castleStatus.textContent = state.offline
      ? 'Offline mode - showing the episodes on your drive.'
      : `Download catalog unavailable (${err.message}) - showing the episodes on your drive.`;
    els.castleStatus.hidden = false;
  }
}

function openLibraryModal(id) {
  const item = state.byId.get(id);
  if (!item) return;
  const groups = groupLibrary();
  const index = groupIndex(groups);
  const group = index.get(id) || item;
  const isSeries = Boolean(group.episodes && group.episodes.length);
  const episode = isSeries ? (group.episodes.find((entry) => entry.id === id) || primaryEpisode(group)) : group;

  if (!els.searchOverlay.hidden) closeSearch();
  stopPreview();
  lastFocusEl = document.activeElement;
  modalItemId = group.id;
  state.modalPlayId = episode.id;
  state.seriesSeason = episode.season || (group.episodes?.[0]?.season) || 0;
  els.modal.hidden = false;
  syncBodyLock();
  els.modal.scrollTop = 0;
  setImg(els.modalImg, thumbUrl(group, 960));
  els.modalImg.alt = group.title;
  els.modalTitle.textContent = group.title;

  els.modalMeta.replaceChildren();
  const seasons = isSeries ? [...new Set(group.episodes.map((entry) => entry.season))].sort((a, b) => a - b) : [];
  const metaBits = isSeries
    ? [
      group.year,
      `${group.episodes.length} episode${group.episodes.length === 1 ? '' : 's'}`,
      seasons.length > 1 ? `${seasons.length} seasons` : null,
      qualityLabel(episode),
    ].filter(Boolean)
    : [group.year, formatDuration(group.durationSec), qualityLabel(group)].filter(Boolean);
  metaBits.forEach((bit, i) => {
    if (i > 0) els.modalMeta.append(createEl('span', 'dot', '•'));
    els.modalMeta.append(createEl('span', i === 0 ? 'year' : '', bit));
  });
  if (group.rating) els.modalMeta.append(createEl('span', 'chip', group.rating));
  if (group.genres?.length) els.modalMeta.append(createEl('span', '', group.genres.slice(0, 3).join(' · ')));

  els.modalPlot.textContent = group.plot
    || `A title from your personal library, streamed directly from your drive. ${group.genres?.length ? `Genres: ${group.genres.join(', ')}.` : ''}`.trim();

  els.modalSide.replaceChildren();
  els.modalSide.append(createEl('h3', '', 'Details'));
  const dl = document.createElement('dl');
  const totalSize = isSeries ? group.episodes.reduce((sum, entry) => sum + (entry.size || 0), 0) : group.size;
  const details = isSeries
    ? [
      ['Folder', group.collection],
      ['Seasons', String(seasons.length)],
      ['Episodes', String(group.episodes.length)],
      ['Resolution', episode.width && episode.height ? `${episode.width} × ${episode.height}` : 'Unknown'],
      ['Video', episode.videoCodec ? episode.videoCodec.toUpperCase() : 'Unknown'],
      ['Audio', episode.audioCodec ? episode.audioCodec.toUpperCase() : 'Unknown'],
      ['Size', formatSize(totalSize) || 'Unknown'],
      ['Added', new Date(group.mtime).toLocaleDateString()],
    ]
    : [
      ['File', group.fileName],
      ['Folder', group.collection],
      ['Resolution', group.width && group.height ? `${group.width} × ${group.height}` : 'Unknown'],
      ['Video', group.videoCodec ? group.videoCodec.toUpperCase() : 'Unknown'],
      ['Audio', group.audioCodec ? group.audioCodec.toUpperCase() : 'Unknown'],
      ['Size', formatSize(group.size) || 'Unknown'],
      ['Added', new Date(group.mtime).toLocaleDateString()],
    ];
  for (const [k, v] of details) {
    if (!v) continue;
    dl.append(createEl('dt', '', k), createEl('dd', '', v));
  }
  els.modalSide.append(dl);

  updateModalPlayLabel(episode);
  updateModalListButton(group);
  renderSeriesBlock(group);
  if (isSeries) hydrateSeries(group);
  if (isSeries) hydrateSeriesCatalog(group);
  renderMore(group);
  setTimeout(() => document.querySelector('.modal-close')?.focus(), 40);
}

function renderSeriesBlock(group) {
  const episodes = group.episodes || [];
  if (!group.isSeries || !episodes.length) {
    els.seriesBlock.hidden = true;
    els.seriesSeasons.replaceChildren();
    els.seriesEpisodes.replaceChildren();
    return;
  }
  els.seriesBlock.hidden = false;

  const catalog = seriesCatalogFor(group);
  const localSeasons = [...new Set(episodes.map((entry) => entry.season))];
  const catalogSeasons = catalog
    ? catalog.seasons.map((entry) => entry.season).filter((season) => season > 0)
    : [];
  const seasons = [...new Set([...localSeasons, ...catalogSeasons])].sort((a, b) => a - b);
  if (!seasons.includes(state.seriesSeason)) state.seriesSeason = seasons[0];
  els.seriesSeasons.replaceChildren();
  for (const season of seasons) {
    const btn = createEl('button', 'season-tab', `Season ${season}`);
    btn.type = 'button';
    btn.classList.toggle('active', season === state.seriesSeason);
    btn.addEventListener('click', () => {
      state.seriesSeason = season;
      renderSeriesBlock(group);
    });
    els.seriesSeasons.append(btn);
  }
  const findingMore = Boolean(group.seriesKey && state.seriesCatalogLoading.has(group.seriesKey));
  if (findingMore) els.seriesSeasons.append(skel('sk-pill'));
  els.seriesFind.classList.toggle('is-skeleton', findingMore);
  els.seriesFind.disabled = state.offline;
  els.seriesFind.textContent = state.offline ? 'Go online to find more' : 'Find more episodes';
  renderSeriesEpisodes(episodes, group);
}

function seriesCatalogFor(group) {
  if (!group?.seriesKey) return null;
  const data = state.seriesCatalog.get(group.seriesKey);
  return data && Array.isArray(data.seasons) ? data : null;
}

/* One row per episode: a file on disk plays, a catalog-only episode downloads. */
function renderSeriesEpisodes(episodes, group) {
  els.seriesEpisodes.replaceChildren();
  const season = state.seriesSeason;
  const local = episodes
    .filter((entry) => entry.season === season)
    .sort((a, b) => a.episode - b.episode);
  const catalog = seriesCatalogFor(group);
  const catalogEpisodes = catalog?.seasons.find((entry) => entry.season === season)?.episodes || [];
  const localByNumber = new Map(local.map((entry) => [entry.episode, entry]));

  const rows = [];
  for (const entry of catalogEpisodes) {
    rows.push({ number: entry.episode, local: localByNumber.get(entry.episode) || null, catalog: entry });
  }
  for (const entry of local) {
    if (!catalogEpisodes.some((other) => other.episode === entry.episode)) {
      rows.push({ number: entry.episode, local: entry, catalog: null });
    }
  }
  rows.sort((a, b) => a.number - b.number);

  const findingMore = Boolean(group?.seriesKey && state.seriesCatalogLoading.has(group.seriesKey));
  if (!rows.length && !findingMore) {
    els.seriesEpisodes.append(createEl('p', 'series-empty', 'No episodes on disk for this season.'));
    return;
  }

  for (const row of rows) {
    if (row.local) els.seriesEpisodes.append(seriesEpisodeRow(row.local, group));
    else els.seriesEpisodes.append(catalogEpisodeRow(row.catalog, group));
  }
  // The download catalog is still answering: more episodes may appear below.
  if (findingMore) els.seriesEpisodes.append(...skelEpisodes(2));
}

function seriesEpisodeRow(raw, group) {
  const ep = state.byId.get(raw.id) || raw;
  const row = createEl('article', 'episode-row series-episode');
  const img = document.createElement('img');
  img.className = 'episode-thumb series-ep-thumb';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.src = thumbUrl(ep, 320);
  img.addEventListener('error', () => img.remove());

  const info = createEl('div', 'series-ep-info');
  const label = ep.episodeLabel || `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
  info.append(createEl('span', 'series-ep-label', label));
  info.append(createEl('strong', 'series-ep-name', `Episode ${ep.episode}`));
  const bits = [formatDuration(ep.durationSec), formatSize(ep.size), qualityLabel(ep)].filter(Boolean);
  info.append(createEl('span', 'series-ep-meta', bits.join(' · ')));
  const progress = progressFor(ep.id);
  if (progress && !progress.finished && progress.t > 5 && progress.d > 0) {
    const bar = createEl('div', 'series-ep-bar');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(Math.min(1, progress.t / progress.d) * 100)}%`;
    bar.append(fill);
    info.append(bar);
  }

  const play = createEl('button', 'series-ep-play');
  play.type = 'button';
  play.setAttribute('aria-label', `Play episode ${ep.episode}`);
  play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg><span>Play</span>';
  play.addEventListener('click', () => goWatch(ep.id));

  row.append(img, info, play);
  if (ep.id === state.modalPlayId) row.classList.add('current');
  return row;
}

function catalogEpisodeRow(entry, group) {
  const row = createEl('article', 'episode-row series-episode is-remote');
  const img = document.createElement('img');
  img.className = 'episode-thumb series-ep-thumb';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  if (entry.thumbnail && !state.offline) {
    img.src = entry.thumbnail;
    img.addEventListener('error', () => img.remove());
  } else {
    img.remove();
  }

  const season = state.seriesSeason;
  const label = `S${String(season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`;
  const info = createEl('div', 'series-ep-info');
  info.append(createEl('span', 'series-ep-label', label));
  info.append(createEl('strong', 'series-ep-name', `Episode ${entry.episode}`));
  const bits = [
    formatDuration(entry.duration),
    entry.quality?.label || '',
    entry.quality?.size ? formatSize(entry.quality.size) : '',
  ].filter(Boolean);
  info.append(createEl('span', 'series-ep-meta', bits.join(' · ')));

  const btn = createEl('button', 'series-ep-play series-ep-download');
  btn.type = 'button';
  btn.setAttribute('aria-label', `Download episode ${entry.episode}`);
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg><span>Download</span>';

  const queuedKey = `${group.seriesKey}:${season}x${entry.episode}`;
  if (state.queuedEpisodes.has(queuedKey)) {
    btn.disabled = true;
    btn.classList.add('queued');
    btn.querySelector('span').textContent = 'Queued';
  } else if (!entry.quality) {
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Unavailable';
  } else {
    btn.addEventListener('click', () => queueSeriesEpisode(group, entry, season, btn));
  }

  row.append(img, info, btn);
  return row;
}

async function queueSeriesEpisode(group, entry, season, btn) {
  if (!entry.quality) return;
  const label = `S${String(season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`;
  const title = group.seriesTitle || group.title;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Starting…';
  try {
    const result = await startCastleDownload({
      movieId: entry.movieId,
      episodeId: entry.episodeId,
      resolution: entry.quality.resolution,
      title,
      year: group.year,
      season,
      episode: entry.episode,
      size: entry.quality.size,
      poster: seriesCatalogFor(group)?.poster || '',
    });
    state.queuedEpisodes.add(`${group.seriesKey}:${season}x${entry.episode}`);
    btn.classList.add('queued');
    btn.querySelector('span').textContent = 'Queued';
    const quality = result?.quality || entry.quality.label;
    const sourceNote = result?.source === 'torrentio' ? ' · Torrentio' : '';
    toast(`${title} ${label} queued${quality ? ` — ${quality}${sourceNote}` : ''}`);
    notify('start', `${title} ${label}`, 'Queued for download');
    openDownloads();
    refreshDownloads();
  } catch (err) {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Retry';
    toast(`Could not queue ${label}: ${err.message}`, { type: 'warn' });
  }
}

/* Episodes from the download catalog, merged into the modal for missing files. */
async function hydrateSeriesCatalog(group) {
  if (!group?.seriesKey || state.offline) return;
  const key = group.seriesKey;
  if (state.seriesCatalog.has(key) || state.seriesCatalogLoading.has(key)) return;
  state.seriesCatalogLoading.add(key);
  if (modalItemId === group.id) renderSeriesBlock(group); // draws the loading rows
  try {
    const data = await getSeriesCatalog(key);
    state.seriesCatalog.set(key, data);
    state.seriesCatalogLoading.delete(key);
    if (modalItemId === group.id && state.seriesCatalog.size) renderSeriesBlock(group);
  } catch {
    /* offline, unknown title, or older server: keep local episodes */
    state.seriesCatalogLoading.delete(key);
    if (modalItemId === group.id) renderSeriesBlock(group);
  } finally {
    state.seriesCatalogLoading.delete(key);
  }
}

/* The local grouping is already complete; the API confirms it for rescan/quality changes. */
async function hydrateSeries(group) {
  if (!group.seriesKey || !group.episodes) return;
  const token = ++seriesToken;
  try {
    const data = await getSeries(group.seriesKey);
    if (token !== seriesToken || modalItemId !== group.id) return;
    const episodes = (data.seasons || [])
      .flatMap((season) => season.episodes || [])
      .map((entry) => state.byId.get(entry.id) || entry)
      .filter(Boolean);
    if (!episodes.length) return;
    const before = group.episodes.map((entry) => entry.id).join(',');
    group.episodes = dedupeEpisodes(episodes);
    group.seasons = [...new Set(group.episodes.map((entry) => entry.season))].sort((a, b) => a - b);
    group.episodeCount = group.episodes.length;
    const after = group.episodes.map((entry) => entry.id).join(',');
    if (before !== after) renderSeriesBlock(group);
  } catch {
    /* offline or older server: keep the locally grouped episodes */
  }
}

function updateModalPlayLabel(item) {
  const p = progressFor(item.id);
  const resume = p && !p.finished && p.t > 5;
  const label = item.episodeLabel ? `${item.episodeLabel} · ` : '';
  els.modalPlayLabel.textContent = resume ? `Resume ${label}${formatClock(p.t)}` : 'Play';
}

function updateModalListButton(item) {
  const inList = isInMyList(item.id);
  // SVGElement has no hidden IDL property, so toggle the attribute itself.
  els.modalList.querySelector('.i-plus').toggleAttribute('hidden', inList);
  els.modalList.querySelector('.i-check').toggleAttribute('hidden', !inList);
  els.modalList.title = inList ? 'Remove from Favourite' : 'Add to Favourite';
  els.modalList.classList.toggle('in-list', inList);
}

function renderMore(item) {
  els.moreGrid.replaceChildren();
  const groups = groupLibrary();
  let pool = groups.filter((other) => other.id !== item.id && (
    other.collection === item.collection
    || (other.genres || []).some((g) => (item.genres || []).includes(g))
  ));
  if (pool.length < 3) {
    const seen = new Set(pool.map((other) => other.id));
    pool = pool.concat(groups.filter((other) => other.id !== item.id && !seen.has(other.id)));
  }
  pool.slice(0, 6).forEach((other) => els.moreGrid.append(buildCard(other)));
}

function closeModal() {
  if (!isModalOpen()) return;
  els.modal.hidden = true;
  modalItemId = null;
  state.modalPlayId = null;
  seriesToken += 1;
  els.seriesBlock.hidden = true;
  syncBodyLock();
  lastFocusEl?.focus?.();
  if (state.view === 'home') {
    setupPreview(state.byId.get(state.heroId));
  }
}

/* ---------- actions ---------- */

function goWatch(id) {
  const item = state.byId.get(id);
  if (!item) return;
  closeSearch();
  fadeOut(() => {
    location.href = `/watch?id=${encodeURIComponent(id)}`;
  });
}

async function rescan() {
  if (state.rescanning) return;
  state.rescanning = true;
  toast('Scanning library…');
  try {
    const result = await rescanLibrary();
    await loadLibrary();
    toast(`Library updated — ${result.count} title${result.count === 1 ? '' : 's'}`);
    notify('info', 'Library updated', `${result.count} title${result.count === 1 ? '' : 's'} in your library`);
  } catch {
    toast('Scan failed. Check the library folder and try again.');
  } finally {
    state.rescanning = false;
    updateLoadingState();
    schedulePoll();
  }
}

/* Top-bar Sync: refreshes the Castle data and pictures already saved in
 * catalog.db. It never scans the library; that stays on the empty-state
 * button. Progress is polled until the server worker finishes. */
async function syncCastle() {
  if (state.syncing) return;
  if (state.offline) {
    toast('Offline mode is on — Sync needs internet.');
    return;
  }
  state.syncing = true;
  els.refreshBtn.classList.add('spinning');
  els.refreshBtn.disabled = true;
  toast('Syncing saved catalog…');
  try {
    await syncCastleCatalog();
    let status = null;
    const deadline = Date.now() + 10 * 60 * 1000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 900));
      status = await getCastleSyncStatus();
      if (status.total) {
        els.refreshBtn.title = `Syncing ${status.done}/${status.total}`;
      }
    } while (status.running && Date.now() < deadline);

    if (!status) throw new Error('no progress reported');
    const parts = [];
    if (status.updated) parts.push(`${status.updated} updated`);
    if (status.kept) parts.push(`${status.kept} unchanged`);
    if (status.images) parts.push(`${status.images} new picture${status.images === 1 ? '' : 's'}`);
    if (status.trailers) parts.push(`${status.trailers} trailer${status.trailers === 1 ? '' : 's'} queued`);
    if (status.errors) parts.push(`${status.errors} failed`);
    toast(parts.length ? `Catalog synced — ${parts.join(', ')}` : 'Catalog synced.');
    if (state.castleTitle?.provider === 'castle') {
      // The open sheet still shows the pre-sync copy; reload it from the row.
      const item = state.castleTitle;
      const token = state.castleDetailToken;
      getCastleTitle(item.id).then((detail) => {
        if (token !== state.castleDetailToken || els.castleModal.hidden) return;
        const merged = { ...item, ...detail };
        state.castleTitle = merged;
        populateCastleModal(merged);
        renderCastleDownloads(merged);
      }).catch(() => { /* the saved row is still on screen */ });
    }
  } catch (err) {
    toast(err.offline ? 'Offline mode is on — Sync needs internet.' : `Sync failed: ${err.message}`);
  } finally {
    state.syncing = false;
    els.refreshBtn.classList.remove('spinning');
    els.refreshBtn.disabled = false;
    els.refreshBtn.title = 'Sync catalog';
    els.refreshBtn.setAttribute('aria-label', 'Sync catalog');
  }
}

/* ---------- notifications ---------- */

const NOTIF_KEY = 'netflix-home:notifications';
const NOTIF_ICONS = {
  done: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12 5 5 9-10"/></svg>',
  fail: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="16.5" r=".6" fill="currentColor"/></svg>',
  start: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none"/></svg>',
};

function loadNotifs() {
  const list = readJson(NOTIF_KEY, null);
  if (Array.isArray(list)) return list;
  return [{ id: 'welcome', type: 'info', title: 'Welcome', text: 'Download progress, finished titles and library updates will show up here.', time: Date.now(), read: false }];
}

function saveNotifs() { writeJson(NOTIF_KEY, state.notifs.slice(0, 30)); }

function notify(type, title, text, extra = {}) {
  state.notifs.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, title, text: text || '', time: Date.now(), read: false, ...extra });
  state.notifs = state.notifs.slice(0, 30);
  saveNotifs();
  renderNotifs();
  els.bellBtn.classList.remove('ring');
  void els.bellBtn.offsetWidth;
  els.bellBtn.classList.add('ring');
}

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'Just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* A notification only stores text, so find the library title it belongs to:
 * by file name, by exact title, or by the "Series S01E02" label the download
 * queue produces. The result feeds the thumbnail in the bell menu. */
function notifMatch(n) {
  const items = state.items || [];
  if (!items.length) return null;
  const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const fileName = norm(n.fileName);
  if (fileName) {
    const byFile = items.find((it) => norm(it.fileName) === fileName);
    if (byFile) return byFile;
  }

  const title = norm(n.title);
  if (!title) return null;
  const exact = items.find((it) => norm(it.seriesTitle) === title || norm(it.title) === title);
  if (exact) return exact;

  const tag = /s(\d{1,2})\s*e(\d{1,2})\b/i.exec(n.title || '');
  const seriesName = norm(tag ? String(n.title).slice(0, tag.index) : title).replace(/[\s·\-–—]+$/, '');
  if (!seriesName || seriesName.length < 3) return null;
  const episodes = items.filter((it) => it.isSeries && norm(it.seriesTitle || it.title) === seriesName);
  if (episodes.length) {
    if (!tag) return episodes[0];
    const season = Number(tag[1]);
    const episode = Number(tag[2]);
    return episodes.find((it) => it.season === season && it.episode === episode) || episodes[0];
  }

  // Longest prefix wins, so "Cyberpunk Edgerunners S01E02 720p" finds the show.
  let best = null;
  for (const item of items) {
    const name = norm(item.seriesTitle || item.title);
    if (name.length < 3 || !title.startsWith(name)) continue;
    if (!best || name.length > norm(best.seriesTitle || best.title).length) best = item;
  }
  return best;
}

function renderNotifs() {
  const unread = state.notifs.filter((n) => !n.read).length;
  els.notifBadge.hidden = unread === 0;
  els.notifBadge.textContent = unread > 9 ? '9+' : String(unread);
  els.notifList.replaceChildren();
  els.notifEmpty.hidden = state.notifs.length > 0;
  state.notifs.forEach((n) => {
    const row = createEl('div', `notif-item${n.read ? '' : ' unread'}`);
    const ico = createEl('div', `notif-ico t-${n.type}`);
    const match = notifMatch(n);
    if (match) {
      const img = document.createElement('img');
      img.src = thumbUrl(match, 240);
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { img.remove(); ico.innerHTML = NOTIF_ICONS[n.type] || NOTIF_ICONS.info; };
      ico.append(img);
      ico.classList.add('has-art');
    } else {
      ico.innerHTML = NOTIF_ICONS[n.type] || NOTIF_ICONS.info;
    }
    const body = createEl('div', 'notif-body');
    body.append(createEl('div', 'notif-title', n.title), createEl('div', 'notif-text', n.text), createEl('div', 'notif-time', timeAgo(n.time)));
    row.append(ico, body);
    els.notifList.append(row);
  });
}

function openNotifs() {
  closeProfile();
  renderNotifs();
  els.notifMenu.hidden = false;
  els.bellBtn.setAttribute('aria-expanded', 'true');
}

function closeNotifs() {
  if (els.notifMenu.hidden) return;
  els.notifMenu.hidden = true;
  els.bellBtn.setAttribute('aria-expanded', 'false');
  if (state.notifs.some((n) => !n.read)) {
    state.notifs.forEach((n) => { n.read = true; });
    saveNotifs();
    renderNotifs();
  }
}

function bindNotifs() {
  state.notifs = loadNotifs();
  renderNotifs();
  els.bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (els.notifMenu.hidden) openNotifs(); else closeNotifs();
  });
  els.notifRead.addEventListener('click', () => {
    state.notifs.forEach((n) => { n.read = true; });
    saveNotifs();
    renderNotifs();
  });
  els.notifClear.addEventListener('click', () => {
    state.notifs = [];
    saveNotifs();
    renderNotifs();
  });
  document.addEventListener('click', (e) => { if (!els.notif.contains(e.target)) closeNotifs(); });
  setInterval(() => { if (!els.notifMenu.hidden) renderNotifs(); }, 30000);
}

const TOAST_ICONS = {
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".9" fill="currentColor" stroke="none"/></svg>',
  done: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4 3 20h18z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none"/></svg>',
  fail: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="16.5" r=".7" fill="currentColor"/></svg>',
};

function inferToastType(message) {
  const text = String(message || '');
  if (/fail|could not|couldn't|error|unable|not found|no longer/i.test(text)) return 'fail';
  if (/cancel|offline|paused|blocked|try again/i.test(text)) return 'warn';
  if (/added|saved|removed|complete|finished|updated|downloaded|ready|done|library/i.test(text)) return 'done';
  return 'info';
}

function toast(message, { type, title } = {}) {
  const el = els.toast;
  clearTimeout(state.toastTimer);
  clearTimeout(state.toastExitTimer);
  const kind = type || inferToastType(message);
  el.dataset.type = kind;
  el.replaceChildren();

  const ico = createEl('div', 'toast-ico');
  ico.innerHTML = TOAST_ICONS[kind] || TOAST_ICONS.info;
  const body = createEl('div', 'toast-body');
  if (title) body.append(createEl('div', 'toast-title', title));
  body.append(createEl('div', 'toast-msg', String(message ?? '')));
  const close = createEl('button', 'toast-x', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  const bar = createEl('div', 'toast-progress');

  el.append(ico, body, close, bar);
  el.hidden = false;
  el.classList.remove('is-out');
  el.classList.remove('is-in');
  void el.offsetWidth;
  el.classList.add('is-in');

  const dismiss = () => {
    clearTimeout(state.toastTimer);
    el.classList.remove('is-in');
    el.classList.add('is-out');
    state.toastExitTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('is-out');
    }, 220);
  };
  close.addEventListener('click', dismiss, { once: true });
  state.toastTimer = setTimeout(dismiss, 4200);
}

/* ---------- events ---------- */

function bindStaticEvents() {
  bindNotifs();
  bindCastleTrailer();
  bindScrollPreviews();
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const view = link.dataset.view;
      if (view === 'home') showHome();
      else if (view === 'local') showLocal();
      else if (view === 'favourite') showFavourite();
      else if (view === 'online') showOnline();
    });
  });

  document.querySelectorAll('.mobile-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.mview;
      if (view === 'home') showHome();
      else if (view === 'online') showOnline();
      else if (view === 'local') showLocal();
      else if (view === 'favourite') showFavourite();
      else if (view === 'search') openSearch();
    });
  });

  window.addEventListener('scroll', () => {
    els.nav.classList.toggle('scrolled', window.scrollY > 50);
  }, { passive: true });

  els.heroPlay.addEventListener('click', () => {
    const id = state.heroPlayId || state.heroId;
    if (id) goWatch(id);
  });
  els.heroInfo.addEventListener('click', () => {
    if (state.heroId) openModal(state.heroId);
  });
  /* The picture itself is a skip target while the preview runs; the hero's own
   * buttons keep their behaviour. */
  els.hero.addEventListener('click', (e) => {
    if (!els.heroVideo.classList.contains('playing')) return;
    if (e.target.closest('button, a, input, label')) return;
    skipPreview();
  });
  els.heroMute.addEventListener('click', () => {
    const video = els.heroVideo;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    state.previewMuted = nextMuted;
    writeJson(PREVIEW_MUTED_KEY, nextMuted);
    if (!nextMuted) {
      if (!video.volume) video.volume = HERO_PREVIEW_VOLUME;
      video.volume = Math.max(video.volume, 0.2);
    }
    syncHeroMute(false);
    const item = state.byId.get(state.heroId);
    if (!video.src && item) playPreview(item);
    else if (video.paused && item && !state.heroPausedForScroll) video.play().catch(() => {});
  });

  els.offlineBtn.addEventListener('click', toggleOffline);

  els.searchBtn.addEventListener('click', openSearch);
  els.searchClose.addEventListener('click', closeSearch);
  els.searchInput.addEventListener('input', (e) => runSearch(e.target.value));
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    rememberSearch(els.searchInput.value);
    els.searchHistory.hidden = true;
  });
  els.searchInput.addEventListener('focus', () => {
    if (!els.searchInput.value.trim()) renderSearchHistory();
  });
  els.searchHistory.addEventListener('click', (e) => {
    const remove = e.target.closest('.history-remove');
    if (remove) {
      e.stopPropagation();
      removeSearchHistory(remove.dataset.remove);
      return;
    }
    const pick = e.target.closest('.history-query');
    if (!pick) return;
    els.searchInput.value = pick.dataset.q;
    els.searchHistory.hidden = true;
    runSearch(pick.dataset.q);
    els.searchInput.focus();
  });
  els.searchOverlay.addEventListener('click', (e) => {
    if (e.target === els.searchOverlay) closeSearch();
  });
  els.searchResults.addEventListener('click', () => closeSearch());
  els.searchCastleResults.addEventListener('click', () => closeSearch());
  els.searchOnlineResults.addEventListener('click', () => closeSearch());

  els.onlineShuffle.addEventListener('click', () => {
    state.onlineMode = 'random';
    renderOnlineFilters();
    loadOnlineBrowse({ fresh: true });
  });

  els.onlineModes.addEventListener('click', (e) => {
    const button = e.target.closest('[data-online-mode]');
    if (!button) return;
    const mode = button.dataset.onlineMode;
    if (!mode || mode === state.onlineMode) return;
    state.onlineMode = mode;
    renderOnlineFilters();
    loadOnlineBrowse({ fresh: true });
  });

  els.onlineGenres.addEventListener('click', (e) => {
    const button = e.target.closest('[data-online-genre]');
    if (!button) return;
    const genre = button.dataset.onlineGenre || '';
    if (genre === state.onlineGenre) return;
    state.onlineGenre = genre;
    renderOnlineFilters();
    loadOnlineBrowse({ fresh: true });
  });

  els.downloadsBtn.addEventListener('click', openDownloads);
  els.dlClear.addEventListener('click', async () => {
    // "Clear finished" is about completed rows only. Failed ones keep their
    // partial files until X explicitly deletes them.
    const done = state.downloads.filter((j) => j.status === 'completed');
    await Promise.allSettled(done.map((j) => cancelDownload(j.id)));
    dismissJobs(done.map((j) => j.id));
    renderDownloads();
  });
  els.downloadsPanel.querySelectorAll('[data-close-downloads]').forEach((el) => {
    el.addEventListener('click', closeDownloads);
  });

  els.modal.querySelectorAll('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));
  els.onlineModal.querySelectorAll('[data-close-online]').forEach((el) => el.addEventListener('click', closeOnlineModal));
  els.castleModal.querySelectorAll('[data-close-castle]').forEach((el) => el.addEventListener('click', closeCastleModal));
  els.settingsModal.querySelectorAll('[data-close-settings]').forEach((el) => el.addEventListener('click', closeSettings));
  els.castleFallbackBtn.addEventListener('click', toggleCastleFallback);
  els.autoplaySoundBtn.addEventListener('click', toggleAutoplaySound);
  els.dlMaxActiveSave.addEventListener('click', saveDownloadMaxActive);
  els.dlSpeedSave.addEventListener('click', saveDownloadSpeedLimit);
  els.dlMaxActiveInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveDownloadMaxActive(); }
  });
  els.dlSpeedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveDownloadSpeedLimit(); }
  });
  /* The cap belongs where the queue is: one click from the Downloads drawer
   * opens the same sheet with the two fields in view. */
  els.dlSettings.addEventListener('click', () => {
    closeDownloads();
    openSettings();
    setTimeout(() => els.dlMaxActiveInput.focus(), 120);
  });
  els.libraryRootSave.addEventListener('click', saveLibraryRoot);
  els.libraryRootInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveLibraryRoot();
    }
  });
  els.libraryRestartBtn.addEventListener('click', restartLibraryApp);
  els.castleSeasonDownload.addEventListener('click', queueCastleSeason);
  bindCastleDeleteAll();
  els.castleList.addEventListener('click', toggleCastleList);
  els.castleResume.addEventListener('click', () => {
    const target = castlePlayTarget();
    if (target) { goWatch(target.id); return; }
    const all = els.castleSeasonDownload;
    const one = els.castleEpisodes.querySelector('.castle-dl-btn:not(:disabled):not(.queued):not(.is-paused):not(.is-play):not(.is-active)');
    if (!all.hidden && !all.disabled) all.click();
    else if (one) one.click();
    else toast('Nothing available to download yet');
  });
  els.castlePlot.addEventListener('click', () => els.castlePlot.classList.toggle('is-open'));
  els.onlineCastleBtn.addEventListener('click', () => openCastleForTitle(state.onlineTitle?.title));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.settingsModal.hidden) closeSettings();
      else if (!els.downloadsPanel.hidden) closeDownloads();
      else if (!els.downloadsPanel.hidden) closeDownloads();
      else if (!els.castleModal.hidden) closeCastleModal();
      else if (!els.onlineModal.hidden) closeOnlineModal();
      else if (!els.searchOverlay.hidden) closeSearch();
      else if (isModalOpen()) closeModal();
      else { closeProfile(); closeNotifs(); }
    }
    if (e.key === 'Tab') {
      if (isModalOpen()) trapFocus(e, els.modal);
      else if (!els.settingsModal.hidden) trapFocus(e, els.settingsModal);
      else if (!els.castleModal.hidden) trapFocus(e, els.castleModal);
      else if (!els.onlineModal.hidden) trapFocus(e, els.onlineModal);
    }
  });

  els.modalPlay.addEventListener('click', () => {
    const id = state.modalPlayId || modalItemId;
    if (id) goWatch(id);
  });
  els.seriesFind.addEventListener('click', () => {
    if (state.offline) {
      toast('Go online to find more episodes.', { type: 'warn' });
      return;
    }
    const item = state.byId.get(modalItemId);
    if (!item) return;
    closeModal();
    openCastleForTitle(item.seriesTitle || item.title);
  });
  els.modalList.addEventListener('click', () => {
    if (!modalItemId) return;
    const added = toggleMyList(modalItemId);
    const item = state.byId.get(modalItemId);
    if (item) updateModalListButton(item);
    toast(added ? 'Added to Favourite' : 'Removed from Favourite');
    renderRows();
  });

  els.refreshBtn.addEventListener('click', syncCastle);
  els.menuSettings.addEventListener('click', openSettings);
  els.menuRescan.addEventListener('click', () => { closeProfile(); syncCastle(); });
  els.menuQuit?.addEventListener('click', async () => {
    closeProfile();
    try {
      await quitApp();
      toast('App stopped — close this tab', { type: 'warn' });
    } catch (err) {
      toast(`Could not stop the app: ${err.message}`, { type: 'warn' });
    }
  });
  els.emptyScan.addEventListener('click', rescan);

  els.profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = els.profileMenu.hidden;
    if (open) closeNotifs();
    els.profileMenu.hidden = !open;
    els.profile.classList.toggle('open', open);
    els.profileBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!els.profile.contains(e.target)) closeProfile();
  });

  els.heroVideo.addEventListener('playing', () => els.heroVideo.classList.add('playing'));
  els.heroVideo.addEventListener('error', () => els.heroVideo.classList.remove('playing'));
}

function trapFocus(e, container = els.modal) {
  const focusables = container.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function closeProfile() {
  els.profileMenu.hidden = true;
  els.profile.classList.remove('open');
  els.profileBtn.setAttribute('aria-expanded', 'false');
}

function setProfile() {
  const name = 'Yassine';
  els.profileName.textContent = name;
  els.avatar.textContent = 'Y';
  els.avatarMenu.textContent = 'Y';
}

boot();
