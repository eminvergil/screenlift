// Local network server:
//  - /<key>                → viewer page for TV / phone browsers (WebRTC, low latency)
//  - /ws                   → WebRTC signaling channel (sender = this app, viewers = browsers)
//  - /s/<token>/live.ts    → live MPEG-TS stream for DLNA TVs
//  - /s/<token>/hls/*      → HLS stream for Chromecast
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no easily confused characters (l/1, o/0, i)

function randomKey(len) {
  let s = '';
  for (const b of crypto.randomBytes(len)) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return s;
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
};

class LanServer extends EventEmitter {
  constructor(streamer) {
    super();
    this.streamer = streamer;
    this.viewerKey = randomKey(4);
    this.streamToken = crypto.randomBytes(12).toString('hex');
    this.senderSecret = crypto.randomBytes(16).toString('hex');
    this.port = 0;
    this.sender = null;
    this.viewers = new Map();
    this.nextViewerId = 1;
    this.viewerHtml = fs.readFileSync(path.join(__dirname, 'web', 'viewer.html'), 'utf8');
    this.icon = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
  }

  listen(preferredPort = 8765) {
    this.http = http.createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    // Try fixed ports first so the address on the TV stays the same across launches.
    const ports = [preferredPort, preferredPort + 1, preferredPort + 2, 0];
    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        const next = () => tryPort(ports[ports.indexOf(port) + 1]);
        this.http.removeAllListeners('error');
        this.http.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && port !== 0) next();
          else reject(err);
        });
        this.http.listen(port, '0.0.0.0', async () => {
          this.port = this.http.address().port;
          // macOS allows binding even if another program holds the same port on 127.0.0.1 only;
          // local connections would then go to that program. Verify the port is really ours.
          if (port !== 0 && !(await this.isOurs())) {
            this.http.close();
            return next();
          }
          resolve(this.port);
        });
      };
      tryPort(preferredPort);
    });
  }

  async isOurs() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/__screenlift`, { signal: AbortSignal.timeout(1500) });
      return (await res.text()) === this.senderSecret;
    } catch (e) {
      return false;
    }
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (url.pathname === '/__screenlift' && isLoopback(req.socket.remoteAddress)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(this.senderSecret);
    }

    if (url.pathname === '/icon.png' || url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(this.icon);
    }

    // Viewer page
    if (parts.length === 1 && parts[0].toLowerCase() === this.viewerKey) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(this.viewerHtml);
    }

    // TV streams
    if (parts[0] === 's' && parts[1] === this.streamToken) {
      if (parts[2] === 'live.ts' && this.streamer.mode === 'ts') {
        res.writeHead(200, {
          ...CORS,
          'Content-Type': 'video/mpeg',
          'Cache-Control': 'no-cache',
          Connection: 'close',
          'transferMode.dlna.org': 'Streaming',
          'contentFeatures.dlna.org':
            'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
        });
        if (req.method === 'HEAD') return res.end();
        this.emit('tv-connected', req.socket.remoteAddress);
        return this.streamer.addClient(res);
      }
      if (parts[2] === 'hls' && parts[3] && this.streamer.mode === 'hls') {
        const file = this.streamer.hlsFile(parts[3]);
        if (file) {
          const isPlaylist = file.endsWith('.m3u8');
          res.writeHead(200, {
            ...CORS,
            'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
            'Cache-Control': isPlaylist ? 'no-cache' : 'max-age=30',
          });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(file).on('error', () => res.end()).pipe(res);
        }
      }
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<meta name="viewport" content="width=device-width"><body style="font:20px sans-serif;background:#111;color:#eee;padding:40px">' +
          'ScreenLift is running. To watch, enter the address shown in the app (including the code at the end).</body>'
      );
    }
    res.writeHead(404);
    res.end();
  }

  upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const role = url.searchParams.get('role');
    const ok =
      (role === 'sender' && url.searchParams.get('s') === this.senderSecret && isLoopback(req.socket.remoteAddress)) ||
      (role === 'viewer' && (url.searchParams.get('k') || '').toLowerCase() === this.viewerKey);
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (role === 'sender') this.onSender(ws);
      else this.onViewer(ws, req);
    });
  }

  onSender(ws) {
    if (this.sender) this.sender.close();
    this.sender = ws;
    for (const [id, v] of this.viewers) if (v.ready) this.announce(id);
    ws.on('message', (raw) => {
      const msg = parse(raw);
      if (msg && msg.type === 'signal' && this.viewers.has(msg.to)) {
        send(this.viewers.get(msg.to).ws, { type: 'signal', data: msg.data });
      }
    });
    ws.on('close', () => {
      if (this.sender !== ws) return;
      this.sender = null;
      for (const v of this.viewers.values()) send(v.ws, { type: 'sender-gone' });
    });
  }

  onViewer(ws, req) {
    const id = this.nextViewerId++;
    const ua = req.headers['user-agent'] || '';
    const name = describeUA(ua) + ' (' + String(req.socket.remoteAddress).replace('::ffff:', '') + ')';
    // The viewer first reports which codecs it can decode (in hardware); the sender picks a codec accordingly.
    // Older browsers that don't report still connect after a short wait.
    const viewer = { ws, name, caps: null, ready: false };
    this.viewers.set(id, viewer);
    this.emitViewers();
    const markReady = () => {
      if (viewer.ready || !this.viewers.has(id)) return;
      viewer.ready = true;
      this.announce(id);
    };
    const capsTimer = setTimeout(markReady, 1500);
    ws.on('message', (raw) => {
      const msg = parse(raw);
      if (!msg) return;
      if (msg.type === 'caps') {
        viewer.caps = msg.caps && typeof msg.caps === 'object' ? msg.caps : null;
        clearTimeout(capsTimer);
        markReady();
      }
      if (msg.type === 'signal' && this.sender) send(this.sender, { type: 'signal', from: id, data: msg.data });
      if (msg.type === 'retry') this.announce(id);
    });
    ws.on('close', () => {
      clearTimeout(capsTimer);
      this.viewers.delete(id);
      this.emitViewers();
      if (this.sender) send(this.sender, { type: 'viewer-leave', id });
    });
  }

  announce(id) {
    const v = this.viewers.get(id);
    if (v && this.sender) send(this.sender, { type: 'viewer-join', id, name: v.name, caps: v.caps });
  }

  emitViewers() {
    this.emit('viewers', [...this.viewers.values()].map((v) => v.name));
  }

  close() {
    try { this.wss.close(); } catch (e) { /* ignore */ }
    try { this.http.close(); } catch (e) { /* ignore */ }
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function parse(raw) {
  try { return JSON.parse(raw.toString()); } catch (e) { return null; }
}

function describeUA(ua) {
  if (/Tizen|SMART-TV.*Samsung|SamsungBrowser.*TV/i.test(ua)) return 'Samsung TV';
  if (/Web0S|webOS|NetCast/i.test(ua)) return 'LG TV';
  if (/BRAVIA|Android TV|GoogleTV|AFT\w/i.test(ua)) return 'Android TV';
  if (/VESTEL|Vestel|HbbTV/i.test(ua)) return 'Smart TV';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'Browser';
}

module.exports = { LanServer };
