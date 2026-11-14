const { contextBridge } = require('electron');
const svg = (body, bg) => 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250" viewBox="0 0 400 250"><rect width="400" height="250" fill="${bg}"/>${body}</svg>`).toString('base64');
const icon = (c) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="${c}"/></svg>`).toString('base64');
const desktop = (hue) => svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${hue+60},70%,25%)"/></linearGradient></defs><rect width="400" height="250" fill="url(#g)"/><rect y="0" width="400" height="10" fill="#0006"/><rect x="60" y="45" width="210" height="130" rx="6" fill="#ffffffd0"/><rect x="60" y="45" width="210" height="16" rx="6" fill="#ddd"/><rect x="200" y="95" width="150" height="110" rx="6" fill="#1e1e2ee8"/><rect x="120" y="225" width="160" height="18" rx="6" fill="#ffffff55"/>`, '#000');
const sources = [
  { id: 'screen:1', type: 'screen', name: 'Built-in display', displayId: '1', hz: 120, thumbnail: desktop(220), icon: null },
  { id: 'screen:2', type: 'screen', name: 'Studio Display', displayId: '2', hz: 60, thumbnail: desktop(280), icon: null },
  { id: 'window:1', type: 'window', name: 'Movie Night — Video Player', thumbnail: svg(`<rect x="20" y="20" width="360" height="190" fill="#000"/><circle cx="200" cy="115" r="60" fill="#f4a63b"/><rect x="0" y="150" width="400" height="60" fill="#3d8c40"/><rect x="20" y="222" width="250" height="5" rx="2" fill="#e33"/><rect x="20" y="222" width="360" height="5" rx="2" fill="#fff3"/>`, '#111'), icon: icon('#e33') },
  { id: 'window:2', type: 'window', name: 'Slides — Quarterly Review', thumbnail: svg(`<rect x="30" y="30" width="340" height="190" fill="#fff"/><rect x="60" y="60" width="200" height="18" fill="#335"/><rect x="60" y="95" width="120" height="100" fill="#4a7dff"/><rect x="200" y="135" width="40" height="60" fill="#ffb020"/><rect x="250" y="110" width="40" height="85" fill="#26c281"/><rect x="300" y="80" width="40" height="115" fill="#4a7dff"/>`, '#ddd'), icon: icon('#ffb020') },
  { id: 'window:3', type: 'window', name: 'Code — screenlift', thumbnail: svg(`${[...Array(11)].map((_, i) => `<rect x="${30 + (i % 3) * 20}" y="${25 + i * 19}" width="${120 + ((i * 53) % 180)}" height="8" rx="3" fill="${['#c792ea','#82aaff','#c3e88d','#f78c6c'][i % 4]}"/>`).join('')}`, '#1e1e2e'), icon: icon('#4a7dff') },
  { id: 'window:4', type: 'window', name: 'Photos', thumbnail: svg(`${[...Array(12)].map((_, i) => `<rect x="${20 + (i % 4) * 92}" y="${20 + Math.floor(i / 4) * 72}" width="84" height="64" rx="4" fill="hsl(${i * 30},60%,55%)"/>`).join('')}`, '#f5f5f7'), icon: icon('#26c281') },
];
const devices = [
  { id: 'cast:living', kind: 'cast', name: 'Living Room TV', model: 'Google TV Streamer', host: '192.168.1.40' },
  { id: 'dlna:bedroom', kind: 'dlna', name: 'Bedroom Samsung', model: 'QLED 55"', host: '192.168.1.41' },
  { id: 'cast:kitchen', kind: 'cast', name: 'Kitchen display', model: 'Nest Hub', host: '192.168.1.42' },
];
const listeners = {};
contextBridge.exposeInMainWorld('screenlift', {
  platform: async () => ({ platform: 'darwin', version: '1.0.0' }),
  permissions: async () => ({ screen: 'granted' }),
  openPermissionSettings: async () => {}, openDisplaySettings: async () => {}, askMicrophone: async () => true,
  sources: async () => sources,
  displays: async () => [{ id: '1', name: 'Built-in display', width: 3024, height: 1964, primary: true, internal: true, hz: 120 }],
  discover: async () => devices,
  webInfo: async () => ({ urls: ['http://192.168.1.24:8765/k7qp'], qr: process.env.QR || null, port: 8765, senderUrl: '' }),
  selectCapture: async () => {}, projectorOpen: async () => {}, projectorClose: async () => {}, projectorOptions: async () => ({}), projectorFit: async () => {},
  projectorError: () => {}, tvStart: async () => ({}), tvPlay: async () => {}, tvStop: async () => {}, tvChunk: () => {},
  hideFromCapture: async () => {}, mirrorStart: async () => ({}), mirrorStop: async () => {}, mirrorStats: async () => null, mirrorFrame: () => {},
  on: (ch, fn) => { (listeners[ch] ||= []).push(fn); },
});
