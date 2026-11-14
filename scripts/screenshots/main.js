const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
// Renders the UI with demo data (no real windows or devices) and saves README screenshots.
// Usage: npm run screenshots
const ROOT = path.join(__dirname, '..', '..'), OUT = path.join(ROOT, 'docs');
app.whenReady().then(async () => {
  process.env.QR = await require(ROOT + '/node_modules/qrcode').toDataURL('http://192.168.1.24:8765/k7qp', { margin: 1, width: 360, color: { dark: '#0f1117', light: '#ffffff' } });
  const w = new BrowserWindow({ width: 1180, height: 800, show: false, backgroundColor: '#0f1117', webPreferences: { preload: path.join(__dirname, 'preload.js'), partition: 'demo' + Date.now() } });
  await w.loadFile(ROOT + '/src/renderer/index.html');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(5000);
  const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name), (await w.webContents.capturePage()).toPNG()); };
  const js = (s) => w.webContents.executeJavaScript(s);
  await js(`document.body.classList.add('demo'); selectSource('screen:1'); selectTarget('cast:living');`);
  await shot('main.png');
  await js(`document.querySelector('.tab[data-tab="window"]').click(); selectSource('window:1'); selectTarget('web');`);
  await shot('browser.png');
  await js(`document.querySelector('.tab[data-tab="window"]').click(); selectTarget('cast:living'); state.phase='live'; updateSummary(); setStatus('Living Room TV · low latency · 1920×1080 · 60 fps · 12.4 Mbit/s · H.264 hardware', 'live');`);
  await shot('live.png');
  app.quit();
});
