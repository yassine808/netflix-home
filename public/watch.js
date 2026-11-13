import {
  formatClock, progressFor, saveProgress, qualityLabel, thumbUrl, readJson, writeJson,
} from './common.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const player = $('player');
const ui = $('playerUI');
const loading = $('playerLoading');
const errorBox = $('playerError');
const timeEl = $('time');
const playBtn = $('playBtn');
const centerPlay = $('centerPlay');
const timeline = $('timelineWrap');
const played = $('tlPlayed');
const buffer = $('tlBuffer');
const thumb = $('tlThumb');
const tooltip = $('tlTooltip');
const volume = $('volume');
const muteBtn = $('muteBtn');
const fsBtn = $('fsBtn');
const qualityTag = $('qualityTag');
const resumeToast = $('resumeToast');
const topKicker = $('topKicker');
const ccBtn = $('ccBtn');
const ccPanel = $('ccPanel');
const ccList = $('ccList');
const ccOffsetEl = $('ccOffset');
const subtitleLayer = $('subtitleLayer');
const subtitleText = $('subtitleText');
const preview = $('tlPreview');
const skipIntroBtn = $('skipIntro');
const speedBtn = $('speedBtn');

let item = null;
let duration = 0;
let lastSaved = 0;
let hideTimer = null;
let dragging = false;
let pendingResume = 0;
let lastVolume = 1;

const UI_HIDE_DELAY = 3000;
const SPEEDS = [0.75, 1, 1.25, 1.5];
const PREVIEW_HALF_MIN = 84;

let speedIndex = 1;
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
let subtitleLang = '';
let subtitleOffset = 0;
let subtitleRequest = 0;

const params = new URLSearchParams(location.search);
const id = params.get('id');
const SUB_PREFS_KEY = `netflix-home:subtitles:${id}`;
const INTRO_SKIP_KEY = `netflix-home:intro-skipped:${id}`;

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
  $('videoTitle').textContent = item.displayTitle || item.title;
  topKicker.textContent = item.collection && item.collection !== 'Movies' ? item.collection.toUpperCase() : 'NETFLIX HOME';
  qualityTag.textContent = qualityLabel(item) || '';
  document.body.style.background = '#000';
  video.poster = thumbUrl(item);
  video.src = `/api/stream/${encodeURIComponent(item.id)}`;
  video.load();
  bindEvents();
  syncVolume();
  updateTimeline();
  initSubtitles();
  setMediaSession();
}

function bindEvents() {
  video.addEventListener('loadedmetadata', () => {
    duration = Number.isFinite(video.duration) ? video.duration : item.durationSec || 0;
    if (pendingResume > 0) {
      const startAt = resumeStart();
      try {
        video.currentTime = startAt;
        showResume(startAt);
      } catch { /* ignore */ }
    }
    updateTimeline();
    loading.hidden = true;
    attemptAutoplay();
    initFrames();
    initIntro();
  });

  video.addEventListener('canplay', () => { loading.hidden = true; });
  video.addEventListener('waiting', () => { loading.hidden = false; });
  video.addEventListener('playing', () => {
    loading.hidden = true;
    player.classList.remove('paused');
    player.classList.remove('hide-cursor');
    setPlayIcon(true);
    armHideUi();
  });
  video.addEventListener('pause', () => {
    player.classList.add('paused');
    setPlayIcon(false);
    showUi();
    saveNow();
  });
  video.addEventListener('ended', () => {
    player.classList.add('paused');
    setPlayIcon(false);
    showUi();
    saveProgress(item.id, duration, duration);
  });
  video.addEventListener('timeupdate', () => {
    updateTimeline();
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
  centerPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', toggleFullscreen);

  $('backBtn').addEventListener('click', leaveToHome);
  $('back10').addEventListener('click', () => skip(-10));
  $('fwd10').addEventListener('click', () => skip(10));
  muteBtn.addEventListener('click', toggleMute);
  fsBtn.addEventListener('click', toggleFullscreen);
  ccBtn.addEventListener('click', () => toggleCcPanel());
  skipIntroBtn.addEventListener('click', skipIntroNow);
  speedBtn.addEventListener('click', cycleSpeed);
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow();
    else showUi();
  });
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);
  document.addEventListener('fullscreenchange', () => {
    fsBtn.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
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

function skip(seconds) {
  if (!duration) return;
  video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), duration - 0.5);
  showUi();
  armHideUi();
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

function cycleSpeed() {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  const rate = SPEEDS[speedIndex];
  video.playbackRate = rate;
  speedBtn.textContent = `${rate}×`;
  speedBtn.setAttribute('aria-label', `Playback speed ${rate}x`);
  toastInPlayer(`Playback speed ${rate}×`);
  showUi();
  armHideUi();
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
  const saved = readJson(SUB_PREFS_KEY, null);
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.lang === 'string') subtitleLang = saved.lang;
  if (Number.isFinite(saved.offset)) {
    subtitleOffset = Math.max(-SUB_OFFSET_LIMIT, Math.min(SUB_OFFSET_LIMIT, saved.offset));
  }
}

function saveSubtitlePrefs() {
  writeJson(SUB_PREFS_KEY, { lang: subtitleLang, offset: subtitleOffset });
}

async function initSubtitles() {
  loadSubtitlePrefs();
  updateOffsetLabel();
  try {
    const res = await fetch(`/api/subtitles/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    subtitleTracks = Array.isArray(data.tracks) ? data.tracks.filter((t) => t && t.lang) : [];
  } catch {
    subtitleTracks = [];
  }

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

function toggleCcPanel(force) {
  const open = typeof force === 'boolean' ? force : ccPanel.hidden;
  ccPanel.hidden = !open;
  ccBtn.setAttribute('aria-expanded', String(open));
  clearTimeout(hideTimer);
  if (open) {
    showUi();
    renderSubtitleList();
    ccPanel.querySelector('.cc-option.active')?.focus();
  } else {
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

function updateTimeline() {
  duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
  const t = video.currentTime || 0;
  const pct = duration ? (t / duration) * 100 : 0;
  played.style.width = `${pct}%`;
  thumb.style.left = `${pct}%`;
  timeEl.textContent = `${formatClock(t)} / ${formatClock(duration)}`;
  updateBuffer();
}

function updateBuffer() {
  if (!duration || !video.buffered.length) {
    buffer.style.width = '0%';
    return;
  }
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
  }
  buffer.style.width = `${Math.min(100, (end / duration) * 100)}%`;
}

function seekRatio(e) {
  const rect = timeline.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return ratio;
}

function onSeekDown(e) {
  if (!duration) return;
  dragging = true;
  timeline.classList.add('dragging');
  timeline.setPointerCapture?.(e.pointerId);
  seekTo(seekRatio(e));
  updateTooltip(e);
  updatePreview(e);
  armHideUi();
}

function onSeekMove(e) {
  updateTooltip(e);
  updatePreview(e);
  if (dragging) seekTo(seekRatio(e));
}

function onSeekUp(e) {
  if (!dragging) return;
  dragging = false;
  timeline.classList.remove('dragging');
  timeline.releasePointerCapture?.(e.pointerId);
  hidePreview();
  saveNow();
  if (!video.paused) armHideUi();
}

function seekTo(ratio) {
  if (!duration) return;
  video.currentTime = ratio * duration;
  played.style.width = `${ratio * 100}%`;
  thumb.style.left = `${ratio * 100}%`;
  timeEl.textContent = `${formatClock(ratio * duration)} / ${formatClock(duration)}`;
  syncSkipIntro();
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
  return video.poster || thumbUrl(item);
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

function showResume(sec) {
  toastInPlayer(`Resuming from ${formatClock(sec)}`);
}

function setPlayIcon(playing) {
  playBtn.querySelector('.i-play').hidden = playing;
  playBtn.querySelector('.i-pause').hidden = !playing;
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function showUi() {
  player.classList.remove('hide-ui', 'hide-cursor');
  clearTimeout(hideTimer);
}

function hideUiNow() {
  if (video.paused || dragging || !ccPanel.hidden) return;
  hidePreview();
  player.classList.add('hide-ui', 'hide-cursor');
}

function armHideUi() {
  clearTimeout(hideTimer);
  if (video.paused || dragging || !ccPanel.hidden) return;
  hideTimer = setTimeout(hideUiNow, UI_HIDE_DELAY);
}

function saveNow() {
  if (!item || !duration) return;
  lastSaved = Date.now();
  saveProgress(item.id, video.currentTime, duration);
}

function onKeyDown(e) {
  if (e.target instanceof HTMLInputElement && e.target !== volume) return;
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
}

function showError(message) {
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
    artwork: [{ src: thumbUrl(item), sizes: '1280x720', type: 'image/jpeg' }],
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
