import {
  getLibrary, rescanLibrary, formatDuration, formatSize, formatClock,
  qualityLabel, thumbUrl, toggleMyList, isInMyList, getMyList, progressFor,
  continueWatching, debounce, createEl,
  searchCatalog, getFallbackCatalog, getCatalogItem,
  searchOnline, getOnlineTitle, searchCastle, getCastleTitle, startCastleDownload,
  startDownload, startSeriesDownload, getDownloads, cancelDownload, retryDownload, reorderDownloads,
  readJson, writeJson,
} from './common.js';

const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'cancelling']);

const state = {
  library: null,
  items: [],
  byId: new Map(),
  view: 'home',
  heroId: null,
  pollTimer: null,
  previewTimer: null,
  previewStart: 0,
  toastTimer: null,
  lastFocus: null,
  bootAt: Date.now(),
  rescanning: false,
  catalog: [],
  catalogQuery: '',
  catalogSource: '',
  catalogLoading: false,
  pickerItem: null,
  pickerFiles: [],
  downloads: [],
  downloadsSynced: false,
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
  castleQuality: 0,
  castleBusy: false,
  castleDetailToken: 0,
  castleSeasonToken: 0,
};

const $ = (id) => document.getElementById(id);

const els = {
  nav: $('nav'),
  hero: $('hero'),
  heroImg: $('heroImg'),
  heroVideo: $('heroVideo'),
  heroTitle: $('heroTitle'),
  heroMeta: $('heroMeta'),
  heroPlot: $('heroPlot'),
  heroPlay: $('heroPlay'),
  heroPlayLabel: $('heroPlayLabel'),
  heroInfo: $('heroInfo'),
  heroMute: $('heroMute'),
  heroRating: $('heroRating'),
  rows: $('rows'),
  loading: $('loading'),
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
  moreGrid: $('moreGrid'),
  onlineModal: $('onlineModal'),
  onlineBackdrop: $('onlineBackdrop'),
  onlineKicker: $('onlineKicker'),
  onlineTitle: $('onlineTitle'),
  onlineMeta: $('onlineMeta'),
  onlinePlot: $('onlinePlot'),
  onlineWatchLink: $('onlineWatchLink'),
  onlineImdbLink: $('onlineImdbLink'),
  onlineCastleBtn: $('onlineCastleBtn'),
  onlineFreeBtn: $('onlineFreeBtn'),
  onlineSeasonBlock: $('onlineSeasonBlock'),
  onlineSeasonTabs: $('onlineSeasonTabs'),
  onlineEpisodes: $('onlineEpisodes'),
  castleModal: $('castleModal'),
  castleBackdrop: $('castleBackdrop'),
  castleKicker: $('castleKicker'),
  castleTitle: $('castleTitle'),
  castleMeta: $('castleMeta'),
  castlePlot: $('castlePlot'),
  castleSeasonDownload: $('castleSeasonDownload'),
  castleDownloadBlock: $('castleDownloadBlock'),
  castleQuality: $('castleQuality'),
  castleSize: $('castleSize'),
  castleSeasonTabs: $('castleSeasonTabs'),
  castleEpisodes: $('castleEpisodes'),
  castleStatus: $('castleStatus'),
  toast: $('toast'),
  profile: $('profile'),
  profileBtn: $('profileBtn'),
  profileMenu: $('profileMenu'),
  menuRescan: $('menuRescan'),
  menuPath: $('menuPath'),
  avatar: $('avatar'),
  avatarMenu: $('avatarMenu'),
  profileName: $('profileName'),
  discoverView: $('discoverView'),
  discoverForm: $('discoverForm'),
  discoverInput: $('discoverInput'),
  discoverChips: $('discoverChips'),
  discoverNote: $('discoverNote'),
  catalogGrid: $('catalogGrid'),
  catalogEmpty: $('catalogEmpty'),
  catalogEmptyTitle: $('catalogEmptyTitle'),
  catalogEmptyText: $('catalogEmptyText'),
  catalogLoading: $('catalogLoading'),
  searchArchiveBtn: $('searchArchiveBtn'),
  searchArchiveLabel: $('searchArchiveLabel'),
  picker: $('picker'),
  pickerImg: $('pickerImg'),
  pickerTitle: $('pickerTitle'),
  pickerMeta: $('pickerMeta'),
  pickerDesc: $('pickerDesc'),
  pickerFiles: $('pickerFiles'),
  pickerDownload: $('pickerDownload'),
  pickerDownloadLabel: $('pickerDownloadLabel'),
  pickerSeries: $('pickerSeries'),
  pickerStatus: $('pickerStatus'),
  downloadsBtn: $('downloadsBtn'),
  downloadsBadge: $('downloadsBadge'),
  downloadsPanel: $('downloadsPanel'),
  downloadsList: $('downloadsList'),
  downloadsEmpty: $('downloadsEmpty'),
  downloadsCount: $('downloadsCount'),
  downloadsRoot: $('downloadsRoot'),
  dlActive: $('dlActive'),
  dlQueued: $('dlQueued'),
  dlDone: $('dlDone'),
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

async function boot() {
  bindStaticEvents();
  await loadLibrary({ first: true });
  schedulePoll();
  refreshDownloads({ initial: true });
  scheduleDownloadPoll();
}

async function loadLibrary({ first = false } = {}) {
  try {
    const data = await getLibrary();
    const previousUpdated = state.library?.updatedAt;
    state.library = data;
    state.items = data.items || [];
    state.byId = new Map(state.items.map((i) => [i.id, i]));
    if (els.emptyPath) els.emptyPath.textContent = data.root || 'G:\\Movies';
    els.menuPath.textContent = data.root ? `Library: ${data.root}` : '';
    if (first) setProfile();

    const changed = previousUpdated !== data.updatedAt;
    if (changed || first) renderAll();
    updateLoadingState();
  } catch (err) {
    console.error(err);
    if (first) {
      els.loading.hidden = false;
      els.emptyHero.hidden = true;
      els.loading.querySelector('p').textContent = 'Could not reach the server. Is netflix-home running?';
    }
  }
}

function updateLoadingState() {
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
  }, 60000);

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

/* ---------- rendering ---------- */

function renderAll() {
  renderHero();
  renderRows();
  renderGridForCurrentView();
  updateLoadingState();
}

function pickHero() {
  const items = state.items;
  if (!items.length) return null;
  const inProgress = continueWatching(items);
  if (inProgress.length) return inProgress[0].item;
  return items[0];
}

function renderHero() {
  const item = pickHero();
  if (!item) {
    state.heroId = null;
    stopPreview();
    return;
  }
  const same = state.heroId === item.id;
  state.heroId = item.id;
  els.hero.hidden = false;

  els.heroTitle.textContent = item.title;
  els.heroImg.alt = item.title;
  els.heroImg.src = thumbUrl(item);
  els.heroRating.textContent = item.rating || (item.height >= 1000 ? 'HD' : 'NR');

  const progress = progressFor(item.id);
  const meta = [
    item.year || null,
    formatDuration(item.durationSec) || null,
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

function setupPreview(item) {
  stopPreview();
  if (!item || item.durationSec < 90) return;
  state.previewStart = Math.min(Math.max(20, item.durationSec * 0.12), Math.max(20, item.durationSec - 80));
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    if (document.hidden || state.view !== 'home' || isModalOpen() || !els.searchOverlay.hidden) return;
    playPreview(item);
  }, 4000);
}

function playPreview(item) {
  const video = els.heroVideo;
  video.muted = true;
  video.src = `/api/stream/${item.id}`;
  video.classList.remove('playing');
  const start = state.previewStart;
  video.addEventListener('loadedmetadata', () => {
    try { video.currentTime = start; } catch { /* seek may fail on some formats */ }
  }, { once: true });
  video.addEventListener('playing', () => video.classList.add('playing'), { once: true });
  video.addEventListener('error', () => video.classList.remove('playing'));
  video.play().catch(() => {});
}

videoLoop();
function videoLoop() {
  els.heroVideo.addEventListener('timeupdate', () => {
    if (!els.heroVideo.duration) return;
    if (els.heroVideo.currentTime > state.previewStart + 50) {
      try { els.heroVideo.currentTime = state.previewStart; } catch { /* ignore */ }
    }
  });
}

function stopPreview() {
  clearTimeout(state.previewTimer);
  const video = els.heroVideo;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* ignore */ }
  video.classList.remove('playing');
}

function renderRows() {
  els.rows.replaceChildren();
  const items = state.items;
  if (!items.length) return;

  const progressList = continueWatching(items);
  const progressMap = new Map(progressList.map((p) => [p.item.id, p.progress]));
  const list = getMyList();
  const listItems = list.map((id) => state.byId.get(id)).filter(Boolean);

  const rows = [];
  if (progressList.length) {
    rows.push({ title: 'Continue Watching', items: progressList.map((p) => p.item), progressMap });
  }
  rows.push({ title: 'Recently Added', items: items.slice(0, 14) });

  if (items.length >= 5) {
    rows.push({ title: 'Top 10 in Your Library Today', type: 'top10', items: topTen(items) });
  }

  for (const col of state.library.collections || []) {
    if (col.name === 'Movies' || col.items.length < 2) continue;
    const rowItems = col.items.map((id) => state.byId.get(id)).filter(Boolean);
    if (rowItems.length >= 2) rows.push({ title: col.name, items: rowItems, sub: `${rowItems.length} titles` });
  }

  if (listItems.length) {
    rows.push({ title: 'My List', items: listItems, seeAll: 'mylist' });
  }

  rows.push({ title: 'Movies in Your Library', items, seeAll: 'movies' });

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

function buildRow({ title, items, progressMap, type, sub, seeAll }) {
  const row = createEl('div', `row${type === 'top10' ? ' top10' : ''}`);
  const head = createEl('div', 'row-head');
  const h2 = createEl('h2', 'row-title', title);
  if (sub) h2.append(createEl('span', 'row-sub', sub));
  head.append(h2);
  if (seeAll) {
    const link = createEl('button', 'row-see-all', 'Explore all');
    link.addEventListener('click', () => {
      if (seeAll === 'mylist') showMyList();
      else showMovies();
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
      track.append(buildCard(item, { progress: progressMap?.get(item.id) }));
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

function buildCard(item, { progress } = {}) {
  const card = createEl('div', 'card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', item.title);

  const fallback = createEl('div', 'card-fallback');
  fallback.append(createEl('span', '', item.title));

  const img = document.createElement('img');
  img.className = 'card-img';
  img.loading = 'lazy';
  img.alt = '';
  img.src = thumbUrl(item);
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());

  const overlay = createEl('div', 'card-overlay');
  overlay.append(createEl('div', 'card-title', item.title));
  const meta = createEl('div', 'card-meta');
  const bits = [item.year, formatDuration(item.durationSec), qualityLabel(item)].filter(Boolean);
  meta.textContent = bits.join(' • ');
  overlay.append(meta);

  const play = createEl('button', 'card-play');
  play.setAttribute('aria-label', `Play ${item.title}`);
  play.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>';
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    goWatch(item.id);
  });

  card.append(fallback, img, overlay, play);
  if (Number.isFinite(progress) && progress > 0.01) {
    card.classList.add('has-progress');
    const bar = createEl('div', 'card-progress');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(progress * 100)}%`;
    bar.append(fill);
    card.append(bar);
  }

  card.addEventListener('click', () => openModal(item.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(item.id);
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
  img.alt = '';
  img.src = thumbUrl(item);
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());
  const title = createEl('div', 'card-title', item.title);
  art.append(fallback, img, title);
  if (Number.isFinite(progress)) {
    const bar = createEl('div', 'card-progress');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(progress * 100)}%`;
    bar.append(fill);
    art.append(bar);
  }
  card.append(number, art);
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
  state.view = view;
  const isHome = view === 'home';
  const isDiscover = view === 'discover';
  els.homeView.hidden = !isHome;
  els.gridView.hidden = isHome || isDiscover;
  els.discoverView.hidden = !isDiscover;
  if (isHome) {
    stopPreview();
    state.heroId = null;
    renderHero();
    renderRows();
  }
  if (isDiscover) stopPreview();
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === view);
  });
  setMobileActive(['home', 'discover', 'movies', 'mylist'].includes(view) ? view : null);
  window.scrollTo(0, 0);
}

function setMobileActive(name) {
  document.querySelectorAll('.mobile-nav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mview === name);
  });
}

function showHome() {
  setView('home');
}

function showMovies() {
  setView('movies');
  els.gridTitle.textContent = 'Movies';
  els.gridSub.textContent = `${state.items.length} title${state.items.length === 1 ? '' : 's'} in ${state.library?.root || 'your library'}`;
  fillGrid(els.grid, state.items, els.gridEmpty, 'Nothing in your library yet.');
}

function showMyList() {
  setView('mylist');
  const list = getMyList();
  const items = list.map((id) => state.byId.get(id)).filter(Boolean);
  els.gridTitle.textContent = 'My List';
  els.gridSub.textContent = `${items.length} saved title${items.length === 1 ? '' : 's'}`;
  fillGrid(els.grid, items, els.gridEmpty, 'Add titles with the + button on any detail page.');
}

function showCollection(name, items) {
  setView('collection');
  els.gridTitle.textContent = name;
  els.gridSub.textContent = `${items.length} title${items.length === 1 ? '' : 's'}`;
  fillGrid(els.grid, items, els.gridEmpty, 'No titles here yet.');
}

/* ---------- discover: archive.org catalog ---------- */

let catalogRequest = 0;

const STATUS_LABELS = {
  queued: 'Queued',
  downloading: 'Downloading',
  cancelling: 'Cancelling…',
  cancelled: 'Cancelled',
  failed: 'Failed',
  completed: 'Completed',
};

function showDiscover(query = '') {
  setView('discover');
  const q = String(query || '').trim();
  if (q) {
    els.discoverInput.value = q;
    runCatalogSearch(q);
  } else if (!state.catalog.length && !state.catalogLoading) {
    loadDiscoverPicks();
  }
}

function setCatalogBusy(busy) {
  state.catalogLoading = busy;
  els.catalogLoading.hidden = !busy;
  els.catalogGrid.hidden = busy;
  if (busy) {
    els.catalogEmpty.hidden = true;
    els.discoverNote.hidden = true;
  }
}

function showCatalogNote(message) {
  els.discoverNote.textContent = message;
  els.discoverNote.hidden = false;
}

async function loadDiscoverPicks() {
  const token = ++catalogRequest;
  state.catalogQuery = '';
  els.discoverInput.value = '';
  setCatalogBusy(true);
  try {
    const data = await getFallbackCatalog();
    if (token !== catalogRequest) return;
    state.catalog = data.results || [];
    state.catalogSource = 'fallback';
    showCatalogNote('Editor’s picks — public-domain films you can download right now.');
  } catch {
    if (token !== catalogRequest) return;
    state.catalog = [];
    state.catalogSource = '';
    showCatalogNote('Could not load the catalog. Check that the server is running and try again.');
  } finally {
    if (token === catalogRequest) {
      setCatalogBusy(false);
      renderCatalog();
    }
  }
}

async function runCatalogSearch(query) {
  const q = String(query || '').trim();
  if (!q) return loadDiscoverPicks();
  const token = ++catalogRequest;
  state.catalogQuery = q;
  setCatalogBusy(true);
  try {
    const data = await searchCatalog(q);
    if (token !== catalogRequest) return;
    state.catalog = data.results || [];
    state.catalogSource = data.source || '';
    if (data.fallback) {
      showCatalogNote('Archive.org search is unavailable right now — showing the curated catalog instead.');
    } else {
      showCatalogNote(`${state.catalog.length} result${state.catalog.length === 1 ? '' : 's'} for “${q}” on archive.org`);
    }
  } catch (err) {
    if (token !== catalogRequest) return;
    state.catalog = [];
    state.catalogSource = '';
    showCatalogNote(`Could not search archive.org (${err.message}). Try again in a moment.`);
  } finally {
    if (token === catalogRequest) {
      setCatalogBusy(false);
      renderCatalog();
    }
  }
}

function renderCatalog() {
  els.catalogGrid.replaceChildren();
  state.catalog.forEach((item) => els.catalogGrid.append(buildCatalogCard(item)));
  const empty = state.catalog.length === 0;
  els.catalogEmpty.hidden = !empty;
  if (empty) {
    els.catalogEmptyTitle.textContent = state.catalogQuery
      ? `No films found for “${state.catalogQuery}”`
      : 'No films found';
    els.catalogEmptyText.textContent = 'Try a different search, or browse the editor’s picks.';
  }
}

function buildCatalogCard(item) {
  const card = createEl('article', 'catalog-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `View download options for ${item.title}`);

  const art = createEl('div', 'catalog-art');
  const fallback = createEl('div', 'catalog-fallback');
  fallback.innerHTML = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  if (item.thumb) img.src = item.thumb;
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());

  const overlay = createEl('div', 'catalog-overlay');
  overlay.append(createEl('div', 'catalog-title', item.title));
  const bits = [item.year, item.creator].filter(Boolean).join(' • ');
  overlay.append(createEl('div', 'catalog-meta', bits || 'Public domain'));

  const action = createEl('button', 'catalog-download');
  action.setAttribute('aria-label', `Download ${item.title}`);
  action.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg><span>Download</span>';
  action.addEventListener('click', (e) => {
    e.stopPropagation();
    openPicker(item);
  });

  art.append(fallback, img, overlay, action);
  card.append(art);

  const open = () => openPicker(item);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return card;
}

/* ---------- catalog picker ---------- */

async function openPicker(result) {
  state.pickerItem = result;
  state.pickerFiles = [];
  els.picker.hidden = false;
  syncBodyLock();
  els.pickerImg.src = result.thumb || '';
  els.pickerImg.alt = result.title || '';
  els.pickerImg.hidden = !result.thumb;
  els.pickerTitle.textContent = result.title || result.identifier;
  els.pickerMeta.textContent = [result.year, result.creator].filter(Boolean).join(' • ') || 'archive.org';
  els.pickerDesc.textContent = 'Loading details from archive.org…';
  els.pickerFiles.replaceChildren();
  els.pickerStatus.textContent = '';
  els.pickerDownload.disabled = true;
  els.pickerDownloadLabel.textContent = 'Download';
  els.pickerSeries.hidden = true;
  els.pickerSeries.disabled = false;
  setTimeout(() => els.picker.querySelector('.modal-close')?.focus(), 40);

  try {
    const item = await getCatalogItem(result.identifier);
    if (state.pickerItem !== result) return;
    state.pickerItem = { ...result, ...item };
    renderPickerFiles(item);
  } catch (err) {
    if (state.pickerItem !== result) return;
    els.pickerDesc.textContent = `Could not load this title: ${err.message}`;
    els.pickerStatus.textContent = 'Close this window and try again in a moment.';
  }
}

function renderPickerFiles(item) {
  const extRank = (name) => {
    const ext = String(name).split('.').pop().toLowerCase();
    const order = { mp4: 0, m4v: 1, webm: 2, mkv: 3, ogv: 4, avi: 5, mov: 6 };
    return order[ext] ?? 9;
  };
  const files = [...(item.files || [])].sort((a, b) => extRank(a.name) - extRank(b.name) || b.size - a.size);
  state.pickerFiles = files;
  els.pickerDesc.textContent = item.description
    || 'A public-domain title from archive.org. Pick a file to download into your library.';
  els.pickerFiles.replaceChildren();

  if (!files.length) {
    els.pickerStatus.textContent = 'This item has no downloadable video files.';
    return;
  }

  files.forEach((file, index) => {
    const label = createEl('label', 'picker-file');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'picker-file';
    radio.value = file.name;
    radio.checked = index === 0;

    const main = createEl('span', 'picker-file-main');
    main.append(createEl('strong', '', file.name.replace(/\.[^.]+$/, '')));
    const sub = [file.format, formatSize(file.size)].filter(Boolean).join(' · ');
    if (sub) main.append(createEl('span', 'picker-file-sub', sub));

    const check = createEl('span', 'picker-check');
    label.append(radio, main, check);
    els.pickerFiles.append(label);
  });

  els.pickerDownload.disabled = false;
  els.pickerDownloadLabel.textContent = files.length > 1 ? 'Download selected' : 'Download film';
  els.pickerSeries.hidden = files.length < 2;
  els.pickerSeries.textContent = `Download all ${files.length} file${files.length === 1 ? '' : 's'}`;
}

function setPickerBusy(busy) {
  els.pickerDownload.disabled = busy || !state.pickerFiles.length;
  els.pickerSeries.disabled = busy;
}

function closePicker() {
  state.pickerItem = null;
  state.pickerFiles = [];
  els.picker.hidden = true;
  syncBodyLock();
}

async function queueDownload(item, fileName) {
  setPickerBusy(true);
  els.pickerStatus.textContent = 'Starting download…';
  try {
    await startDownload({
      identifier: item.identifier,
      file: fileName,
      title: item.title,
      year: item.year || undefined,
      collection: 'Downloads',
    });
    closePicker();
    openDownloads();
    toast(`Download started — ${item.title}`);
    notify('start', item.title, 'Download started');
  } catch (err) {
    els.pickerStatus.textContent = `Could not start download: ${err.message}`;
  } finally {
    setPickerBusy(false);
  }
}

async function queueSeriesDownload(item) {
  setPickerBusy(true);
  els.pickerStatus.textContent = 'Queueing every file…';
  try {
    const result = await startSeriesDownload({
      identifier: item.identifier,
      title: item.title,
      collection: 'Series',
      folder: item.title,
    });
    closePicker();
    openDownloads();
    toast(`${result.count} download${result.count === 1 ? '' : 's'} started — ${item.title}`);
    notify('start', item.title, `${result.count} download${result.count === 1 ? '' : 's'} queued`);
  } catch (err) {
    els.pickerStatus.textContent = `Could not queue the series: ${err.message}`;
  } finally {
    setPickerBusy(false);
  }
}

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
    if (data.root) els.downloadsRoot.textContent = `Saving to ${data.root}`;
    renderDownloads();
    updateDownloadsBadge();

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
      completed.forEach((job) => notify('done', job.title || job.fileName, 'Download complete — ready to watch'));
    }
    if (failed.length) {
      toast(`Download failed — ${failed[0].title}`);
      failed.forEach((job) => notify('fail', job.title || job.fileName, job.error || 'Download failed'));
    }
  } catch {
    /* keep the last known list when the server is unreachable */
  }
}

function updateDownloadsBadge() {
  const active = state.downloads.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
  els.downloadsBadge.hidden = active === 0;
  els.downloadsBadge.textContent = active > 9 ? '9+' : String(active);
  els.downloadsBtn.classList.toggle('busy', active > 0);
  els.downloadsCount.textContent = active
    ? `${active} active download${active === 1 ? '' : 's'}`
    : 'No active downloads';
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

function renderDownloads() {
  const active = state.downloads.filter((j) => j.status === 'downloading' || j.status === 'cancelling');
  const queued = orderedQueue(state.downloads.filter((j) => j.status === 'queued'));
  const finished = state.downloads.filter((j) => !ACTIVE_STATUSES.has(j.status)).slice(0, 8);
  const all = [...active, ...queued, ...finished];
  const ids = new Set(all.map((j) => j.id));

  dlRows.forEach((row, id) => { if (!ids.has(id)) { row.remove(); dlRows.delete(id); } });
  all.forEach((job) => {
    let row = dlRows.get(job.id);
    if (!row) { row = buildDownloadRow(job); dlRows.set(job.id, row); }
    updateDownloadRow(row, job);
  });

  const fill = (section, jobs, isQueue) => {
    section.hidden = jobs.length === 0;
    section.querySelector('.dl-count').textContent = jobs.length ? `(${jobs.length})` : '';
    if (isQueue && dlDrag.active) return; // don't fight the user's drag
    const box = section.querySelector('.dl-items');
    jobs.forEach((job, i) => {
      const row = dlRows.get(job.id);
      if (box.children[i] !== row) box.insertBefore(row, box.children[i] || null);
      if (isQueue) row.querySelector('.dl-pos').textContent = String(i + 1);
    });
  };
  fill(els.dlActive, active);
  fill(els.dlQueued, queued, true);
  fill(els.dlDone, finished);
  els.downloadsEmpty.hidden = all.length > 0;
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
    if (!sib) return;
    const box = row.parentElement;
    animateReorder(box, () => (e.key === 'ArrowUp' ? box.insertBefore(row, sib) : box.insertBefore(sib, row)));
    commitQueueOrder(box);
    grip.focus();
  });

  const pos = createEl('span', 'dl-pos', '');
  const main = createEl('div', 'download-main');
  const top = createEl('div', 'download-top');
  const title = createEl('span', 'download-title');
  const pct = createEl('span', 'download-pct');
  top.append(title, pct);
  const file = createEl('div', 'download-file');
  const bar = createEl('div', 'download-bar');
  const fillEl = document.createElement('i');
  bar.append(fillEl);
  const meta = createEl('div', 'download-meta');
  main.append(top, file, bar, meta);
  const actions = createEl('div', 'download-actions');
  row.append(grip, pos, main, actions);
  row._r = { title, pct, file, bar, fillEl, meta, actions };
  return row;
}

function updateDownloadRow(row, job) {
  const r = row._r;
  row.className = `download-row is-${job.status}${row.classList.contains('dragging') ? ' dragging' : ''}`;
  r.title.textContent = job.title || job.fileName;
  r.file.textContent = job.fileName || '';
  const pct = job.status === 'completed' ? 100 : Math.round((job.progress || 0) * 100);
  const showPct = job.status !== 'queued' && job.status !== 'failed';
  r.pct.hidden = !showPct;
  if (showPct) tweenNumber(r.pct, pct);
  r.fillEl.style.width = `${pct}%`;
  r.bar.classList.toggle('indeterminate', job.status === 'cancelling');

  r.meta.replaceChildren();
  r.meta.append(createEl('span', `download-status ${job.status}`, STATUS_LABELS[job.status] || job.status));
  if (job.total && job.status !== 'queued') r.meta.append(createEl('span', '', `${formatSize(job.bytes)} of ${formatSize(job.total)}`));
  else if (job.status === 'completed') r.meta.append(createEl('span', '', formatSize(job.bytes)));
  if (job.status === 'downloading') {
    if (job.speed) r.meta.append(createEl('span', '', formatSpeed(job.speed)));
    const eta = formatEta(job);
    if (eta) r.meta.append(createEl('span', 'download-eta', eta));
  }
  if (job.error) r.meta.append(createEl('span', 'download-error', job.error));

  r.actions.replaceChildren();
  if (job.status === 'queued' || job.status === 'downloading') {
    const btn = createEl('button', 'download-action', 'Cancel');
    btn.addEventListener('click', () => downloadAction(job.id, 'cancel', btn));
    r.actions.append(btn);
  } else if (job.status === 'failed' || job.status === 'cancelled') {
    const btn = createEl('button', 'download-action primary', 'Retry');
    btn.addEventListener('click', () => downloadAction(job.id, 'retry', btn));
    r.actions.append(btn);
  } else if (job.status === 'completed') {
    r.actions.append(createEl('span', 'download-done', '✓'));
  }
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
  const ids = [...box.children].map((el) => el.dataset.id);
  [...box.children].forEach((el, i) => { el.querySelector('.dl-pos').textContent = String(i + 1); });
  writeJson(QUEUE_ORDER_KEY, ids);
  reorderDownloads(ids);
}

function startDrag(e, row) {
  if (e.button !== undefined && e.button !== 0) return;
  const box = row.parentElement;
  if (!box || box.children.length < 2) return;
  e.preventDefault();
  dlDrag.active = true;
  document.body.classList.add('dl-dragging');
  row.classList.add('dragging');
  const grabOffset = e.clientY - row.getBoundingClientRect().top;
  const scroller = els.downloadsList;
  let lastY = e.clientY;
  let raf = 0;

  const place = () => {
    row.style.transform = 'none';
    const natural = row.getBoundingClientRect().top;
    row.style.transform = `translateY(${lastY - grabOffset - natural}px)`;
  };
  const move = (ev) => {
    lastY = ev.clientY;
    place();
    const center = lastY - grabOffset + row.offsetHeight / 2;
    const sibs = [...box.children].filter((el) => el !== row);
    let target = null;
    for (const el of sibs) {
      const rc = el.getBoundingClientRect();
      if (center < rc.top + rc.height / 2) { target = el; break; }
    }
    if ((target || null) !== row.nextElementSibling) {
      animateReorder(box, () => box.insertBefore(row, target), row);
      place();
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
    else await retryDownload(id);
    await refreshDownloads();
  } catch {
    toast('Could not update the download. Try again.');
    button.disabled = false;
  }
}

function openDownloads() {
  els.downloadsPanel.hidden = false;
  syncBodyLock();
  refreshDownloads();
  setTimeout(() => els.downloadsPanel.querySelector('.downloads-close')?.focus(), 40);
}

function closeDownloads() {
  els.downloadsPanel.hidden = true;
  syncBodyLock();
  els.downloadsBtn.focus();
}

function syncBodyLock() {
  const open = !els.searchOverlay.hidden
    || isModalOpen()
    || !els.onlineModal.hidden
    || !els.castleModal.hidden
    || !els.picker.hidden
    || !els.downloadsPanel.hidden;
  document.body.classList.toggle('modal-open', open);
}

function updateSearchArchive(query) {
  const q = String(query || '').trim();
  els.searchArchiveBtn.hidden = !q;
  els.searchArchiveBtn.dataset.q = q;
  if (q) els.searchArchiveLabel.textContent = `Search archive.org for “${q}”`;
}

function renderGridForCurrentView() {
  if (state.view === 'movies') showMovies();
  else if (state.view === 'mylist') showMyList();
  else if (state.view === 'collection') {
    const name = els.gridTitle.textContent;
    const col = state.library.collections.find((c) => c.name === name);
    if (col) fillGrid(els.grid, col.items.map((id) => state.byId.get(id)).filter(Boolean), els.gridEmpty, '');
  }
}

function fillGrid(container, items, emptyEl, emptyText) {
  container.replaceChildren();
  items.forEach((item) => container.append(buildCard(item)));
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
  updateSearchArchive('');
  els.searchHint.textContent = state.items.length
    ? `Search ${state.items.length} title${state.items.length === 1 ? '' : 's'} in your library, the download catalog, and movies online`
    : 'Search the download catalog and thousands of movies and series online';
  setTimeout(() => els.searchInput.focus(), 30);
}

function closeSearch() {
  els.searchOverlay.hidden = true;
  syncBodyLock();
  els.searchInput.blur();
  setMobileActive(['home', 'discover', 'movies', 'mylist'].includes(state.view) ? state.view : null);
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
    updateSearchArchive('');
    resetOnlineSearch();
    resetCastleSearch();
    els.searchHint.textContent = state.items.length
      ? `Search ${state.items.length} title${state.items.length === 1 ? '' : 's'} in your library, the download catalog, and movies online`
      : 'Search the download catalog and thousands of movies and series online';
    return;
  }

  els.searchHint.textContent = `Results for “${query}”`;
  renderLocalResults(query, q);
  updateSearchArchive(query);

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

function renderLocalResults(query, q) {
  const results = state.items.filter((item) => {
    const hay = [item.title, item.fileName, item.year, item.collection, ...(item.genres || [])]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  els.searchResults.replaceChildren();
  results.forEach((item) => els.searchResults.append(buildCard(item)));
  els.searchLocalCount.textContent = results.length
    ? `${results.length} title${results.length === 1 ? '' : 's'}`
    : '';
  els.searchLocalEmpty.hidden = results.length > 0;
  if (!results.length) {
    els.searchLocalEmpty.textContent = `Nothing in your library matches “${query}”. Downloadable and online results are below.`;
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

  art.append(fallback, img, badge, overlay);
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
  populateOnlineModal(item);
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
    els.onlinePlot.textContent = item.description
      || 'Full details are unavailable right now. The IMDb link below still works.';
  }
}

function populateOnlineModal(item) {
  state.onlineTitle = item;
  els.onlineBackdrop.src = item.background || item.poster || '';
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

  els.onlinePlot.textContent = item.description
    || 'No overview available for this title yet.';
  els.onlineWatchLink.href = `https://www.justwatch.com/us/search?q=${encodeURIComponent(item.title)}`;
  els.onlineImdbLink.href = `https://www.imdb.com/title/${encodeURIComponent(item.id)}/`;
  renderOnlineSeasons(item);
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

      if (episode.thumbnail) {
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

function populateCastleModal(item) {
  els.castleBackdrop.src = item.background || item.poster || '';
  els.castleBackdrop.hidden = !(item.background || item.poster);
  els.castleTitle.textContent = item.title;
  els.castleKicker.textContent = 'DOWNLOAD';
  els.castlePlot.textContent = item.description || 'No overview available for this title yet.';
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
}

async function openCastleModal(item) {
  if (!els.searchOverlay.hidden) closeSearch();
  if (!els.onlineModal.hidden) closeOnlineModal();
  stopPreview();
  castleFocusEl = document.activeElement;
  state.castleTitle = item;
  state.castleSeason = 0;
  state.castleQuality = 0;
  state.castleBusy = false;
  const token = ++state.castleDetailToken;
  els.castleModal.hidden = false;
  syncBodyLock();
  populateCastleModal(item);
  els.castleDownloadBlock.hidden = true;
  els.castleSeasonDownload.hidden = true;
  els.castleEpisodes.replaceChildren();
  els.castleQuality.replaceChildren();
  els.castleSeasonTabs.replaceChildren();
  els.castleStatus.textContent = 'Loading download options…';
  setTimeout(() => els.castleModal.querySelector('.modal-close')?.focus(), 40);

  try {
    const detail = await getCastleTitle(item.id);
    if (token !== state.castleDetailToken) return;
    const merged = { ...item, ...detail };
    state.castleTitle = merged;
    state.castleSeason = detail.activeSeason || 0;
    state.castleCache.set(`${detail.id}:${detail.activeSeason || 0}`, detail);
    populateCastleModal(merged);
    renderCastleDownloads(merged);
  } catch (err) {
    if (token !== state.castleDetailToken) return;
    els.castleStatus.textContent = `Could not load download options (${err.message}).`;
    els.castleStatus.hidden = false;
  }
}

function renderCastleQuality(detail, episodes) {
  const qualities = new Map();
  episodes.forEach((episode) => {
    (episode.resolutions || []).forEach((quality) => {
      const entry = qualities.get(quality.resolution) || { resolution: quality.resolution, premium: true };
      entry.premium = entry.premium && Boolean(quality.premium);
      qualities.set(quality.resolution, entry);
    });
  });

  const list = [...qualities.values()].sort((a, b) => a.resolution - b.resolution);
  els.castleQuality.replaceChildren();
  if (!list.length) return { selected: 0, total: 0, duration: 0, qualities };

  let selected = Number(state.castleQuality);
  if (!qualities.has(selected)) {
    const free = [...list].reverse().find((entry) => !entry.premium);
    selected = (free || list[list.length - 1]).resolution;
  }
  state.castleQuality = selected;

  list.forEach((quality) => {
    const btn = createEl('button', 'quality-option', qualityName(quality.resolution));
    btn.type = 'button';
    btn.dataset.resolution = String(quality.resolution);
    btn.classList.toggle('active', quality.resolution === selected);
    if (quality.premium) {
      btn.dataset.premium = 'true';
      btn.title = 'Premium quality — may only be available as a preview';
    }
    btn.addEventListener('click', () => {
      state.castleQuality = quality.resolution;
      renderCastleDownloads(state.castleTitle);
    });
    els.castleQuality.append(btn);
  });

  let total = 0;
  let duration = 0;
  episodes.forEach((episode) => {
    const match = (episode.resolutions || []).find((entry) => entry.resolution === selected);
    if (match) total += match.size;
    duration += Number(episode.duration) || 0;
  });
  els.castleSize.textContent = [
    detail.type === 'series' && episodes.length
      ? `${episodes.length} episode${episodes.length === 1 ? '' : 's'} at ${qualityName(selected)}`
      : qualityName(selected),
    total ? `≈ ${formatSize(total)}` : '',
  ].filter(Boolean).join(' · ');

  return { selected, total, duration, qualities };
}

function renderCastleDownloads(detail) {
  const episodes = castleEpisodesOf(detail);
  els.castleDownloadBlock.hidden = false;
  els.castleEpisodes.replaceChildren();
  els.castleSeasonTabs.replaceChildren();
  els.castleStatus.textContent = '';
  els.castleStatus.hidden = false;

  const { selected } = renderCastleQuality(detail, episodes);

  const seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
  const canPickSeason = detail.type === 'series' && seasons.length > 1;
  els.castleSeasonTabs.hidden = !canPickSeason;
  if (canPickSeason) {
    seasons.forEach((entry) => {
      const btn = createEl('button', 'season-tab', `Season ${entry.season}`);
      btn.type = 'button';
      btn.classList.toggle('active', entry.season === detail.activeSeason);
      btn.addEventListener('click', () => selectCastleSeason(entry.season));
      els.castleSeasonTabs.append(btn);
    });
  }

  els.castleSeasonDownload.hidden = !(detail.type === 'series' && episodes.length);
  els.castleSeasonDownload.disabled = state.castleBusy;
  els.castleSeasonDownload.textContent = 'Download season';

  if (!episodes.length) {
    els.castleStatus.textContent = 'No downloadable episodes are listed for this title.';
    return;
  }

  episodes.forEach((episode) => {
    const row = createEl('article', 'episode-row castle-episode');

    if (episode.thumbnail) {
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
    head.append(createEl('span', 'episode-number', detail.type === 'series' ? `E${episode.episode}` : 'FILM'));
    head.append(createEl('strong', '', detail.type === 'series' ? episode.title : detail.title));
    main.append(head);

    const quality = (episode.resolutions || []).find((entry) => entry.resolution === selected);
    const sub = [
      formatDuration(episode.duration),
      quality ? qualityName(quality.resolution) : 'Not available',
      quality?.size ? formatSize(quality.size) : '',
    ].filter(Boolean).join(' · ');
    main.append(createEl('span', 'episode-date', sub));
    row.append(main);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'castle-dl-btn';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg><span>Download</span>';
    if (!quality) {
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Unavailable';
    } else {
      btn.addEventListener('click', () => queueCastleEpisode(episode, btn));
    }
    row.append(btn);
    els.castleEpisodes.append(row);
  });
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
  els.castleEpisodes.replaceChildren();
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
  const quality = (episode.resolutions || []).find((entry) => entry.resolution === state.castleQuality);
  if (!detail || !quality) return;

  const isSeries = detail.type === 'series';
  const label = isSeries
    ? `S${String(state.castleSeason).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`
    : detail.title;

  btn.disabled = true;
  btn.querySelector('span').textContent = 'Starting…';
  els.castleStatus.textContent = '';

  try {
    await startCastleDownload({
      movieId: episode.movieId,
      episodeId: episode.episodeId,
      resolution: state.castleQuality,
      title: detail.title,
      year: detail.year,
      season: isSeries ? state.castleSeason : 0,
      episode: episode.episode,
      size: quality.size,
      poster: detail.poster,
    });
    btn.classList.add('queued');
    btn.querySelector('span').textContent = 'Queued';
    toast(`${label} queued — ${qualityName(state.castleQuality)}`);
    notify('start', label, `Queued — ${qualityName(state.castleQuality)}`);
    openDownloads();
    refreshDownloads();
  } catch (err) {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Retry';
    els.castleStatus.textContent = `Could not queue ${label}: ${err.message}`;
  }
}

async function queueCastleSeason() {
  const detail = state.castleTitle;
  const episodes = castleEpisodesOf(detail);
  if (!detail || !episodes.length || state.castleBusy) return;

  state.castleBusy = true;
  els.castleSeasonDownload.disabled = true;
  els.castleStatus.textContent = '';
  let queued = 0;
  let skipped = 0;

  for (let index = 0; index < episodes.length; index += 1) {
    const episode = episodes[index];
    els.castleSeasonDownload.textContent = `Queueing ${index + 1}/${episodes.length}…`;
    const quality = (episode.resolutions || []).find((entry) => entry.resolution === state.castleQuality);
    if (!quality) {
      skipped += 1;
      continue;
    }
    try {
      await startCastleDownload({
        movieId: episode.movieId,
        episodeId: episode.episodeId,
        resolution: state.castleQuality,
        title: detail.title,
        year: detail.year,
        season: state.castleSeason,
        episode: episode.episode,
        size: quality.size,
        poster: detail.poster,
      });
      queued += 1;
    } catch {
      skipped += 1;
    }
  }

  state.castleBusy = false;
  els.castleSeasonDownload.disabled = false;
  els.castleSeasonDownload.textContent = 'Download season';
  els.castleStatus.textContent = [
    queued ? `${queued} episode${queued === 1 ? '' : 's'} queued` : '',
    skipped ? `${skipped} unavailable at ${qualityName(state.castleQuality)}` : '',
  ].filter(Boolean).join(' · ') || 'Nothing was queued.';

  if (queued) {
    toast(`${queued} episode${queued === 1 ? '' : 's'} queued — ${detail.title}`);
    notify('start', detail.title, `${queued} episode${queued === 1 ? '' : 's'} queued`);
    openDownloads();
    refreshDownloads();
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
  state.castleTitle = null;
  state.castleDetailToken += 1;
  state.castleSeasonToken += 1;
  state.castleBusy = false;
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
let lastFocusEl = null;

function openModal(id) {
  const item = state.byId.get(id);
  if (!item) return;
  if (!els.searchOverlay.hidden) closeSearch();
  stopPreview();
  lastFocusEl = document.activeElement;
  modalItemId = id;
  els.modal.hidden = false;
  syncBodyLock();
  els.modal.scrollTop = 0;
  els.modalImg.src = thumbUrl(item);
  els.modalImg.alt = item.title;
  els.modalTitle.textContent = item.title;

  els.modalMeta.replaceChildren();
  const metaBits = [item.year, formatDuration(item.durationSec), qualityLabel(item)].filter(Boolean);
  metaBits.forEach((bit, i) => {
    if (i > 0) els.modalMeta.append(createEl('span', 'dot', '•'));
    els.modalMeta.append(createEl('span', i === 0 ? 'year' : '', bit));
  });
  if (item.rating) els.modalMeta.append(createEl('span', 'chip', item.rating));
  if (item.genres?.length) els.modalMeta.append(createEl('span', '', item.genres.slice(0, 3).join(' · ')));

  els.modalPlot.textContent = item.plot
    || `A title from your personal library, streamed directly from your drive. ${item.genres?.length ? `Genres: ${item.genres.join(', ')}.` : ''}`.trim();

  els.modalSide.replaceChildren();
  els.modalSide.append(createEl('h3', '', 'Details'));
  const dl = document.createElement('dl');
  const details = [
    ['File', item.fileName],
    ['Folder', item.collection],
    ['Resolution', item.width && item.height ? `${item.width} × ${item.height}` : 'Unknown'],
    ['Video', item.videoCodec ? item.videoCodec.toUpperCase() : 'Unknown'],
    ['Audio', item.audioCodec ? item.audioCodec.toUpperCase() : 'Unknown'],
    ['Size', formatSize(item.size) || 'Unknown'],
    ['Added', new Date(item.mtime).toLocaleDateString()],
  ];
  for (const [k, v] of details) {
    if (!v) continue;
    dl.append(createEl('dt', '', k), createEl('dd', '', v));
  }
  els.modalSide.append(dl);

  updateModalPlayLabel(item);
  updateModalListButton(item);
  renderMore(item);
  setTimeout(() => document.querySelector('.modal-close')?.focus(), 40);
}

function updateModalPlayLabel(item) {
  const p = progressFor(item.id);
  const resume = p && !p.finished && p.t > 5;
  els.modalPlayLabel.textContent = resume ? `Resume ${formatClock(p.t)}` : 'Play';
}

function updateModalListButton(item) {
  const inList = isInMyList(item.id);
  els.modalList.querySelector('.i-plus').hidden = inList;
  els.modalList.querySelector('.i-check').hidden = !inList;
  els.modalList.title = inList ? 'Remove from My List' : 'Add to My List';
  els.modalList.classList.toggle('in-list', inList);
}

function renderMore(item) {
  els.moreGrid.replaceChildren();
  let pool = state.items.filter((i) => i.id !== item.id && (
    i.collection === item.collection
    || (i.genres || []).some((g) => (item.genres || []).includes(g))
  ));
  if (pool.length < 3) {
    const seen = new Set(pool.map((i) => i.id));
    pool = pool.concat(state.items.filter((i) => i.id !== item.id && !seen.has(i.id)));
  }
  pool.slice(0, 6).forEach((other) => els.moreGrid.append(buildCard(other)));
}

function closeModal() {
  if (!isModalOpen()) return;
  els.modal.hidden = true;
  modalItemId = null;
  syncBodyLock();
  lastFocusEl?.focus?.();
  if (state.view === 'home') {
    setupPreview(state.byId.get(state.heroId));
  }
}

function refreshModalIfOpen() {
  if (modalItemId && state.byId.has(modalItemId)) openModal(modalItemId);
  else if (modalItemId) closeModal();
}

/* ---------- actions ---------- */

function goWatch(id) {
  const item = state.byId.get(id);
  if (!item) return;
  location.href = `/watch?id=${encodeURIComponent(id)}`;
}

async function rescan() {
  if (state.rescanning) return;
  state.rescanning = true;
  els.refreshBtn.classList.add('spinning');
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
    els.refreshBtn.classList.remove('spinning');
    updateLoadingState();
    schedulePoll();
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

function notify(type, title, text) {
  state.notifs.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, title, text: text || '', time: Date.now(), read: false });
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

function renderNotifs() {
  const unread = state.notifs.filter((n) => !n.read).length;
  els.notifBadge.hidden = unread === 0;
  els.notifBadge.textContent = unread > 9 ? '9+' : String(unread);
  els.notifList.replaceChildren();
  els.notifEmpty.hidden = state.notifs.length > 0;
  state.notifs.forEach((n) => {
    const row = createEl('div', `notif-item${n.read ? '' : ' unread'}`);
    const ico = createEl('div', `notif-ico t-${n.type}`);
    const match = n.type === 'done' && state.items.find((it) => (it.title || '').toLowerCase() === (n.title || '').toLowerCase());
    if (match) {
      const img = document.createElement('img');
      img.src = thumbUrl(match);
      img.alt = '';
      img.onerror = () => { img.remove(); ico.innerHTML = NOTIF_ICONS.done; };
      ico.append(img);
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

function toast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4200);
}

/* ---------- events ---------- */

function bindStaticEvents() {
  bindNotifs();
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const view = link.dataset.view;
      if (view === 'home') showHome();
      else if (view === 'movies') showMovies();
      else if (view === 'discover') showDiscover();
      else if (view === 'mylist') showMyList();
    });
  });

  document.querySelectorAll('.mobile-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.mview;
      if (view === 'home') showHome();
      else if (view === 'discover') showDiscover();
      else if (view === 'movies') showMovies();
      else if (view === 'mylist') showMyList();
      else if (view === 'search') openSearch();
    });
  });

  window.addEventListener('scroll', () => {
    els.nav.classList.toggle('scrolled', window.scrollY > 50);
  }, { passive: true });

  els.heroPlay.addEventListener('click', () => {
    const item = state.byId.get(state.heroId);
    if (item) goWatch(item.id);
  });
  els.heroInfo.addEventListener('click', () => {
    if (state.heroId) openModal(state.heroId);
  });
  els.heroMute.addEventListener('click', () => {
    const video = els.heroVideo;
    video.muted = !video.muted;
    if (!video.muted) video.volume = 0.7;
    els.heroMute.classList.toggle('is-muted', video.muted);
    els.heroMute.setAttribute('aria-label', video.muted ? 'Unmute preview' : 'Mute preview');
    els.heroMute.title = els.heroMute.getAttribute('aria-label');
    if (!video.src) {
      const item = state.byId.get(state.heroId);
      if (item) playPreview(item);
    }
  });

  els.searchBtn.addEventListener('click', openSearch);
  els.searchClose.addEventListener('click', closeSearch);
  els.searchInput.addEventListener('input', (e) => runSearch(e.target.value));
  els.searchOverlay.addEventListener('click', (e) => {
    if (e.target === els.searchOverlay) closeSearch();
  });
  els.searchResults.addEventListener('click', () => closeSearch());
  els.searchCastleResults.addEventListener('click', () => closeSearch());
  els.searchOnlineResults.addEventListener('click', () => closeSearch());
  els.searchArchiveBtn.addEventListener('click', () => {
    const q = els.searchArchiveBtn.dataset.q || els.searchInput.value.trim();
    closeSearch();
    if (q) showDiscover(q);
    else showDiscover();
  });

  els.discoverForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runCatalogSearch(els.discoverInput.value);
  });
  els.discoverChips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-q]');
    if (!btn) return;
    const q = btn.dataset.q;
    els.discoverInput.value = q;
    if (q) runCatalogSearch(q);
    else loadDiscoverPicks();
  });

  els.picker.querySelectorAll('[data-close-picker]').forEach((el) => el.addEventListener('click', closePicker));
  els.pickerDownload.addEventListener('click', () => {
    const item = state.pickerItem;
    const selected = els.pickerFiles.querySelector('input[name="picker-file"]:checked');
    if (item && selected) queueDownload(item, selected.value);
  });
  els.pickerSeries.addEventListener('click', () => {
    if (state.pickerItem) queueSeriesDownload(state.pickerItem);
  });

  els.downloadsBtn.addEventListener('click', openDownloads);
  els.downloadsPanel.querySelectorAll('[data-close-downloads]').forEach((el) => {
    el.addEventListener('click', closeDownloads);
  });

  els.modal.querySelectorAll('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));
  els.onlineModal.querySelectorAll('[data-close-online]').forEach((el) => el.addEventListener('click', closeOnlineModal));
  els.castleModal.querySelectorAll('[data-close-castle]').forEach((el) => el.addEventListener('click', closeCastleModal));
  els.castleSeasonDownload.addEventListener('click', queueCastleSeason);
  els.onlineCastleBtn.addEventListener('click', () => openCastleForTitle(state.onlineTitle?.title));
  els.onlineFreeBtn.addEventListener('click', () => {
    const title = state.onlineTitle?.title;
    closeOnlineModal();
    showDiscover(title || '');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.picker.hidden) closePicker();
      else if (!els.downloadsPanel.hidden) closeDownloads();
      else if (!els.castleModal.hidden) closeCastleModal();
      else if (!els.onlineModal.hidden) closeOnlineModal();
      else if (!els.searchOverlay.hidden) closeSearch();
      else if (isModalOpen()) closeModal();
      else { closeProfile(); closeNotifs(); }
    }
    if (e.key === 'Tab') {
      if (isModalOpen()) trapFocus(e, els.modal);
      else if (!els.castleModal.hidden) trapFocus(e, els.castleModal);
      else if (!els.onlineModal.hidden) trapFocus(e, els.onlineModal);
      else if (!els.picker.hidden) trapFocus(e, els.picker);
    }
  });

  els.modalPlay.addEventListener('click', () => {
    if (modalItemId) goWatch(modalItemId);
  });
  els.modalList.addEventListener('click', () => {
    if (!modalItemId) return;
    const added = toggleMyList(modalItemId);
    const item = state.byId.get(modalItemId);
    if (item) updateModalListButton(item);
    toast(added ? 'Added to My List' : 'Removed from My List');
    renderRows();
  });

  els.refreshBtn.addEventListener('click', rescan);
  els.menuRescan.addEventListener('click', () => { closeProfile(); rescan(); });
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
