import {
  formatClock, formatDuration, progressFor, saveProgress, thumbUrl, heroImageUrl, readJson, writeJson, getSeries,
  skel,
} from './common.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const player = $('player');
const ui = $('playerUI');
const loading = $('playerLoading');
const errorBox = $('playerError');
const timeEl = $('time');
const playBtn = $('playBtn');
const timeline = $('timelineWrap');
const played = $('tlPlayed');
const buffer = $('tlBuffer');
const thumb = $('tlThumb');
const tooltip = $('tlTooltip');
const volume = $('volume');
const muteBtn = $('muteBtn');
const fsBtn = $('fsBtn');
const videoTitle = $('videoTitle');
const epTag = $('epTag');
const nextWrap = $('nextWrap');
const nextCard = $('nextCard');
const nextTag = $('nextTag');
const nextNote = $('nextNote');
const nextThumb = $('nextThumb');
const epBtn = $('epBtn');
const epPanel = $('epPanel');
const epList = $('epList');
const epSeason = $('epSeason');
const back10Btn = $('back10');
const fwd10Btn = $('fwd10');
const resumeToast = $('resumeToast');
const ccBtn = $('ccBtn');
const ccPanel = $('ccPanel');
const ccList = $('ccList');
const ccAudio = $('ccAudio');
const audioList = $('audioList');
const ccOffsetEl = $('ccOffset');
const subSizeDown = $('subSizeDown');
const subSizeUp = $('subSizeUp');
const subSizeValue = $('subSizeValue');
const subBg = $('subBg');
const subBgValue = $('subBgValue');
const subtitleLayer = $('subtitleLayer');
const subtitleText = $('subtitleText');
const preview = $('tlPreview');
const skipIntroBtn = $('skipIntro');
const idleEl = $('idle');
const idleFill = $('idleFill');

let item = null;
let nextEpisode = null;
let duration = 0;
let lastSaved = 0;
let hideTimer = null;
let idleTimer = null;
let dragging = false;
let pendingResume = 0;
let lastVolume = 1;
let dragRatio = 0;
let raf = 0;
let lastTimeLabel = '';
let seekQueued = false;
let lastSeekAt = 0;
let seriesSeasons = [];
let episodesLoading = false;
let subtitlesLoading = false;

const UI_HIDE_DELAY = 3000;
const IDLE_DELAY = 12000; /* paused and untouched this long: show the idle screen */
const PREVIEW_HALF_MIN = 84;

let frames = null;
let previewMode = 'none';
let previewBackdrop = '';
let intro = null;
let introDismissed = false;

/* subtitle state */
const SUB_OFFSET_STEP = 0.5;
const SUB_OFFSET_LIMIT = 10;
let subtitleTracks = [];
let subtitleCues = [];
let subtitleLang = 'en';
let subtitleOffset = 0;
let subtitleRequest = 0;

/* Audio (dub) choice. Browsers play only the first audio stream of a file, so a
 * different track is fetched from /api/stream/:id?audio=<index>. The choice is
 * remembered per series, like the subtitle language. */
let audioTracks = [];
let audioIndex = null;
let audioSwitching = false;

/* Subtitle look: text scale and the opacity of the black box behind it.
 * Defaults: English on, 130 % size, no background. Every change is stored per
 * series, so the next episode opens with the same look and language. */
const SUB_SCALE_MIN = 0.8;
const SUB_SCALE_MAX = 1.8;
const SUB_SCALE_STEP = 0.1;
let subScale = 1.3;
let subBgOpacity = 0;

const params = new URLSearchParams(location.search);
const id = params.get('id');
const INTRO_SKIP_KEY = `netflix-home:intro-skipped:${id}`;

/* One series shares one set of subtitle settings across all its episodes. */
function subtitleScope() {
  return `series:${item?.seriesKey || item?.id || id}`;
}

function subtitleStyleKey() {
  return `netflix-home:subtitle-style:${subtitleScope()}`;
}

function subtitlePrefsKey() {
  return `netflix-home:subtitles:${subtitleScope()}`;
}

function audioPrefsKey() {
  return `netflix-home:audio:${subtitleScope()}`;
}

init();

async function init() {
  if (!id) {
    location.replace('/');
    return;
  }

  const saved = progressFor(id);
  if (saved && !saved.finished && saved.t > 5 && saved.d > 0 && saved.t / saved.d < 0.96) {
    pendingResume = saved.t;
  }
  introDismissed = readIntroSkipped();

  try {
    const res = await fetch(`/api/item/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    item = await res.json();
  } catch {
    showError('This title is no longer in your library. It may have been moved or renamed.');
    return;
  }

  document.title = `${item.displayTitle || item.title} | Netflix Home`;
  const full = item.displayTitle || item.title || '';
  videoTitle.textContent = item.seriesTitle
    || (item.isSeries ? full.replace(/\s*[·•-]\s*S\d+E\d+\s*$/i, '') : (item.title || full));
  epTag.textContent = item.isSeries ? `S${item.season}:E${item.episode}` : '';
  videoTitle.classList.remove('sk-text');
  epTag.classList.remove('sk-text');
  document.body.style.background = '#000';
  video.poster = thumbUrl(item, 960);
  await initAudioTracks();
  video.src = streamUrl();
  video.load();
  bindEvents();
  initSeekFx();
  loadNextEpisode();
  loadEpisodes();
  syncVolume();
  updateTimeline();
  initSubtitles();
  initSubtitleStyle();
  setMediaSession();
}

function bindEvents() {
  video.addEventListener('loadedmetadata', () => {
    timeEl.classList.remove('sk-text');
    duration = Number.isFinite(video.duration) ? video.duration : item.durationSec || 0;
    updateTimeline();
    loading.hidden = true;
    // A dub switch reloads the source; the time and play state are restored
    // separately, so skip the resume/autoplay path for that reload.
    if (audioSwitching) return;
    if (pendingResume > 0) {
      const startAt = resumeStart();
      try {
        video.currentTime = startAt;
      } catch { /* ignore */ }
    }
    attemptAutoplay();
    initFrames();
    initIntro();
  });

  video.addEventListener('canplay', () => { loading.hidden = true; });
  video.addEventListener('play', () => setPlayIcon(true));
  video.addEventListener('waiting', () => { loading.hidden = false; });
  video.addEventListener('playing', () => {
    loading.hidden = true;
    player.classList.remove('paused');
    player.classList.remove('hide-cursor');
    setPlayIcon(true);
    startLoop();
    armHideUi();
    hideIdle();
  });
  video.addEventListener('pause', () => {
    player.classList.add('paused');
    setPlayIcon(false);
    stopLoop();
    showUi();
    saveNow();
    armIdle();
  });
  video.addEventListener('ended', () => {
    player.classList.add('paused');
    setPlayIcon(false);
    stopLoop();
    showUi();
    saveProgress(item.id, duration, duration);
    armIdle();
  });
  video.addEventListener('timeupdate', () => {
    updateTimeline();
    updateBuffer();
    renderSubtitle();
    syncSkipIntro();
    if (Date.now() - lastSaved > 3000) saveNow();
  });
  video.addEventListener('progress', updateBuffer);
  video.addEventListener('durationchange', () => {
    duration = video.duration || duration;
    updateTimeline();
  });
  video.addEventListener('error', () => {
    const code = video.error?.code;
    const detail = code === 4
      ? 'The browser does not support this video format or codec.'
      : 'The video stream could not be loaded.';
    showError(`${detail} File: ${item.fileName}`);
  });

  playBtn.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', toggleFullscreen);

  $('backBtn').addEventListener('click', leaveToHome);
  back10Btn.addEventListener('click', () => skip(-10));
  fwd10Btn.addEventListener('click', () => skip(10));
  epBtn.addEventListener('click', () => toggleEpPanel());
  $('epClose').addEventListener('click', () => toggleEpPanel(false));
  epSeason.addEventListener('change', () => renderEpisodes(Number(epSeason.value)));
  nextCard.addEventListener('click', openNextEpisode);
  document.addEventListener('pointerdown', (e) => {
    if (!ccPanel.hidden && !ccPanel.contains(e.target) && !ccBtn.contains(e.target)) toggleCcPanel(false, true);
    if (!epPanel.hidden && !epPanel.contains(e.target) && !epBtn.contains(e.target)) toggleEpPanel(false, true);
  });
  muteBtn.addEventListener('click', toggleMute);
  fsBtn.addEventListener('click', toggleFullscreen);
  ccBtn.addEventListener('click', () => toggleCcPanel());
  skipIntroBtn.addEventListener('click', skipIntroNow);
  $('nextEp').addEventListener('click', openNextEpisode);
  document.querySelector('.btn-home')?.addEventListener('click', (e) => {
    e.preventDefault();
    leaveToHome();
  });
  $('ccClose').addEventListener('click', () => toggleCcPanel(false));
  $('ccMinus').addEventListener('click', () => nudgeOffset(-SUB_OFFSET_STEP));
  $('ccPlus').addEventListener('click', () => nudgeOffset(SUB_OFFSET_STEP));
  $('ccReset').addEventListener('click', () => {
    subtitleOffset = 0;
    updateOffsetLabel();
    saveSubtitlePrefs();
    renderSubtitle();
  });
  subSizeDown.addEventListener('click', () => nudgeSubtitleScale(-SUB_SCALE_STEP));
  subSizeUp.addEventListener('click', () => nudgeSubtitleScale(SUB_SCALE_STEP));
  subBg.addEventListener('input', () => {
    subBgOpacity = Math.max(0, Math.min(1, Number(subBg.value) / 100));
    applySubtitleStyle();
    saveSubtitleStyle();
  });

  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    if (!video.muted) lastVolume = video.volume;
    syncVolume();
  });

  timeline.addEventListener('pointerdown', onSeekDown);
  timeline.addEventListener('pointermove', onSeekMove);
  timeline.addEventListener('pointerup', onSeekUp);
  timeline.addEventListener('pointercancel', onSeekUp);
  timeline.addEventListener('pointerleave', () => {
    hidePreview();
    if (!dragging) tooltip.hidden = true;
  });

  player.addEventListener('pointermove', () => {
    showUi();
    if (!video.paused && !dragging) armHideUi();
  });
  player.addEventListener('pointerleave', () => {
    if (!video.paused) hideUiNow();
  });
  window.addEventListener('pageshow', () => {
    document.body.classList.remove('leaving');
  });

  document.addEventListener('keydown', onKeyDown);
  bindIdle();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow();
    else showUi();
  });
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);
  document.addEventListener('fullscreenchange', () => {
    const fs = Boolean(document.fullscreenElement);
    fsBtn.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Fullscreen');
    player.classList.toggle('is-fs', fs);
    fsBtn.querySelector('.i-fs-in').toggleAttribute('hidden', fs);
    fsBtn.querySelector('.i-fs-out').toggleAttribute('hidden', !fs);
  });
}

function attemptAutoplay() {
  video.play().then(() => {
    player.classList.remove('paused');
  }).catch(() => {
    player.classList.add('paused');
    setPlayIcon(false);
    showUi();
  });
}

function togglePlay() {
  if (video.paused || video.ended) {
    if (video.ended) video.currentTime = 0;
    video.play().catch(() => {});
  } else {
    video.pause();
  }
  showUi();
  armHideUi();
}

/* YouTube-style feedback: a ripple on the tapped half and a running total of
 * the seconds skipped, which resets half a second after the last click. */
const seekFx = {
  left: { el: null, count: null, total: 0, last: 0, timer: 0 },
  right: { el: null, count: null, total: 0, last: 0, timer: 0 },
};

function initSeekFx() {
  seekFx.left.el = $('seekLeft');
  seekFx.left.count = $('seekLeftCount');
  seekFx.right.el = $('seekRight');
  seekFx.right.count = $('seekRightCount');
  video.addEventListener('loadedmetadata', syncSeekFxBounds);
  window.addEventListener('resize', syncSeekFxBounds);
  syncSeekFxBounds();
}

/* Keep the ripples over the picture, not over the black bars around it. */
function syncSeekFxBounds() {
  const layer = $('seekFx');
  if (layer) layer.style.inset = '0';
}

function flashSeek(sideKey) {
  const fx = seekFx[sideKey];
  if (!fx?.el) return;
  syncSeekFxBounds();
  const now = performance.now();
  fx.total = now - fx.last < 700 ? fx.total + 10 : 10;
  fx.last = now;
  fx.count.textContent = String(fx.total);
  fx.el.classList.remove('is-on');
  void fx.el.offsetWidth; // restart the animation
  fx.el.classList.add('is-on');
  clearTimeout(fx.timer);
  fx.timer = setTimeout(() => {
    fx.el.classList.remove('is-on');
    fx.total = 0;
  }, 640);
}

function skip(seconds) {
  if (!duration) return;
  video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), duration - 0.5);
  flashSeek(seconds < 0 ? 'left' : 'right');
  spinSkipIcon(seconds < 0 ? back10Btn : fwd10Btn);
  updateTimeline();
  showUi();
  armHideUi();
}

/* The arrow ring on the -10 / +10 button spins once per click. */
function spinSkipIcon(btn) {
  btn.classList.remove('spin');
  void btn.offsetWidth; // restart the animation
  btn.classList.add('spin');
}

/* Resume a few seconds before the saved point so the viewer regains context. */
function resumeStart() {
  const from = pendingResume > 5 ? Math.max(0, pendingResume - 5) : pendingResume;
  const ceiling = Math.max(0, duration - 5);
  return Math.min(from, ceiling);
}

function leaveToHome() {
  saveNow();
  document.body.classList.add('leaving');
  setTimeout(() => { location.href = '/'; }, 180);
}

/* The player only shows this control for series. A local next episode plays
 * immediately; one that is only in the download catalog opens the series sheet
 * on that season so its Download button is in front of the user. */
async function loadNextEpisode() {
  if (item?.isSeries) {
    nextWrap.hidden = false;
    nextWrap.classList.add('is-loading'); // greyed placeholder until the answer arrives
  }
  try {
    const res = await fetch(`/api/next/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || data.kind === 'none') return;
    nextEpisode = data;
    const tag = `S${data.season}:E${data.episode}`;
    nextWrap.hidden = false;
    nextTag.textContent = `${data.episode}  ${data.title || data.name || tag}`;
    nextNote.textContent = data.kind === 'local' ? tag : `${tag} is not downloaded yet`;
    if (data.kind === 'local' && data.id) {
      nextThumb.style.backgroundImage = `url("${thumbUrl({ id: data.id }, 240)}")`;
    }
    $('nextEp').setAttribute('aria-label', data.kind === 'local'
      ? `Play next episode ${tag}`
      : `Open ${tag} to download`);
  } catch {
    /* button stays hidden when the lookup fails */
  } finally {
    nextWrap.classList.remove('is-loading');
    if (!nextEpisode) nextWrap.hidden = true;
  }
}

/* ---------- episodes panel ---------- */

async function loadEpisodes() {
  if (!item?.isSeries || !item.seriesKey) return;
  // The button is there at once; the panel shows placeholders until the list arrives.
  episodesLoading = true;
  epBtn.hidden = false;
  epPanel.classList.add('is-loading');
  try {
    const data = await getSeries(item.seriesKey);
    seriesSeasons = (data.seasons || []).filter((s) => s.episodes?.length);
  } catch {
    seriesSeasons = [];
  }
  episodesLoading = false;
  epPanel.classList.remove('is-loading');
  if (!seriesSeasons.length) {
    epBtn.hidden = true;
    toggleEpPanel(false, true);
    return;
  }
  epSeason.replaceChildren(...seriesSeasons.map((s) => {
    const opt = document.createElement('option');
    opt.value = String(s.season);
    opt.textContent = `Season ${s.season}`;
    return opt;
  }));
  epSeason.value = String(item.season);
  if (!epSeason.value) epSeason.selectedIndex = 0;
  if (!epPanel.hidden) renderEpisodes(Number(epSeason.value));
}

function renderEpisodesSkeleton(count = 5) {
  epList.replaceChildren(...Array.from({ length: count }, () => {
    const row = document.createElement('div');
    row.className = 'ep-item ep-sk';
    row.setAttribute('aria-hidden', 'true');
    const lines = document.createElement('div');
    lines.className = 'ep-sk-lines';
    lines.append(skel('', '60%', '13px'), skel('', '34%', '10px'));
    row.append(skel('ep-sk-num', '14px', '14px'), skel('ep-sk-thumb'), lines);
    return row;
  }));
}

function renderEpisodes(season) {
  if (episodesLoading) {
    renderEpisodesSkeleton();
    return;
  }
  const entry = seriesSeasons.find((s) => s.season === season) || seriesSeasons[0];
  epList.replaceChildren();
  if (!entry) return;
  const base = videoTitle.textContent.trim().toLowerCase();
  for (const ep of entry.episodes) {
    const isCurrent = ep.id === item.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ep-item${isCurrent ? ' current' : ''}`;

    const num = document.createElement('span');
    num.className = 'ep-num';
    num.textContent = String(ep.episode);

    const thumb = document.createElement('span');
    thumb.className = 'ep-thumb';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = heroImageUrl(ep);
    img.addEventListener('error', () => { img.src = thumbUrl(ep, 320); }, { once: true });
    thumb.append(img);
    if (isCurrent) {
      const now = document.createElement('span');
      now.className = 'ep-playing';
      now.textContent = 'Playing';
      thumb.append(now);
    }
    const prog = progressFor(ep.id);
    if (prog && prog.d > 0 && prog.t > 5) {
      const bar = document.createElement('span');
      bar.className = 'ep-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(Math.min(1, prog.t / prog.d) * 100)}%`;
      bar.append(fill);
      thumb.append(bar);
    }

    const raw = (ep.title || '').trim();
    const name = raw && raw.toLowerCase() !== base ? raw : `Episode ${ep.episode}`;
    const info = document.createElement('span');
    info.className = 'ep-info';
    const title = document.createElement('b');
    title.textContent = name;
    const meta = document.createElement('small');
    meta.textContent = [`S${ep.season}:E${ep.episode}`, ep.durationSec ? formatDuration(ep.durationSec) : ''].filter(Boolean).join(' · ');
    info.append(title, meta);

    btn.append(num, thumb, info);
    btn.addEventListener('click', () => {
      if (isCurrent) { toggleEpPanel(false); return; }
      saveNow();
      location.href = `/watch.html?id=${encodeURIComponent(ep.id)}`;
    });
    epList.append(btn);
  }
  epList.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

function toggleEpPanel(force, quiet) {
  const open = typeof force === 'boolean' ? force : epPanel.hidden;
  if (open) toggleCcPanel(false, true);
  epPanel.hidden = !open;
  epBtn.setAttribute('aria-expanded', String(open));
  clearTimeout(hideTimer);
  if (open) {
    showUi();
    renderEpisodes(Number(epSeason.value));
  } else if (!quiet) {
    armHideUi();
  }
}

function panelOpen() {
  return !ccPanel.hidden || !epPanel.hidden;
}

function openNextEpisode() {
  if (!nextEpisode) return;
  saveNow();
  if (nextEpisode.kind === 'local') {
    location.href = `/watch.html?id=${encodeURIComponent(nextEpisode.id)}`;
    return;
  }
  const query = new URLSearchParams({
    open: id,
    season: String(nextEpisode.season),
    episode: String(nextEpisode.episode),
  });
  location.href = `/?${query.toString()}`;
}

function toggleMute() {
  video.muted = !video.muted;
  if (!video.muted && video.volume === 0) {
    video.volume = lastVolume || 0.6;
    volume.value = String(video.volume);
  }
  syncVolume();
}

function syncVolume() {
  const muted = video.muted || video.volume === 0;
  muteBtn.classList.toggle('is-muted', muted);
  muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  volume.value = String(muted ? 0 : video.volume);
  volume.style.background = `linear-gradient(to right, #e50914 ${(muted ? 0 : video.volume) * 100}%, rgba(255,255,255,.5) ${(muted ? 0 : video.volume) * 100}%)`;
}

/* ---------- subtitles ---------- */

function loadSubtitlePrefs() {
  const saved = readJson(subtitlePrefsKey(), null);
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.lang === 'string') subtitleLang = saved.lang;
  if (Number.isFinite(saved.offset)) {
    subtitleOffset = Math.max(-SUB_OFFSET_LIMIT, Math.min(SUB_OFFSET_LIMIT, saved.offset));
  }
}

function saveSubtitlePrefs() {
  writeJson(subtitlePrefsKey(), { lang: subtitleLang, offset: subtitleOffset });
}

function initSubtitleStyle() {
  const saved = readJson(subtitleStyleKey(), null);
  if (saved && typeof saved === 'object') {
    const scale = Number(saved.scale);
    if (Number.isFinite(scale)) subScale = Math.min(SUB_SCALE_MAX, Math.max(SUB_SCALE_MIN, scale));
    const opacity = Number(saved.opacity);
    if (Number.isFinite(opacity)) subBgOpacity = Math.min(1, Math.max(0, opacity));
  }
  applySubtitleStyle();
}

function applySubtitleStyle() {
  document.documentElement.style.setProperty('--sub-scale', String(subScale));
  document.documentElement.style.setProperty('--sub-bg', String(subBgOpacity));
  subSizeValue.textContent = `${Math.round(subScale * 100)}%`;
  subBg.value = String(Math.round(subBgOpacity * 100));
  subBgValue.textContent = `${Math.round(subBgOpacity * 100)}%`;
}

function nudgeSubtitleScale(delta) {
  subScale = Math.min(SUB_SCALE_MAX, Math.max(SUB_SCALE_MIN, Math.round((subScale + delta) * 10) / 10));
  applySubtitleStyle();
  saveSubtitleStyle();
}

function saveSubtitleStyle() {
  writeJson(subtitleStyleKey(), { scale: subScale, opacity: subBgOpacity });
}

async function initSubtitles() {
  loadSubtitlePrefs();
  updateOffsetLabel();
  subtitlesLoading = true;
  renderSubtitleList();
  try {
    const res = await fetch(`/api/subtitles/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    subtitleTracks = Array.isArray(data.tracks) ? data.tracks.filter((t) => t && t.lang) : [];
  } catch {
    subtitleTracks = [];
  }

  subtitlesLoading = false;
  ccBtn.classList.remove('is-loading');
  renderSubtitleList();
  syncCcButton();

  if (!subtitleTracks.length) {
    ccBtn.disabled = true;
    ccBtn.title = 'No subtitle files next to this video';
    ccBtn.setAttribute('aria-label', 'No subtitles available');
    return;
  }

  ccBtn.title = 'Subtitles';
  const wanted = subtitleTracks.some((track) => track.lang === subtitleLang) ? subtitleLang : '';
  if (!wanted) subtitleLang = '';
  if (wanted) selectSubtitle(wanted);
}

function syncCcButton() {
  ccBtn.classList.toggle('cc-on', Boolean(subtitleLang));
  ccBtn.setAttribute('aria-label', subtitleLang
    ? `Subtitles on (${subtitleLang.toUpperCase()}) — change language`
    : 'Subtitles off — choose a language');
}

function renderSubtitleList() {
  ccList.replaceChildren();
  if (subtitlesLoading) {
    for (let i = 0; i < 3; i += 1) {
      const row = skel('cc-sk', i === 0 ? '40%' : `${60 - i * 12}%`, '16px');
      ccList.append(row);
    }
    return;
  }
  const options = [{ lang: '', label: 'Off' }, ...subtitleTracks];
  for (const option of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cc-option${subtitleLang === option.lang ? ' active' : ''}`;
    btn.textContent = option.label || option.lang.toUpperCase();
    btn.dataset.lang = option.lang;
    btn.addEventListener('click', () => selectSubtitle(option.lang));
    ccList.append(btn);
  }
}

async function selectSubtitle(lang) {
  const token = ++subtitleRequest;
  subtitleLang = lang;
  subtitleCues = [];
  subtitleLayer.hidden = true;
  renderSubtitleList();
  syncCcButton();
  saveSubtitlePrefs();
  if (!lang) return;

  try {
    const res = await fetch(`/api/subtitle/${encodeURIComponent(id)}/${encodeURIComponent(lang)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (token !== subtitleRequest) return;
    subtitleCues = parseVtt(text);
    if (!subtitleCues.length) throw new Error('empty subtitle file');
    renderSubtitle();
  } catch {
    if (token !== subtitleRequest) return;
    subtitleLang = '';
    subtitleCues = [];
    renderSubtitleList();
    syncCcButton();
    saveSubtitlePrefs();
    subtitleLayer.hidden = true;
    toastInPlayer('Could not load that subtitle file.');
  }
}

/* ---------- audio / dub selection ---------- */

function streamUrl() {
  const base = `/api/stream/${encodeURIComponent(item.id)}`;
  return audioIndex == null ? base : `${base}?audio=${audioIndex}`;
}

async function initAudioTracks() {
  let tracks = [];
  try {
    const res = await fetch(`/api/audio/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      tracks = Array.isArray(data.tracks)
        ? data.tracks.filter((track) => Number.isInteger(track.index))
        : [];
    }
  } catch {
    tracks = [];
  }
  audioTracks = tracks;

  const saved = Number(readJson(audioPrefsKey(), null)?.index);
  const pick = tracks.find((track) => track.index === saved)
    || tracks.find((track) => track.default)
    || tracks[0];
  audioIndex = pick ? pick.index : null;
  renderAudioTracks();
}

function renderAudioTracks() {
  if (!ccAudio) return;
  // One track means there is no dub to choose; keep the panel as it was.
  ccAudio.hidden = audioTracks.length < 2;
  audioList.replaceChildren();
  if (ccAudio.hidden) return;

  for (const track of audioTracks) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cc-option${track.index === audioIndex ? ' active' : ''}`;
    btn.textContent = track.label || `Audio track ${track.position + 1}`;
    if (track.lang) btn.dataset.lang = track.lang;
    btn.addEventListener('click', () => selectAudio(track.index));
    audioList.append(btn);
  }
}

async function selectAudio(index) {
  if (index === audioIndex || audioSwitching) return;
  const previous = audioIndex;
  const time = video.currentTime || 0;
  const wasPlaying = !video.paused && !video.ended;
  audioIndex = index;
  audioSwitching = true;
  renderAudioTracks();
  writeJson(audioPrefsKey(), { index });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    video.removeEventListener('loadedmetadata', restore);
    audioSwitching = false;
    try {
      if (time > 0) video.currentTime = time;
    } catch { /* seek can fail on a fresh source */ }
    if (wasPlaying) video.play().catch(() => {});
  };

  video.addEventListener('loadedmetadata', restore);
  video.src = streamUrl();
  video.load();

  // A remux can take a few seconds; if it never loads, go back to the old track.
  setTimeout(() => {
    if (restored) return;
    restored = true;
    video.removeEventListener('loadedmetadata', restore);
    audioSwitching = false;
    audioIndex = previous;
    renderAudioTracks();
    writeJson(audioPrefsKey(), { index: previous });
    toastInPlayer('That audio track could not be loaded.');
  }, 20000);
}

/* WebVTT is simple enough to read directly: a timestamp line, then the cue. */
function parseVtt(text) {
  const cues = [];
  const body = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim());
    if (!lines.length) continue;
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const [from, to] = lines[timeIndex].split('-->');
    const start = parseVttTime(from.trim().split(/\s+/)[0]);
    const end = parseVttTime((to || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const content = lines.slice(timeIndex + 1).join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lrm;|&rlm;/g, '')
      .trim();
    if (!content) continue;
    cues.push({ start, end, text: content });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function parseVttTime(value) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(String(value || ''));
  if (!m) return NaN;
  const [, h, min, sec, ms] = m;
  return (Number(h || 0) * 3600) + (Number(min) * 60) + Number(sec) + Number(ms.padEnd(3, '0')) / 1000;
}

function renderSubtitle() {
  if (!subtitleLang || !subtitleCues.length) {
    subtitleLayer.hidden = true;
    return;
  }
  const t = (video.currentTime || 0) - subtitleOffset;
  let cue = null;
  for (const entry of subtitleCues) {
    if (t < entry.start) break;
    if (t <= entry.end) { cue = entry; break; }
  }
  if (!cue) {
    subtitleLayer.hidden = true;
    return;
  }
  subtitleText.textContent = cue.text;
  subtitleLayer.hidden = false;
}

function updateOffsetLabel() {
  ccOffsetEl.textContent = `${subtitleOffset > 0 ? '+' : ''}${subtitleOffset.toFixed(1)}s`;
}

/* Positive offset means the cue text appears later than its timestamp. */
function nudgeOffset(delta) {
  subtitleOffset = Math.round(Math.max(-SUB_OFFSET_LIMIT, Math.min(SUB_OFFSET_LIMIT, subtitleOffset + delta)) * 10) / 10;
  updateOffsetLabel();
  saveSubtitlePrefs();
  renderSubtitle();
}

function toggleCcPanel(force, quiet) {
  const open = typeof force === 'boolean' ? force : ccPanel.hidden;
  if (open) toggleEpPanel(false, true);
  ccPanel.hidden = !open;
  ccBtn.setAttribute('aria-expanded', String(open));
  clearTimeout(hideTimer);
  if (open) {
    showUi();
    renderSubtitleList();
    ccPanel.querySelector('.cc-option.active')?.focus();
  } else if (!quiet) {
    armHideUi();
    ccBtn.focus();
  }
}

let toastTimer = null;

function toastInPlayer(message) {
  clearTimeout(toastTimer);
  resumeToast.textContent = message;
  resumeToast.hidden = false;
  toastTimer = setTimeout(() => { resumeToast.hidden = true; }, 4000);
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  } else {
    (player.requestFullscreen?.() || Promise.reject()).catch(() => {});
  }
}

/* rAF loop while playing: timeupdate fires ~4x/s, which looks steppy. */
function loop() {
  updateTimeline();
  raf = requestAnimationFrame(loop);
}
function startLoop() {
  if (!raf) raf = requestAnimationFrame(loop);
}
function stopLoop() {
  cancelAnimationFrame(raf);
  raf = 0;
  updateTimeline();
}

function updateTimeline() {
  duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
  const t = dragging ? dragRatio * duration : (video.currentTime || 0);
  const r = duration ? Math.min(1, Math.max(0, t / duration)) : 0;
  played.style.transform = `scaleX(${r})`;
  thumb.style.transform = `translateX(${r * 100}%)`;
  const label = formatClock(Math.max(0, duration - t));
  if (label !== lastTimeLabel) {
    lastTimeLabel = label;
    timeEl.textContent = label;
  }
}

function updateBuffer() {
  if (!duration || !video.buffered.length) {
    buffer.style.transform = 'scaleX(0)';
    return;
  }
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
  }
  buffer.style.transform = `scaleX(${Math.min(1, end / duration)})`;
}

function seekRatio(e) {
  const rect = timeline.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return ratio;
}

function onSeekDown(e) {
  if (!duration) return;
  dragging = true;
  dragRatio = seekRatio(e);
  timeline.classList.add('dragging');
  timeline.setPointerCapture?.(e.pointerId);
  video.currentTime = dragRatio * duration;
  lastSeekAt = performance.now();
  updateTimeline();
  updateTooltip(e);
  updatePreview(e);
  showUi();
  clearTimeout(hideTimer);
}

function onSeekMove(e) {
  updateTooltip(e);
  updatePreview(e);
  if (!dragging) return;
  dragRatio = seekRatio(e);
  updateTimeline(); // the bar follows the pointer instantly
  queueSeek(); // the video catches up at most once per frame
}

function onSeekUp(e) {
  if (!dragging) return;
  video.currentTime = dragRatio * duration;
  dragging = false;
  timeline.classList.remove('dragging');
  timeline.releasePointerCapture?.(e.pointerId);
  hidePreview();
  updateTimeline();
  syncSkipIntro();
  saveNow();
  if (!video.paused) armHideUi();
}

function queueSeek() {
  if (seekQueued) return;
  seekQueued = true;
  requestAnimationFrame(() => {
    seekQueued = false;
    if (!dragging) return;
    const now = performance.now();
    if (!video.seeking || now - lastSeekAt > 140) {
      video.currentTime = dragRatio * duration;
      lastSeekAt = now;
    }
  });
}

function updateTooltip(e) {
  if (!duration) return;
  const ratio = seekRatio(e);
  const rect = timeline.getBoundingClientRect();
  tooltip.hidden = false;
  tooltip.textContent = formatClock(ratio * duration);
  const x = Math.min(Math.max(ratio * rect.width, 26), rect.width - 26);
  tooltip.style.left = `${x}px`;
}

/* ---------- scrubber preview frames ---------- */

async function initFrames() {
  frames = null;
  previewMode = 'none';
  previewBackdrop = '';
  preview.hidden = true;
  if (!(duration > 60)) return;

  try {
    const res = await fetch(`/api/frames/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = Number(data?.count);
    const cols = Number(data?.cols);
    const rows = Number(data?.rows);
    const url = typeof data?.url === 'string' ? data.url : '';
    if (!url || !(count > 0) || !(cols > 0) || !(rows > 0)) throw new Error('bad sprite');
    frames = {
      url: /^(https?:)?\//.test(url) ? url : `/${url}`,
      count,
      cols,
      rows,
      intervalSec: Number(data.intervalSec) || 0,
    };
    previewMode = 'sprite';
    new Image().src = frames.url; /* warm the cache once */
  } catch {
    /* no sprite for this title: the poster is still a useful preview */
    frames = null;
    previewMode = 'poster';
  }
}

function previewImage() {
  if (previewMode === 'sprite' && frames) return frames.url;
  return video.poster || thumbUrl(item, 960);
}

function applyPreviewBackdrop() {
  const src = previewImage();
  if (!src || previewBackdrop === src) return;
  previewBackdrop = src;
  preview.style.backgroundImage = `url("${src}")`;
  if (previewMode === 'sprite' && frames) {
    preview.classList.remove('is-poster');
    preview.style.backgroundSize = `${frames.cols * 100}% ${frames.rows * 100}%`;
  } else {
    preview.classList.add('is-poster');
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
  }
}

/* One element, background-position only: cheap enough to run on every pointermove. */
function updatePreview(e) {
  if (previewMode === 'none' || !duration || !item) return;
  const ratio = seekRatio(e);
  const rect = timeline.getBoundingClientRect();
  if (!rect.width) return;
  preview.hidden = false;
  const half = preview.offsetWidth / 2 || PREVIEW_HALF_MIN;
  const x = Math.min(Math.max(ratio * rect.width, half), Math.max(half, rect.width - half));
  preview.style.left = `${x}px`;
  applyPreviewBackdrop();
  if (previewMode !== 'sprite' || !frames) return;

  const at = ratio * duration;
  const tile = frames.intervalSec > 0
    ? Math.floor(at / frames.intervalSec)
    : Math.floor(ratio * frames.count);
  const index = Math.min(frames.count - 1, Math.max(0, tile));
  const col = index % frames.cols;
  const row = Math.floor(index / frames.cols);
  const xPct = frames.cols > 1 ? (col / (frames.cols - 1)) * 100 : 0;
  const yPct = frames.rows > 1 ? (row / (frames.rows - 1)) * 100 : 0;
  preview.style.backgroundPosition = `${xPct}% ${yPct}%`;
}

function hidePreview() {
  preview.hidden = true;
}

/* ---------- skip intro ---------- */

async function initIntro() {
  intro = null;
  skipIntroBtn.hidden = true;
  if (introDismissed) return;

  try {
    const res = await fetch(`/api/intro/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.startSec == null || data?.endSec == null) return; /* {startSec:null} is a silent no-op */
    const startSec = Number(data.startSec);
    const endSec = Number(data.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return;
    if (startSec < 0 || endSec <= startSec + 2) return;
    intro = { startSec, endSec };
  } catch {
    intro = null;
  }
  syncSkipIntro();
}

/* Show only inside the intro, and only while at least 2 s of it are left. */
function syncSkipIntro() {
  if (!intro || introDismissed) {
    skipIntroBtn.hidden = true;
    return;
  }
  const t = video.currentTime || 0;
  skipIntroBtn.hidden = !(t >= intro.startSec && t <= intro.endSec - 2);
}

function skipIntroNow() {
  if (!intro) return;
  video.currentTime = Math.min(intro.endSec, Math.max(0, duration - 0.5));
  introDismissed = true;
  rememberIntroSkip();
  syncSkipIntro();
  updateTimeline();
  showUi();
  armHideUi();
}

function readIntroSkipped() {
  try { return sessionStorage.getItem(INTRO_SKIP_KEY) === '1'; } catch { return false; }
}

function rememberIntroSkip() {
  try { sessionStorage.setItem(INTRO_SKIP_KEY, '1'); } catch { /* storage disabled */ }
}

function setPlayIcon(playing) {
  /* SVG elements have no hidden property: toggle the attribute */
  playBtn.querySelector('.i-play').toggleAttribute('hidden', playing);
  playBtn.querySelector('.i-pause').toggleAttribute('hidden', !playing);
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function showUi() {
  player.classList.remove('hide-ui', 'hide-cursor');
  clearTimeout(hideTimer);
}

function hideUiNow() {
  if (video.paused || dragging || panelOpen()) return;
  hidePreview();
  player.classList.add('hide-ui', 'hide-cursor');
}

function armHideUi() {
  clearTimeout(hideTimer);
  if (video.paused || dragging || panelOpen()) return;
  hideTimer = setTimeout(hideUiNow, UI_HIDE_DELAY);
}

function saveNow() {
  if (!item || !duration) return;
  lastSaved = Date.now();
  saveProgress(item.id, video.currentTime, duration);
}

function onKeyDown(e) {
  if (!idleEl.hidden && e.key === 'Escape') {
    e.preventDefault();
    wakeIdle();
    return;
  }
  if (!idleEl.hidden) wakeIdle();
  if ((e.target instanceof HTMLInputElement && e.target !== volume) || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'Escape' && !epPanel.hidden) {
    e.preventDefault();
    toggleEpPanel(false);
    return;
  }
  if (e.key === 'Escape' && !ccPanel.hidden) {
    e.preventDefault();
    toggleCcPanel(false);
    return;
  }
  switch (e.key) {
    case ' ':
    case 'k':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      skip(-10);
      break;
    case 'ArrowRight':
      e.preventDefault();
      skip(10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      video.muted = false;
      syncVolume();
      break;
    case 'ArrowDown':
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
      video.muted = video.volume === 0;
      syncVolume();
      break;
    case 'm':
      toggleMute();
      break;
    case 'f':
      toggleFullscreen();
      break;
    case 'c':
      toggleCcPanel();
      break;
    default:
      break;
  }
  showUi();
  armHideUi();
  armIdle();
}

/* ---------- idle screen ---------- */

function armIdle() {
  clearTimeout(idleTimer);
  if (!item || !video.paused) return;
  idleTimer = setTimeout(showIdle, IDLE_DELAY);
}

function showIdle() {
  if (!item || !video.paused || !idleEl.hidden || panelOpen() || dragging || !errorBox.hidden) return;
  const t = video.ended ? duration : (video.currentTime || 0);
  const r = duration ? Math.min(1, Math.max(0, t / duration)) : 0;
  const pct = Math.round(r * 100);
  $('idleTitle').textContent = videoTitle.textContent;
  $('idleEp').textContent = epTag.textContent;
  $('idleBg').style.backgroundImage = video.poster ? `url("${video.poster}")` : '';
  $('idlePct').textContent = `${pct}% watched`;
  $('idleLeft').textContent = duration && r < 1 ? `${formatDuration(duration - t)} left` : (duration ? 'Finished' : '');
  $('idleProgress').setAttribute('aria-valuenow', String(pct));
  idleFill.style.transform = 'scaleX(0)';
  idleEl.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { idleFill.style.transform = `scaleX(${r})`; }));
  $('idleResume').focus({ preventScroll: true });
}

function hideIdle() {
  clearTimeout(idleTimer);
  idleEl.hidden = true;
}

/* Real input closes the screen and restarts the countdown. */
function wakeIdle() {
  const wasOpen = !idleEl.hidden;
  hideIdle();
  showUi();
  armIdle();
  return wasOpen;
}

function bindIdle() {
  /* Resume and the backdrop do the same thing: close the screen and play. */
  const resume = () => {
    hideIdle();
    if (video.paused) togglePlay();
    else { showUi(); armHideUi(); }
  };
  $('idleResume').addEventListener('click', resume);
  $('idleHome').addEventListener('click', (e) => {
    e.preventDefault();
    leaveToHome();
  });
  /* Anywhere but the two buttons resumes, the same as pressing Resume. */
  idleEl.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.idle-resume, .idle-home')) resume();
  });
  /* Hovering must not dismiss the screen: a passing cursor would otherwise
   * wake the player, and only the Resume button should start playback again. */
}

function showError(message) {
  for (const el of [videoTitle, epTag, timeEl]) el.classList.remove('sk-text');
  errorBox.hidden = false;
  $('errorText').textContent = message;
  loading.hidden = true;
  ui.style.display = 'none';
  video.pause();
}

function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.title,
    artist: 'Netflix Home',
    album: item.collection || 'Local library',
    artwork: [{ src: thumbUrl(item, 1280), sizes: '1280x720', type: 'image/jpeg' }],
  });
  navigator.mediaSession.setActionHandler('play', () => video.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => video.pause());
  navigator.mediaSession.setActionHandler('seekbackward', () => skip(-10));
  navigator.mediaSession.setActionHandler('seekforward', () => skip(10));
}

/* remember the volume across sessions */
const savedVolume = readJson('netflix-home:volume', 1);
lastVolume = typeof savedVolume === 'number' ? savedVolume : 1;
video.volume = lastVolume;
volume.addEventListener('change', () => writeJson('netflix-home:volume', video.volume));
