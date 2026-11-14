const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  session,
  shell,
  systemPreferences,
} = require('electron');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const dlna = require('./dlna');
const cast = require('./cast');
const { MirrorSession } = require('./mirror');
const { Streamer, detectEncoder, ENCODER_LABELS } = require('./streamer');
const { LanServer } = require('./server');

// WebRTC: TV browsers may not resolve ".local" names, so expose the real local IP.
// On macOS, enable ScreenCaptureKit audio so system sound can be captured.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
// On dual-GPU Macs, use the discrete GPU (capture + hardware encoding).
app.commandLine.appendSwitch('force_high_performance_gpu');
// Don't slow down the stream when the window is minimized.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.setName('ScreenLift');

// Allow only one ScreenLift instance (so two don't try to stream to the same TV).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const isMac = process.platform === 'darwin';
const ICON = path.join(__dirname, 'assets', 'icon.png');
const isWin = process.platform === 'win32';

let mainWindow = null;
let projectorWindow = null;
let pendingCapture = null; // { sourceId, audio }
let activeDevice = null; // { kind, device, session }
const streamer = new Streamer();
const lan = new LanServer(streamer);
const knownDevices = new Map();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function status(text, level = 'info') {
  send('status', { text, level });
}

// Pick the local IP on the same subnet as the TV (Wi-Fi and Ethernet may both be connected).
function localIpFor(remote) {
  const toInt = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a);
    }
  }
  if (remote && /^\d+\.\d+\.\d+\.\d+$/.test(remote)) {
    const r = toInt(remote);
    const hit = candidates.find((a) => (toInt(a.address) & toInt(a.netmask)) === (r & toInt(a.netmask)));
    if (hit) return hit.address;
  }
  const priv = candidates.find((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address));
  return (priv || candidates[0] || { address: '127.0.0.1' }).address;
}

function viewerUrls() {
  const ips = dlna.localIPv4s();
  const sorted = ips.sort((a, b) => Number(/^192\.168/.test(b)) - Number(/^192\.168/.test(a)));
  return sorted.map((ip) => `http://${ip}:${lan.port}/${lan.viewerKey}`);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: 'ScreenLift',
    backgroundColor: '#0f1117',
    icon: ICON,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  mainWindow.setContentProtection(true);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (projectorWindow) projectorWindow.close();
  });
}

function ownWindowSourceIds() {
  return BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .map((w) => w.getMediaSourceId());
}

async function listSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 250 },
    fetchWindowIcons: true,
  });
  const own = new Set(ownWindowSourceIds());
  const displays = screen.getAllDisplays();
  return sources
    .filter((s) => !own.has(s.id))
    .filter((s) => s.id.startsWith('screen:') || (s.name && !s.thumbnail.isEmpty()))
    .map((s, i) => {
      const isScreen = s.id.startsWith('screen:');
      let name = s.name;
      if (isScreen) {
        const d = displays.find((x) => String(x.id) === s.display_id);
        name = d ? displayLabel(d, displays.indexOf(d)) : s.name || `Display ${i + 1}`;
      }
      return {
        id: s.id,
        type: isScreen ? 'screen' : 'window',
        name,
        displayId: s.display_id || null,
        hz: isScreen ? displayHz(displays.find((x) => String(x.id) === s.display_id)) : null,
        thumbnail: s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      };
    });
}

function displayHz(d) {
  return d && d.displayFrequency ? Math.round(d.displayFrequency) : 60;
}

function displayLabel(d, index) {
  const name = d.label && d.label.trim() ? d.label.trim() : d.internal ? 'Built-in display' : `Display ${index + 1}`;
  return name;
}

function listDisplays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    name: displayLabel(d, i),
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    primary: d.id === primary.id,
    internal: !!d.internal,
    hz: displayHz(d),
  }));
}

// ---- Projector window (displays connected by cable / AirPlay / Miracast) ----

function openProjector(displayId) {
  closeProjector();
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  if (!display) throw new Error('The selected display is no longer connected');
  projectorWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    title: 'ScreenLift — Projector',
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  projectorWindow.setContentProtection(true);
  projectorWindow.loadFile(path.join(__dirname, 'renderer', 'projector.html'));
  projectorWindow.once('ready-to-show', () => {
    if (!projectorWindow) return;
    projectorWindow.setBounds(display.bounds);
    if (isMac) projectorWindow.setSimpleFullScreen(true);
    else projectorWindow.setFullScreen(true);
    projectorWindow.show();
    projectorWindow.focus();
  });
  projectorWindow.on('closed', () => {
    projectorWindow = null;
    send('projector-closed');
  });
}

function closeProjector() {
  if (projectorWindow && !projectorWindow.isDestroyed()) projectorWindow.close();
  projectorWindow = null;
}

// ---- Network TVs ----

async function discoverTargets() {
  const onDevice = (dev) => {
    knownDevices.set(dev.id, dev);
    send('device-found', publicDevice(dev));
  };
  const [d, c] = await Promise.all([dlna.discover(3000, onDevice), cast.discover(4000, onDevice)]);
  return [...d, ...c].map(publicDevice);
}

function publicDevice(dev) {
  return { id: dev.id, kind: dev.kind, name: dev.name, model: dev.model, host: dev.host };
}

async function startTvStream({ deviceId, hasAudio, height, fps, fit, codec, bpp }) {
  await stopTvStream();
  const device = knownDevices.get(deviceId);
  if (!device) throw new Error('TV not found. Refresh the list and try again');
  activeDevice = { kind: device.kind, device, session: null };
  await streamer.start({ mode: device.kind === 'cast' ? 'hls' : 'ts', hasAudio, height, fps, fit, codec, bpp });
  return { encoder: ENCODER_LABELS[streamer.encoder] || streamer.encoder };
}

async function playTvStream() {
  if (!activeDevice) throw new Error('Stream has not been started');
  const { device } = activeDevice;
  status('Preparing video…');
  await streamer.waitReady();
  const base = `http://${localIpFor(device.host)}:${lan.port}/s/${lan.streamToken}`;
  const title = 'ScreenLift — ' + os.hostname().replace(/\.local$/, '');
  status(`Connecting to ${device.name}…`);
  if (device.kind === 'cast') {
    const s = new cast.CastSession(device);
    activeDevice.session = s;
    await s.play(`${base}/hls/live.m3u8`, 'application/x-mpegURL', title);
  } else {
    await dlna.play(device, `${base}/live.ts`, title);
  }
}

async function stopTvStream() {
  const active = activeDevice;
  activeDevice = null;
  streamer.stop();
  if (!active) return;
  if (active.kind === 'cast' && active.session) await active.session.stop();
  if (active.kind === 'dlna') await dlna.stop(active.device);
}

// ---- Chromecast low-latency mirroring (Cast Streaming) ----

let mirror = null;

async function startMirror(opts) {
  await stopMirror();
  await stopTvStream();
  const device = knownDevices.get(opts.deviceId);
  if (!device || device.kind !== 'cast') throw new Error('TV not found. Refresh the list and try again');
  const m = new MirrorSession(device);
  mirror = m;
  m.on('keyframe', () => {
    if (mirror === m) send('mirror-keyframe');
  });
  m.on('failed', (reason) => {
    if (mirror !== m) return;
    mirror = null;
    send('mirror-failed', reason);
  });
  status(`Starting mirroring on ${device.name}…`);
  try {
    return await m.start(opts);
  } catch (e) {
    if (mirror === m) mirror = null;
    await m.stop();
    throw e;
  }
}

async function stopMirror() {
  const m = mirror;
  mirror = null;
  if (m) await m.stop();
}

streamer.on('exit', (code, stderr) => {
  if (!activeDevice) return;
  console.error('ffmpeg exited', code, stderr);
  status('Encoder stopped: ' + (stderr.trim().split('\n').pop() || 'unknown error'), 'error');
  send('stream-failed');
  stopTvStream();
});

lan.on('viewers', (list) => send('viewers', list));
lan.on('tv-connected', (addr) => {
  if (activeDevice) status(`${activeDevice.device.name} is receiving the stream (${String(addr).replace('::ffff:', '')})`, 'ok');
});

// ---- IPC ----

function registerIpc() {
  ipcMain.handle('platform', () => ({ platform: process.platform, version: app.getVersion() }));

  ipcMain.handle('permissions', () => {
    if (!isMac) return { screen: 'granted' };
    return { screen: systemPreferences.getMediaAccessStatus('screen') };
  });

  ipcMain.handle('open-permission-settings', () => {
    if (isMac) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });

  ipcMain.handle('open-display-settings', () => {
    if (isMac) shell.openExternal('x-apple.systempreferences:com.apple.Displays-Settings.extension');
    else if (isWin) shell.openExternal('ms-settings:display');
  });

  ipcMain.handle('ask-microphone', async () => {
    if (isMac) return systemPreferences.askForMediaAccess('microphone');
    return true;
  });

  ipcMain.handle('sources', () => listSources());
  ipcMain.handle('displays', () => listDisplays());
  ipcMain.handle('discover', () => discoverTargets());

  ipcMain.handle('web-info', async () => {
    const urls = viewerUrls();
    const qr = urls[0]
      ? await QRCode.toDataURL(urls[0], { margin: 1, width: 360, color: { dark: '#0f1117', light: '#ffffff' } })
      : null;
    return { urls, qr, port: lan.port, senderUrl: `ws://127.0.0.1:${lan.port}/ws?role=sender&s=${lan.senderSecret}` };
  });

  // Sets which screen/window the next getDisplayMedia call will capture.
  ipcMain.handle('select-capture', (_e, { sourceId, audio }) => {
    pendingCapture = { sourceId, audio: !!audio };
  });

  ipcMain.handle('projector-open', (_e, { displayId, sourceId, fps, fit }) => {
    pendingCapture = { sourceId, audio: false, fps, fit };
    openProjector(displayId);
  });
  ipcMain.handle('projector-close', () => closeProjector());
  ipcMain.handle('projector-options', () => ({
    fps: (pendingCapture && pendingCapture.fps) || 60,
    fit: (pendingCapture && pendingCapture.fit) || 'contain',
  }));
  // Aspect/fit mode changes without interrupting the stream.
  ipcMain.handle('projector-fit', (_e, fit) => {
    if (pendingCapture) pendingCapture.fit = fit;
    if (projectorWindow && !projectorWindow.isDestroyed()) projectorWindow.webContents.send('fit', fit);
  });
  ipcMain.on('projector-error', (_e, msg) => {
    status('Projector error: ' + msg, 'error');
    closeProjector();
  });

  ipcMain.handle('tv-start', (_e, opts) => startTvStream(opts));
  ipcMain.handle('tv-play', () => playTvStream());
  ipcMain.handle('tv-stop', () => stopTvStream());
  ipcMain.on('tv-chunk', (_e, buf) => streamer.write(Buffer.from(buf)));
  ipcMain.handle('mirror-start', (_e, opts) => startMirror(opts));
  ipcMain.handle('mirror-stop', () => stopMirror());
  ipcMain.handle('mirror-stats', () => (mirror ? { ...mirror.stats } : null));
  ipcMain.on('mirror-frame', (_e, f) => {
    if (mirror) mirror.sendFrame(f.kind, f.data, f.key, f.ts);
  });

  ipcMain.handle('hide-from-capture', (_e, on) => {
    if (mainWindow) mainWindow.setContentProtection(!!on);
  });
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (!pendingCapture) return callback({});
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const source = sources.find((s) => s.id === pendingCapture.sourceId);
        if (!source) return callback({});
        const streams = { video: source };
        if (pendingCapture.audio && request.audioRequested) streams.audio = 'loopback';
        callback(streams);
      } catch (e) {
        console.error(e);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

app.whenReady().then(async () => {
  try {
    await lan.listen(8765);
  } catch (e) {
    console.error('Failed to start server', e);
  }
  // During development (npm start), show the ScreenLift icon in the Dock instead of Electron's.
  if (isMac && !app.isPackaged && app.dock) app.dock.setIcon(ICON);
  registerIpc();
  registerDisplayMediaHandler();
  createMainWindow();
  // Probe hardware encoders up front so starting a stream doesn't have to wait.
  detectEncoder('h264')
    .then((e) => console.log('TV encoder (H.264):', e))
    .then(() => detectEncoder('hevc'))
    .then((e) => console.log('TV encoder (HEVC):', e));

  const pushDisplays = () => send('displays-changed', listDisplays());
  screen.on('display-added', pushDisplays);
  screen.on('display-removed', pushDisplays);
  screen.on('display-metrics-changed', pushDisplays);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  Promise.race([Promise.all([stopTvStream(), stopMirror()]), new Promise((r) => setTimeout(r, 2500))]).finally(() => {
    lan.close();
    app.quit();
  });
});
