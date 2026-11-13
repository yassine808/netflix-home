import {
  getLibrary, rescanLibrary, formatDuration, formatSize, formatClock,
  qualityLabel, thumbUrl, toggleMyList, isInMyList, getMyList, progressFor,
  continueWatching, debounce, createEl,
} from './common.js';

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
  toast: $('toast'),
  profile: $('profile'),
  profileBtn: $('profileBtn'),
  profileMenu: $('profileMenu'),
  menuRescan: $('menuRescan'),
  menuPath: $('menuPath'),
  avatar: $('avatar'),
  avatarMenu: $('avatarMenu'),
  profileName: $('profileName'),
};

/* ---------- boot ---------- */

async function boot() {
  bindStaticEvents();
  await loadLibrary({ first: true });
  schedulePoll();
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
  els.homeView.hidden = !isHome;
  els.gridView.hidden = isHome;
  if (isHome) {
    stopPreview();
    state.heroId = null;
    renderHero();
    renderRows();
  }
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === (view === 'home' ? 'home' : view));
  });
  setMobileActive(view === 'mylist' ? 'mylist' : view === 'movies' ? 'movies' : view === 'home' ? 'home' : null);
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

function openSearch() {
  stopPreview();
  setMobileActive('search');
  els.searchOverlay.hidden = false;
  document.body.classList.add('modal-open');
  els.searchInput.value = '';
  els.searchResults.replaceChildren();
  els.searchHint.textContent = state.items.length
    ? `Search ${state.items.length} title${state.items.length === 1 ? '' : 's'} in your library`
    : 'Your library is empty';
  setTimeout(() => els.searchInput.focus(), 30);
}

function closeSearch() {
  els.searchOverlay.hidden = true;
  document.body.classList.remove('modal-open');
  els.searchInput.blur();
  setMobileActive(state.view === 'mylist' ? 'mylist' : state.view === 'movies' ? 'movies' : 'home');
  if (state.view === 'home' && !isModalOpen()) setupPreview(state.byId.get(state.heroId));
}

const runSearch = debounce((query) => {
  const q = query.trim().toLowerCase();
  if (!q) {
    els.searchResults.replaceChildren();
    els.searchHint.textContent = state.items.length
      ? `Search ${state.items.length} title${state.items.length === 1 ? '' : 's'} in your library`
      : 'Your library is empty';
    return;
  }
  const results = state.items.filter((item) => {
    const hay = [item.title, item.fileName, item.year, item.collection, ...(item.genres || [])]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  els.searchHint.textContent = results.length
    ? `${results.length} result${results.length === 1 ? '' : 's'} for "${query.trim()}"`
    : `No results for "${query.trim()}"`;
  els.searchResults.replaceChildren();
  results.forEach((item) => els.searchResults.append(buildCard(item)));
}, 160);

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
  document.body.classList.add('modal-open');
  els.modal.hidden = false;
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
  document.body.classList.remove('modal-open');
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
  } catch {
    toast('Scan failed. Check the library folder and try again.');
  } finally {
    state.rescanning = false;
    els.refreshBtn.classList.remove('spinning');
    updateLoadingState();
    schedulePoll();
  }
}

function toast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4200);
}

/* ---------- events ---------- */

function bindStaticEvents() {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const view = link.dataset.view;
      if (view === 'home') showHome();
      else if (view === 'movies') showMovies();
      else if (view === 'mylist') showMyList();
    });
  });

  document.querySelectorAll('.mobile-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.mview;
      if (view === 'home') showHome();
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
    els.heroMute.querySelector('.i-muted').hidden = !video.muted;
    els.heroMute.querySelector('.i-sound').hidden = video.muted;
    els.heroMute.setAttribute('aria-label', video.muted ? 'Unmute preview' : 'Mute preview');
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

  els.modal.querySelectorAll('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.searchOverlay.hidden) closeSearch();
      else if (isModalOpen()) closeModal();
      else closeProfile();
    }
    if (isModalOpen() && e.key === 'Tab') trapFocus(e);
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
    els.profileMenu.hidden = !open;
    els.profile.classList.toggle('open', open);
    els.profileBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!els.profile.contains(e.target)) closeProfile();
  });

  els.heroVideo.addEventListener('error', () => els.heroVideo.classList.remove('playing'));
}

function trapFocus(e) {
  const focusables = els.modal.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
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
