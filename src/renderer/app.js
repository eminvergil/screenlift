'use strict';

const api = window.screenlift;
const $ = (id) => document.getElementById(id);

const ICONS = {
  tv: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="2" y="4" width="20" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  cast: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M2 16a5 5 0 0 1 5 5M2 12a9 9 0 0 1 9 9M2 20h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  web: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  display: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 16v4M8 20h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

const state = {
  platform: 'darwin',
  tab: 'screen',
  sources: [],
  sourceId: null,
  displays: [],
  devices: new Map(),
  targetId: null, // 'web' | 'display:<id>' | 'dlna:…' | 'cast:…'
  phase: 'idle', // idle | starting | live
  session: null,
  webInfo: null,
  filter: '',
};

// ---------- Settings (remembered on this computer) ----------

const prefs = loadPrefs();
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('screenlift-prefs') || '{}');
  } catch (e) {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem('screenlift-prefs', JSON.stringify(prefs));
  } catch (e) { /* ignore */ }
}

// Refresh rate of the selected screen (if a window is selected, the highest among connected displays).
function sourceHz(src) {
  if (src && src.type === 'screen' && src.hz) return src.hz;
  return Math.max(60, ...state.displays.map((d) => d.hz || 60));
}

// ---------- Profiles ----------
// Each profile changes several settings together; manually changing one switches to "Custom".
// bpp: bits per pixel (bitrate = width × height × fps × bpp), latency: receiver buffer (ms).
const PROFILES = {
  game: {
    desc: 'Lowest latency, fps matches display refresh rate',
    quality: '1080', fps: 'auto', content: 'motion', codec: 'auto', latency: '0', bpp: 0.1,
  },
  movie: {
    desc: 'Original resolution, small buffer for stutter-free playback',
    quality: '0', fps: '60', content: 'balanced', codec: 'auto', latency: '200', bpp: 0.12,
  },
  present: {
    desc: 'Sharp text, low bandwidth',
    quality: '0', fps: '30', content: 'detail', codec: 'auto', latency: '50', bpp: 0.08,
  },
  max: {
    desc: 'Original resolution + display refresh rate, high bitrate',
    quality: '0', fps: 'auto', content: 'balanced', codec: 'auto', latency: '100', bpp: 0.16,
  },
  eco: {
    desc: 'Battery and network friendly: 720p 30 fps, H.264',
    quality: '720', fps: '30', content: 'motion', codec: 'H264', latency: '100', bpp: 0.07,
  },
};
const PROFILE_FIELDS = { quality: 'opt-quality', fps: 'opt-fps', content: 'opt-content', codec: 'opt-codec', latency: 'opt-latency' };

function currentProfile() {
  return PROFILES[prefs.profile] ? prefs.profile : prefs.profile === 'custom' ? 'custom' : 'game';
}

function applyProfile(name, { silent } = {}) {
  prefs.profile = name;
  const p = PROFILES[name];
  if (p) {
    for (const [key, id] of Object.entries(PROFILE_FIELDS)) {
      $(id).value = p[key];
      prefs[key] = p[key];
    }
  }
  savePrefs();
  document.querySelectorAll('.chip').forEach((c) => {
    const on = c.dataset.profile === name;
    c.classList.toggle('active', on);
    c.setAttribute('aria-checked', String(on));
  });
  $('profile-desc').textContent = p ? p.desc : 'Set it yourself in Advanced settings';
  if (name === 'custom') showAdvanced(true);
  updateFpsLabel();
  if (!silent && state.phase === 'live') restart();
}

function showAdvanced(on) {
  $('advanced').classList.toggle('hidden', !on);
  $('toggle-advanced').textContent = on ? 'Advanced settings ▴' : 'Advanced settings ▾';
  $('toggle-advanced').setAttribute('aria-expanded', String(on));
}

function options() {
  const fpsVal = $('opt-fps').value;
  const profile = PROFILES[currentProfile()];
  return {
    height: Number($('opt-quality').value), // 0 = original
    fps: fpsVal === 'auto' ? sourceHz(currentSource()) : Number(fpsVal),
    content: $('opt-content').value,
    codec: $('opt-codec').value,
    latency: Number($('opt-latency').value),
    fit: $('opt-fit').value,
    bpp: profile ? profile.bpp : 0.1,
    audio: $('opt-audio').value,
  };
}

// ---------- Hardware codec detection ----------
// Measures which codecs are actually GPU-encoded on this computer with a short local test
// stream (the real encoder, not a guess). For privacy, Chromium only reports this while the
// screen is being captured, so the probe runs in the background on the first cast and is cached.
// Until then the browser's own estimate (MediaCapabilities) is used.
const CODEC_MIME = { H264: 'video/H264', H265: 'video/H265', AV1: 'video/AV1', VP9: 'video/VP9' };
const CODEC_NAMES = { H264: 'H.264', H265: 'HEVC', AV1: 'AV1', VP9: 'VP9' };
const CODEC_EFFICIENCY = { AV1: 3, H265: 2, VP9: 1, H264: 0 };
let hwEncode = { H264: true }; // assumption until measured
let hwMeasured = false;
const HW_CACHE_KEY = 'screenlift-hw2:' + navigator.userAgent;

async function loadHardwareGuess() {
  try {
    const cached = JSON.parse(localStorage.getItem(HW_CACHE_KEY) || 'null');
    if (cached) {
      hwEncode = cached;
      hwMeasured = true;
      return;
    }
  } catch (e) { /* ignore */ }
  const available = senderCodecs();
  const guess = { H264: true };
  for (const [key, mime] of Object.entries(CODEC_MIME)) {
    if (key === 'H264' || !available.has(mime)) continue;
    try {
      const r = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: mime, width: 1920, height: 1080, bitrate: 10e6, framerate: 60 },
      });
      guess[key] = !!(r.supported && r.powerEfficient);
    } catch (e) {
      guess[key] = false;
    }
  }
  hwEncode = guess;
}

function senderCodecs() {
  try {
    return new Set(RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType));
  } catch (e) {
    return new Set(['video/H264']);
  }
}

let probing = false;
async function probeHardwareEncoders() {
  if (hwMeasured || probing) return;
  probing = true;

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  const draw = setInterval(() => {
    ctx.fillStyle = `hsl(${(frame += 7) % 360} 70% 50%)`;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#fff';
    ctx.fillRect((frame * 9) % 1200, 300, 80, 80);
  }, 16);
  const track = canvas.captureStream(60).getVideoTracks()[0];
  const available = senderCodecs();
  const result = {};
  try {
    // All codecs are tried at once (~2 s).
    await Promise.all(
      Object.entries(CODEC_MIME)
        .filter(([, mime]) => available.has(mime))
        .map(async ([key, mime]) => {
          result[key] = await probeOne(track, mime).catch(() => null);
        })
    );
  } finally {
    clearInterval(draw);
    track.stop();
    probing = false;
  }
  // null: the browser didn't report it (no capture active). Keep the estimate, don't cache.
  if (Object.values(result).some((v) => v === null)) return;
  hwEncode = result;
  hwMeasured = true;
  try {
    localStorage.setItem(HW_CACHE_KEY, JSON.stringify(result));
  } catch (e) { /* ignore */ }
  renderHwInfo();
}

async function probeOne(track, mime) {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const tr = a.addTransceiver(track, { direction: 'sendonly' });
    const codecs = RTCRtpSender.getCapabilities('video').codecs;
    tr.setCodecPreferences(codecs.filter((c) => c.mimeType === mime));
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
    await new Promise((r) => setTimeout(r, 2000));
    for (const r of (await a.getStats()).values()) {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        return typeof r.powerEfficientEncoder === 'boolean' ? r.powerEfficientEncoder : null;
      }
    }
    return null;
  } finally {
    a.close();
    b.close();
  }
}

function renderHwInfo() {
  const hw = Object.keys(hwEncode).filter((k) => hwEncode[k]).map((k) => CODEC_NAMES[k]);
  const note = hwMeasured ? '' : ' <span class="muted">(estimate; measured on first cast)</span>';
  $('hw-info').innerHTML = hw.length
    ? `Hardware encoding: <b>${hw.join(', ')}</b>${note}`
    : 'No hardware encoder found (CPU encoding)';
}

// Codec choice per viewer: the most efficient codec that runs in hardware on both ends.
// caps: decode capabilities reported by the viewer ({ H264: { supported, hw } ... }) or null.
function pickCodec(caps, pref) {
  const available = senderCodecs();
  const candidates = Object.keys(CODEC_MIME).filter(
    (k) => available.has(CODEC_MIME[k]) && (!caps || !caps[k] || caps[k].supported !== false)
  );
  if (!candidates.length) return 'H264';
  if (pref !== 'auto' && candidates.includes(pref)) return pref;
  const viewerHw = (k) => (caps && caps[k] && caps[k].hw !== null ? caps[k].hw : k === 'H264');
  const score = (k) =>
    (hwEncode[k] ? 100 : 0) + (viewerHw(k) ? 60 : 0) + CODEC_EFFICIENCY[k] - (caps && caps[k] ? 0 : 50 * (k !== 'H264'));
  return candidates.sort((x, y) => score(y) - score(x))[0];
}

function updateFpsLabel() {
  const opt = $('opt-fps').querySelector('option[value="auto"]');
  if (opt) opt.textContent = `Display refresh rate (${sourceHz(currentSource())} fps)`;
}

// ---------- Status / notifications ----------

function setStatus(text, level = 'info') {
  $('status-text').textContent = text;
  $('status').className = 'status ' + level;
}

let toastTimer;
function toast(text, isError) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 7000 : 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Sources ----------

let loadingSources = false;
async function refreshSources() {
  if (loadingSources) return;
  loadingSources = true;
  $('refresh-sources').classList.add('spin');
  try {
    state.sources = await api.sources();
    if (!state.sources.find((s) => s.id === state.sourceId)) {
      const remembered = state.sources.find((s) => s.id === prefs.sourceId);
      state.sourceId = remembered ? remembered.id : (state.sources.find((s) => s.type === 'screen') || {}).id || null;
    }
    renderSources();
    updateSummary();
    updateFpsLabel();
  } catch (e) {
    console.error(e);
    $('source-grid').innerHTML = `<div class="empty">Could not load screen list: ${escapeHtml(e.message)}</div>`;
  } finally {
    loadingSources = false;
    $('refresh-sources').classList.remove('spin');
  }
}

function renderSources() {
  const screens = state.sources.filter((s) => s.type === 'screen');
  const windows = state.sources.filter((s) => s.type === 'window');
  $('count-screen').textContent = screens.length;
  $('count-window').textContent = windows.length;
  $('source-filter').classList.toggle('hidden', state.tab !== 'window');

  let list = state.tab === 'screen' ? screens : windows;
  if (state.tab === 'window' && state.filter) {
    const q = state.filter.toLocaleLowerCase();
    list = list.filter((s) => s.name.toLocaleLowerCase().includes(q));
  }
  const grid = $('source-grid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty">${
      state.tab === 'screen' ? 'No screens found. Check permissions.' : 'No open app windows found.'
    }</div>`;
    return;
  }
  grid.innerHTML = list
    .map(
      (s) => `
    <button class="card ${s.id === state.sourceId ? 'selected' : ''}" data-id="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}">
      <div class="thumb"><img src="${s.thumbnail}" alt=""></div>
      <div class="card-name">${s.icon ? `<img src="${s.icon}" alt="">` : ''}<span>${escapeHtml(s.name)}</span></div>
    </button>`
    )
    .join('');
}

$('source-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  selectSource(card.dataset.id);
});

function selectSource(id) {
  if (id === state.sourceId) return;
  state.sourceId = id;
  prefs.sourceId = id;
  savePrefs();
  renderSources();
  updateSummary();
  updateFpsLabel();
  if (state.phase === 'live') restart();
}

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderSources();
  })
);
$('source-filter').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderSources();
});
$('refresh-sources').addEventListener('click', refreshSources);

// ---------- Targets ----------

function targetRow(id, icon, name, sub, badge) {
  return `
    <button class="target ${id === state.targetId ? 'selected' : ''}" data-target="${escapeHtml(id)}">
      <span class="ico">${icon}</span>
      <span class="meta"><div class="t-name">${escapeHtml(name)}</div><div class="t-sub">${escapeHtml(sub)}</div></span>
      ${badge ? `<span class="badge ${badge.cls}">${badge.text}</span>` : ''}
    </button>`;
}

function renderTargets() {
  const devices = [...state.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('tv-list').innerHTML = devices
    .map((d) =>
      targetRow(
        d.id,
        d.kind === 'cast' ? ICONS.cast : ICONS.tv,
        d.name,
        [d.model, d.host].filter(Boolean).join(' · '),
        d.kind === 'cast' ? { cls: 'cast', text: 'Chromecast' } : { cls: 'dlna', text: 'DLNA' }
      )
    )
    .join('');
  $('tv-empty').classList.toggle('hidden', devices.length > 0 && !scanning);
  if (!scanning && state.lanDenied && !devices.length) {
    $('tv-empty').innerHTML =
      '<b>macOS is blocking ScreenLift from your local network</b>, so it can’t see any TVs. ' +
      'Turn on ScreenLift under System Settings → Privacy & Security → Local Network, then come back here. ' +
      '<button class="btn small" id="lan-open">Open Local Network settings</button>';
    $('lan-open').addEventListener('click', () => api.openLocalNetworkSettings());
  } else {
    $('tv-empty').textContent = scanning
      ? 'Searching for TVs… The TV must be on and on the same Wi-Fi network as this computer.'
      : 'No TVs found. Make sure the TV is on and on the same network, then scan again. If it still isn’t found, use “Via browser”.';
  }

  $('web-list').innerHTML = targetRow(
    'web',
    ICONS.web,
    'TV browser / phone / tablet',
    'Open the address or QR code to start watching instantly',
    null
  );
  $('web-info').classList.toggle('hidden', state.targetId !== 'web');

  $('display-list').innerHTML = state.displays
    .map((d) =>
      targetRow(
        'display:' + d.id,
        ICONS.display,
        d.name + (d.primary ? ' (main display)' : ''),
        `${d.width}×${d.height} · shown fullscreen`,
        null
      )
    )
    .join('');
  $('display-hint').textContent =
    state.displays.length < 2
      ? state.platform === 'darwin'
        ? 'Connect a TV via HDMI or AirPlay (Control Center → Screen Mirroring → “Use As Separate Display”) and it will appear here.'
        : 'Connect a TV via HDMI or Miracast (Win + K → select the TV → “Extend”) and it will appear here.'
      : 'The selected screen or app will be shown fullscreen on this display.';
}

document.querySelector('.targets').addEventListener('click', (e) => {
  const row = e.target.closest('.target');
  if (!row) return;
  selectTarget(row.dataset.target);
});

function selectTarget(id) {
  if (id === state.targetId) return;
  state.targetId = id;
  prefs.targetId = id;
  savePrefs();
  renderTargets();
  updateSummary();
  if (id === 'web') loadWebInfo();
  if (state.phase === 'live') restart();
}

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  $('scan').disabled = true;
  $('scan').textContent = 'Scanning…';
  renderTargets();
  try {
    const found = await api.discover();
    for (const d of found) state.devices.set(d.id, d);
    // Nothing found on a Mac: check whether macOS is blocking local-network access for this app.
    state.lanDenied = !state.devices.size && (await api.localNetwork().catch(() => 'ok')) === 'denied';
  } catch (e) {
    toast('TV scan failed: ' + e.message, true);
  } finally {
    scanning = false;
    $('scan').disabled = false;
    $('scan').textContent = 'Scan again';
    renderTargets();
  }
}
$('scan').addEventListener('click', scan);
$('display-settings').addEventListener('click', () => api.openDisplaySettings());

api.on('device-found', (d) => {
  state.devices.set(d.id, d);
  if (!state.targetId && prefs.targetId === d.id) state.targetId = d.id;
  renderTargets();
  updateSummary();
});

api.on('displays-changed', (displays) => {
  state.displays = displays;
  if (state.targetId && state.targetId.startsWith('display:') && !displays.find((d) => 'display:' + d.id === state.targetId)) {
    if (state.phase !== 'idle' && state.session && state.session.kind === 'display') stop('Display disconnected');
    state.targetId = null;
  }
  renderTargets();
  updateSummary();
  refreshSources();
});

async function loadWebInfo() {
  state.webInfo = await api.webInfo();
  const info = state.webInfo;
  if (info.qr) $('web-qr').src = info.qr;
  $('web-qr').classList.toggle('hidden', !info.qr);
  $('web-urls').innerHTML = info.urls.length
    ? info.urls.map((u, i) => `<div class="url ${i ? 'alt' : ''}">${escapeHtml(u)}</div>`).join('')
    : '<div class="muted">No network connection found. Connect to Wi-Fi or Ethernet.</div>';
}

let viewerCount = 0;
let lastStatsText = '';

async function updateLiveStats(session) {
  if (state.session !== session || !session.web) return;
  const st = await session.web.stats().catch(() => null);
  if (!st || !st.width) {
    lastStatsText = '';
  } else {
    const parts = [`${st.width}×${st.height}`, `${Math.round(st.fps || 0)} fps`];
    if (st.mbps) parts.push(`${st.mbps.toFixed(1)} Mbit/s`);
    parts.push((st.codec ? CODEC_NAMES[st.codec] || st.codec : '') + (st.hardware ? ' hardware' : ' software'));
    if (st.limited === 'bandwidth') parts.push('network slow');
    if (st.limited === 'cpu') parts.push('CPU overloaded');
    lastStatsText = parts.join(' · ');
  }
  renderLiveStatus();
}

async function updateMirrorStats(session) {
  if (state.session !== session || !session.mirror) return;
  const st = await session.mirror.stats();
  if (!st || state.session !== session) return;
  const parts = [targetName(state.targetId), 'low latency'];
  if (st.size) parts.push(`${st.size.w}×${st.size.h}`);
  parts.push(`${Math.round(st.fps)} fps`, `${st.mbps.toFixed(1)} Mbit/s`, (MIRROR_CODEC_NAMES[st.codec] || st.codec) + (st.hardware ? ' hardware' : ' software'));
  if (st.resent > 20) parts.push('Wi-Fi packet loss');
  setStatus(parts.join(' · '), 'live');
}
const MIRROR_CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' };

function renderLiveStatus() {
  if (state.phase !== 'live' || !state.session || state.session.kind !== 'web') return;
  const head = viewerCount ? `Live · ${viewerCount} viewer${viewerCount === 1 ? '' : 's'}` : 'Live · waiting for viewers';
  setStatus(lastStatsText && viewerCount ? `${head} · ${lastStatsText}` : head, 'live');
}

api.on('viewers', (list) => {
  viewerCount = list.length;
  const el = $('web-viewers');
  el.textContent = list.length ? `Watching: ${list.join(', ')}` : 'No viewers yet';
  el.classList.toggle('has', list.length > 0);
  renderLiveStatus();
});

// ---------- Summary and start button ----------

function currentSource() {
  return state.sources.find((s) => s.id === state.sourceId) || null;
}

function targetName(id) {
  if (!id) return null;
  if (id === 'web') return 'Browser';
  if (id.startsWith('display:')) {
    const d = state.displays.find((x) => 'display:' + x.id === id);
    return d ? d.name : null;
  }
  const dev = state.devices.get(id);
  return dev ? dev.name : null;
}

function updateSummary() {
  const src = currentSource();
  const tgt = targetName(state.targetId);
  const btn = $('start');
  if (state.phase === 'idle') {
    $('summary').innerHTML =
      src && tgt
        ? `<b>${escapeHtml(src.name)}</b> → <b>${escapeHtml(tgt)}</b>`
        : !src
        ? 'Choose a screen or app on the left'
        : 'Choose a target on the right';
    btn.textContent = 'Start casting';
    btn.classList.remove('stop');
    btn.disabled = !(src && tgt);
  } else {
    $('summary').innerHTML = src && tgt ? `<b>${escapeHtml(src.name)}</b> → <b>${escapeHtml(tgt)}</b>` : '';
    btn.textContent = state.phase === 'starting' ? 'Starting… (cancel)' : 'Stop casting';
    btn.classList.add('stop');
    btn.disabled = false;
  }
}

$('start').addEventListener('click', () => {
  if (state.phase === 'idle') start();
  else stop();
});

// ---------- Capture ----------

async function captureSource(sourceId, opts) {
  const wantSystemAudio = opts.audio === 'system';
  // Downscaling happens at capture time (on the GPU), so frames reach the encoder at the right size.
  const videoConstraints = { frameRate: { ideal: opts.fps, max: opts.fps } };
  if (opts.height) {
    videoConstraints.height = { max: opts.height };
    videoConstraints.width = { max: Math.round((opts.height * 32) / 9) };
  }
  await api.selectCapture({ sourceId, audio: wantSystemAudio });
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: wantSystemAudio });
  } catch (e) {
    if (!wantSystemAudio) throw e;
    await api.selectCapture({ sourceId, audio: false });
    stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: false });
  }
  if (wantSystemAudio && !stream.getAudioTracks().length) {
    toast('System audio is not available on this computer; continuing without audio. For audio, you can select an audio input (e.g. BlackHole).', true);
  }
  if (opts.audio.startsWith('dev:')) {
    await api.askMicrophone();
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: opts.audio.slice(4) },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    mic.getAudioTracks().forEach((t) => stream.addTrack(t));
  }
  const vt = stream.getVideoTracks()[0];
  if (vt && 'contentHint' in vt) vt.contentHint = opts.content === 'detail' ? 'detail' : 'motion';
  return stream;
}

// ---------- WebRTC (browser target) ----------

class WebSender {
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.peers = new Map();
    this.ws = null;
    this.closed = false;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not connect to the local server'));
      ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
      ws.onclose = () => {
        if (!this.closed) stop('Lost connection to the local server');
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async onMessage(msg) {
    if (msg.type === 'viewer-join') this.addViewer(msg.id, msg.caps).catch((e) => console.error(e));
    else if (msg.type === 'viewer-leave') this.removeViewer(msg.id);
    else if (msg.type === 'signal') {
      const pc = this.peers.get(msg.from);
      if (!pc) return;
      try {
        if (msg.data.sdp) await pc.setRemoteDescription(boostAnswer(msg.data.sdp, this.bitrate() / 1000));
        else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate);
      } catch (e) {
        console.warn('signal', e);
      }
    }
  }

  async addViewer(id, caps) {
    this.removeViewer(id);
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.peers.set(id, pc);
    const codec = pickCodec(caps, this.opts.codec);
    this.sendConfig(id);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'signal', to: id, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.tune(pc);
      if (pc.connectionState === 'failed') this.removeViewer(id);
    };
    for (const track of this.stream.getTracks()) {
      const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [this.stream] });
      if (track.kind === 'video') preferCodec(tr, codec);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: 'signal', to: id, data: { sdp: pc.localDescription } });
    this.tune(pc);
  }

  // Bitrate = pixels × fps × the profile's bits per pixel; easily carried on a local network.
  bitrate() {
    const st = this.stream.getVideoTracks()[0].getSettings();
    const scale = this.scale();
    const px = ((st.width || 1920) / scale) * ((st.height || 1080) / scale);
    return Math.min(80e6, Math.max(3e6, px * this.opts.fps * this.opts.bpp));
  }

  // Aspect and buffer settings are sent to the viewer and applied without interrupting the stream.
  sendConfig(id) {
    this.send({ type: 'signal', to: id, data: { config: { fit: this.opts.fit, latency: this.opts.latency } } });
  }

  setLive(changes) {
    Object.assign(this.opts, changes);
    for (const id of this.peers.keys()) this.sendConfig(id);
  }

  scale() {
    const st = this.stream.getVideoTracks()[0].getSettings();
    return this.opts.height && st.height > this.opts.height ? st.height / this.opts.height : 1;
  }

  // Actual frame rate, resolution, bitrate and encoder (hardware or not).
  async stats() {
    for (const pc of this.peers.values()) {
      if (pc.connectionState !== 'connected') continue;
      const report = await pc.getStats();
      for (const r of report.values()) {
        if (r.type !== 'outbound-rtp' || r.kind !== 'video') continue;
        const now = r.timestamp;
        const prev = this.lastStats;
        this.lastStats = { bytes: r.bytesSent, t: now };
        const mbps = prev && now > prev.t ? ((r.bytesSent - prev.bytes) * 8) / ((now - prev.t) / 1000) / 1e6 : null;
        return {
          width: r.frameWidth,
          height: r.frameHeight,
          fps: r.framesPerSecond,
          mbps,
          hardware: r.powerEfficientEncoder,
          codec: r.codecId && report.get(r.codecId) ? report.get(r.codecId).mimeType.replace('video/', '') : null,
          encoder: r.encoderImplementation,
          limited: r.qualityLimitationReason,
        };
      }
    }
    return null;
  }

  // Bitrate and resolution: most TVs decode H.264 in hardware.
  async tune(pc) {
    const prefs = { motion: 'maintain-framerate', balanced: 'balanced', detail: 'maintain-resolution' };
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = Math.round(this.bitrate());
      p.encodings[0].maxFramerate = this.opts.fps;
      p.encodings[0].scaleResolutionDownBy = this.scale();
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      p.degradationPreference = prefs[this.opts.content] || 'balanced';
      try {
        await sender.setParameters(p);
      } catch (e) {
        console.warn('setParameters', e);
      }
    }
  }

  removeViewer(id) {
    const pc = this.peers.get(id);
    if (pc) pc.close();
    this.peers.delete(id);
  }

  close() {
    this.closed = true;
    for (const id of [...this.peers.keys()]) this.removeViewer(id);
    if (this.ws) this.ws.close();
  }
}

// Browsers start streams at ~300 kbit/s and ramp up slowly (the first seconds look blurry).
// Since we're on a local network, we keep the start and minimum bitrates high.
function boostAnswer(desc, maxKbps) {
  if (!desc || desc.type !== 'answer') return desc;
  const max = Math.round(maxKbps);
  const startK = Math.min(max, 12000);
  const minK = Math.min(startK, 3000);
  const sdp = desc.sdp.replace(/^(a=fmtp:\d+ .*)$/gm, (line) => {
    if (/apt=|minptime|useinbandfec|x-google/.test(line)) return line;
    return `${line};x-google-start-bitrate=${startK};x-google-min-bitrate=${minK};x-google-max-bitrate=${max}`;
  });
  return { type: desc.type, sdp };
}

// Selected codec first, the others as fallbacks (if the viewer doesn't support the selected one).
function preferCodec(transceiver, key) {
  if (!RTCRtpSender.getCapabilities || !transceiver.setCodecPreferences) return;
  const codecs = RTCRtpSender.getCapabilities('video').codecs;
  const mime = CODEC_MIME[key] || 'video/H264';
  const rank = (c) => {
    if (c.mimeType === mime) {
      if (mime !== 'video/H264') return 0;
      const f = c.sdpFmtpLine || '';
      return /packetization-mode=1/.test(f) && /profile-level-id=42e01f/.test(f) ? 0 : 1;
    }
    if (c.mimeType === 'video/H264') return 2;
    if (Object.values(CODEC_MIME).includes(c.mimeType)) return 3;
    return 4; // rtx, red, ulpfec…
  };
  try {
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch (e) { /* if unsupported, keep default order */ }
}

// ---------- TV target (DLNA / Chromecast) ----------

function pickRecorderMime(hasAudio) {
  const a = hasAudio ? ',opus' : '';
  const list = [`video/webm;codecs=h264${a}`, `video/webm;codecs=vp8${a}`, `video/webm;codecs=vp9${a}`, 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// ---------- Start / stop ----------

let startToken = 0;

async function start() {
  const src = currentSource();
  const targetId = state.targetId;
  if (!src || !targetId) return;
  const opts = options();
  const token = ++startToken;
  state.phase = 'starting';
  updateSummary();
  setStatus('Starting…', 'busy');
  const session = { kind: null, stream: null, recorder: null, web: null };
  state.session = session;
  const cancelled = () => token !== startToken;

  try {
    if (targetId.startsWith('display:')) {
      const displayId = targetId.slice(8);
      if (src.type === 'screen' && String(src.displayId) === displayId) {
        throw new Error('You can’t cast a screen onto itself. Choose another screen or an app.');
      }
      session.kind = 'display';
      await api.projectorOpen({ displayId, sourceId: src.id, fps: opts.fps, fit: opts.fit });
      if (cancelled()) return;
      state.phase = 'live';
      setStatus(`${targetName(targetId)} · showing fullscreen · press Esc to close`, 'live');
      updateSummary();
      return;
    }

    const isTv = targetId !== 'web';
    // TV media players play at most 60 fps; if "original" is selected, use a safe 1080p.
    const captureOpts = isTv ? { ...opts, fps: Math.min(opts.fps, 60), height: opts.height || 1080 } : opts;
    session.stream = await captureSource(src.id, captureOpts);
    if (cancelled()) return session.stream.getTracks().forEach((t) => t.stop());
    showPreview(session.stream);
    // Measure the hardware encoders for real while capture is active (first time only).
    if (!hwMeasured) setTimeout(() => probeHardwareEncoders().catch(() => {}), 500);
    session.stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.session === session) stop('The shared window was closed');
    });

    if (targetId === 'web') {
      session.kind = 'web';
      if (!state.webInfo) await loadWebInfo();
      session.web = new WebSender(session.stream, opts);
      await session.web.connect(state.webInfo.senderUrl);
      if (cancelled()) return;
      state.phase = 'live';
      setStatus('Live · open the address in the TV browser', 'live');
      session.statsTimer = setInterval(() => updateLiveStats(session), 2000);
    } else {
      // Chromecast / Google TV: first try the low-latency mirroring Chrome uses;
      // if the TV rejects it, fall back to the standard (HLS) stream below.
      if (targetId.startsWith('cast:')) {
        session.kind = 'mirror';
        const mirror = new CastMirror(session.stream, captureOpts);
        session.mirror = mirror;
        mirror.onfail = (msg) => {
          if (state.session === session) stop(msg);
        };
        try {
          const info = await mirror.start(targetId);
          if (cancelled()) return;
          state.phase = 'live';
          setStatus(`${targetName(targetId)} · low latency (${info.targetDelay} ms) · connecting…`, 'live');
          session.statsTimer = setInterval(() => updateMirrorStats(session), 2000);
          updateSummary();
          return;
        } catch (e) {
          await mirror.close();
          session.mirror = null;
          if (cancelled()) return;
          console.warn('Low-latency mirroring failed', e);
          toast('Low-latency mirroring failed (' + friendlyError(e) + '). Switching to standard streaming.', true);
        }
      }
      session.kind = 'tv';
      const hasAudio = session.stream.getAudioTracks().length > 0;
      const mimeType = pickRecorderMime(hasAudio);
      const tv = await api.tvStart({
        deviceId: targetId,
        hasAudio,
        height: captureOpts.height,
        fps: captureOpts.fps,
        fit: opts.fit,
        bpp: opts.bpp,
        // H.264 is the most compatible codec for TV players; HEVC only if selected manually.
        codec: opts.codec === 'H265' ? 'hevc' : 'h264',
      });
      session.encoder = tv && tv.encoder;
      // Intermediate (hardware) encode at a high bitrate so the final stream to the TV loses no quality.
      const st = session.stream.getVideoTracks()[0].getSettings();
      const recBps = Math.min(50e6, Math.max(10e6, (st.width || 1920) * (st.height || 1080) * captureOpts.fps * 0.15));
      const recorder = new MediaRecorder(session.stream, {
        mimeType,
        videoBitsPerSecond: Math.round(recBps),
        audioBitsPerSecond: 192000,
      });
      session.recorder = recorder;
      let chain = Promise.resolve();
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        chain = chain.then(() => e.data.arrayBuffer()).then((buf) => {
          if (state.session === session) api.tvChunk(buf);
        });
      };
      recorder.start(200);
      await api.tvPlay();
      if (cancelled()) return;
      state.phase = 'live';
      setStatus(
        `${targetName(targetId)} · ${captureOpts.height}p ${captureOpts.fps} fps · ${session.encoder || ''}`,
        'live'
      );
    }
    updateSummary();
  } catch (e) {
    if (cancelled()) return;
    console.error(e);
    await stop();
    const msg = friendlyError(e);
    setStatus(msg, 'error');
    toast(msg, true);
  }
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/Permission|NotAllowed|denied/i.test(m)) {
    return state.platform === 'darwin'
      ? 'No screen recording permission. Allow it in System Settings → Privacy & Security → Screen Recording.'
      : 'Screen capture permission was not granted.';
  }
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function stop(reason) {
  startToken++;
  const s = state.session;
  state.session = null;
  state.phase = 'idle';
  updateSummary();
  hidePreview();
  if (s) {
    clearInterval(s.statsTimer);
    if (s.recorder && s.recorder.state !== 'inactive') {
      try { s.recorder.stop(); } catch (e) { /* ignore */ }
    }
    if (s.web) s.web.close();
    if (s.mirror) await s.mirror.close();
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    if (s.kind === 'display') await api.projectorClose();
    if (s.kind === 'tv') await api.tvStop().catch(() => {});
  }
  setStatus(reason || 'Ready', reason ? 'error' : 'info');
  if (reason) toast(reason, true);
}

// Aspect and buffer change without interrupting the stream; other settings restart it.
function applyLiveChange(key, value) {
  const s = state.session;
  if (!s) return;
  if (key === 'fit' && s.kind === 'web') return s.web.setLive({ fit: value });
  if (key === 'fit' && s.kind === 'display') return api.projectorFit(value);
  if (key === 'latency' && s.kind === 'web') return s.web.setLive({ latency: Number(value) });
  if (key === 'fit' && s.kind === 'mirror') return; // the TV fits the image itself
  // The buffer applies live to the browser target, and to Chromecast mirroring via a restart.
  if (key === 'latency' && s.kind !== 'web' && s.kind !== 'mirror') return;
  restart();
}

let restartTimer;
function restart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    await stop();
    start();
  }, 150);
}

api.on('projector-closed', () => {
  if (state.session && state.session.kind === 'display') stop();
});
api.on('mirror-keyframe', () => {
  if (state.session && state.session.mirror) state.session.mirror.requestKeyFrame();
});
api.on('mirror-failed', (reason) => {
  if (state.session && state.session.kind === 'mirror') stop(reason || 'TV mirroring stopped');
});
api.on('stream-failed', () => {
  if (state.session && state.session.kind === 'tv') stop('TV stream stopped');
});
api.on('status', ({ text, level }) => {
  if (state.phase !== 'idle' || level === 'error') setStatus(text, level === 'ok' ? 'live' : level === 'error' ? 'error' : 'busy');
});

function showPreview(stream) {
  const v = $('preview');
  v.srcObject = stream;
  v.classList.remove('hidden');
  v.play().catch(() => {});
}
function hidePreview() {
  const v = $('preview');
  v.srcObject = null;
  v.classList.add('hidden');
}

// ---------- Audio options ----------

async function refreshAudioOptions() {
  const sel = $('opt-audio');
  const current = sel.value || prefs.audio || 'none';
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch (e) { /* ignore */ }
  const opts = [
    ['none', 'No audio'],
    ['system', state.platform === 'win32' ? 'System audio' : 'System audio (macOS 13+)'],
    ...devices
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ['dev:' + d.deviceId, '🎙 ' + (d.label || `Audio input ${i + 1}`)]),
  ];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  sel.value = opts.find(([v]) => v === current) ? current : 'none';
}

// ---------- Startup ----------

function bindPrefs() {
  const map = {
    'opt-quality': 'quality',
    'opt-fps': 'fps',
    'opt-content': 'content',
    'opt-codec': 'codec',
    'opt-latency': 'latency',
    'opt-fit': 'fit',
    'opt-audio': 'audio',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    if (prefs[key] && [...el.options].some((o) => o.value === prefs[key])) el.value = prefs[key];
    el.addEventListener('change', async () => {
      prefs[key] = el.value;
      savePrefs();
      // If a profile-controlled setting is changed manually, switch to the "Custom" profile.
      if (key in PROFILE_FIELDS && PROFILES[currentProfile()]) applyProfile('custom', { silent: true });
      if (key === 'fps') updateFpsLabel();
      if (key === 'audio' && el.value.startsWith('dev:')) {
        await api.askMicrophone();
        refreshAudioOptions();
      }
      if (state.phase === 'live') applyLiveChange(key, el.value);
    });
  }
  document.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      if (chip.dataset.profile !== currentProfile()) applyProfile(chip.dataset.profile);
    })
  );
  $('toggle-advanced').addEventListener('click', () => showAdvanced($('advanced').classList.contains('hidden')));
  applyProfile(currentProfile(), { silent: true });
  if (currentProfile() === 'custom') {
    // In the custom profile, restore the saved settings.
    for (const [key, id] of Object.entries(PROFILE_FIELDS)) {
      if (prefs[key] && [...$(id).options].some((o) => o.value === prefs[key])) $(id).value = prefs[key];
    }
    updateFpsLabel();
  }
  const hide = $('opt-hide');
  hide.checked = prefs.hide !== false;
  api.hideFromCapture(hide.checked);
  hide.addEventListener('change', () => {
    prefs.hide = hide.checked;
    savePrefs();
    api.hideFromCapture(hide.checked);
  });
}

async function init() {
  const info = await api.platform();
  state.platform = info.platform;
  document.body.classList.add(info.platform === 'darwin' ? 'mac' : 'win');

  const perms = await api.permissions();
  if (perms.screen === 'denied' || perms.screen === 'restricted') $('perm-banner').classList.remove('hidden');
  $('perm-open').addEventListener('click', () => api.openPermissionSettings());

  await refreshAudioOptions();
  bindPrefs();
  navigator.mediaDevices.addEventListener('devicechange', refreshAudioOptions);

  state.displays = await api.displays();
  if (prefs.targetId && (prefs.targetId === 'web' || prefs.targetId.startsWith('display:'))) {
    if (prefs.targetId === 'web' || state.displays.find((d) => 'display:' + d.id === prefs.targetId)) {
      state.targetId = prefs.targetId;
    }
  }
  renderTargets();
  if (state.targetId === 'web') loadWebInfo();
  else loadWebInfo().catch(() => {});

  await refreshSources();
  scan();

  await loadHardwareGuess().catch(() => {});
  renderHwInfo();

  // Refresh thumbnails when the window regains focus.
  window.addEventListener('focus', () => {
    if (state.phase === 'idle') refreshSources();
    // Coming back from System Settings after allowing Local Network access: scan again.
    if (state.lanDenied) scan();
  });
  setInterval(() => {
    if (document.hasFocus() && state.phase === 'idle') refreshSources();
  }, 10000);
}

init().catch((e) => {
  console.error(e);
  setStatus('Startup error: ' + e.message, 'error');
});
