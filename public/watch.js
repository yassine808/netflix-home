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

let item = null;
let duration = 0;
let lastSaved = 0;
let hideTimer = null;
let dragging = false;
let pendingResume = 0;
let lastVolume = 1;

const params = new URLSearchParams(location.search);
const id = params.get('id');

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

  try {
    const res = await fetch(`/api/item/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    item = await res.json();
  } catch {
    showError('This title is no longer in your library. It may have been moved or renamed.');
    return;
  }

  document.title = `${item.title} | Netflix Home`;
  $('videoTitle').textContent = item.title;
  topKicker.textContent = item.collection && item.collection !== 'Movies' ? item.collection.toUpperCase() : 'NETFLIX HOME';
  qualityTag.textContent = qualityLabel(item) || '';
  document.body.style.background = '#000';
  video.poster = thumbUrl(item);
  video.src = `/api/stream/${encodeURIComponent(item.id)}`;
  video.load();
  bindEvents();
  syncVolume();
  updateTimeline();
  setMediaSession();
}

function bindEvents() {
  video.addEventListener('loadedmetadata', () => {
    duration = Number.isFinite(video.duration) ? video.duration : item.durationSec || 0;
    if (pendingResume > 0) {
      try {
        video.currentTime = Math.min(pendingResume, Math.max(0, duration - 5));
        showResume(pendingResume);
      } catch { /* ignore */ }
    }
    updateTimeline();
    loading.hidden = true;
    attemptAutoplay();
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

  $('backBtn').addEventListener('click', () => { location.href = '/'; });
  $('back10').addEventListener('click', () => skip(-10));
  $('fwd10').addEventListener('click', () => skip(10));
  muteBtn.addEventListener('click', toggleMute);
  fsBtn.addEventListener('click', toggleFullscreen);

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
    if (!dragging) tooltip.hidden = true;
  });

  player.addEventListener('pointermove', () => {
    showUi();
    if (!video.paused && !dragging) armHideUi();
  });
  player.addEventListener('pointerleave', () => {
    if (!video.paused) hideUiNow();
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
  muteBtn.querySelector('.i-vol').hidden = muted;
  muteBtn.querySelector('.i-mute').hidden = !muted;
  muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  volume.value = String(muted ? 0 : video.volume);
  volume.style.background = `linear-gradient(to right, #e50914 ${(muted ? 0 : video.volume) * 100}%, rgba(255,255,255,.5) ${(muted ? 0 : video.volume) * 100}%)`;
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
  armHideUi();
}

function onSeekMove(e) {
  updateTooltip(e);
  if (dragging) seekTo(seekRatio(e));
}

function onSeekUp(e) {
  if (!dragging) return;
  dragging = false;
  timeline.classList.remove('dragging');
  timeline.releasePointerCapture?.(e.pointerId);
  saveNow();
  if (!video.paused) armHideUi();
}

function seekTo(ratio) {
  if (!duration) return;
  video.currentTime = ratio * duration;
  played.style.width = `${ratio * 100}%`;
  thumb.style.left = `${ratio * 100}%`;
  timeEl.textContent = `${formatClock(ratio * duration)} / ${formatClock(duration)}`;
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

function showResume(sec) {
  resumeToast.textContent = `Resuming from ${formatClock(sec)}`;
  resumeToast.hidden = false;
  setTimeout(() => { resumeToast.hidden = true; }, 4000);
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
  if (video.paused || dragging) return;
  player.classList.add('hide-ui', 'hide-cursor');
}

function armHideUi() {
  clearTimeout(hideTimer);
  if (video.paused || dragging) return;
  hideTimer = setTimeout(hideUiNow, 2800);
}

function saveNow() {
  if (!item || !duration) return;
  lastSaved = Date.now();
  saveProgress(item.id, video.currentTime, duration);
}

function onKeyDown(e) {
  if (e.target instanceof HTMLInputElement && e.target !== volume) return;
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
