// Chromecast / Google Cast support.
// Discovery uses mDNS (_googlecast._tcp); control uses the Cast v2 protocol (length-prefixed
// protobuf messages over TLS:8009). Since only one message type (CastMessage) is used,
// the protobuf codec is hand-written; no extra library needed.
const tls = require('tls');
const { EventEmitter } = require('events');
const { Bonjour } = require('bonjour-service');

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
  webrtc: 'urn:x-cast:com.google.cast.webrtc',
};
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';

// ---- Discovery ----

function discover(timeoutMs, onDevice) {
  return new Promise((resolve) => {
    const found = new Map();
    let bonjour;
    try {
      bonjour = new Bonjour();
    } catch (e) {
      return resolve([]);
    }
    const browser = bonjour.find({ type: 'googlecast' }, (svc) => {
      const addrs = (svc.addresses || []).filter((a) => a.includes('.'));
      const host = addrs[0] || (svc.referer && svc.referer.address);
      if (!host) return;
      const txt = svc.txt || {};
      const id = 'cast:' + (txt.id || host);
      if (found.has(id)) return;
      const dev = {
        id,
        kind: 'cast',
        name: txt.fn || svc.name || 'Chromecast',
        model: txt.md || 'Google Cast',
        host,
        port: svc.port || 8009,
      };
      found.set(id, dev);
      if (onDevice) onDevice(dev);
    });
    setTimeout(() => {
      try { browser.stop(); } catch (e) { /* ignore */ }
      try { bonjour.destroy(); } catch (e) { /* ignore */ }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

// ---- Minimal protobuf (CastMessage) ----

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function encodeMessage({ source, destination, namespace, payload }) {
  const str = (field, s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([varint((field << 3) | 2), varint(b.length), b]);
  };
  const body = Buffer.concat([
    varint((1 << 3) | 0), varint(0), // protocol_version = CASTV2_1_0
    str(2, source),
    str(3, destination),
    str(4, namespace),
    varint((5 << 3) | 0), varint(0), // payload_type = STRING
    str(6, JSON.stringify(payload)),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function decodeMessage(buf) {
  const msg = {};
  let i = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = buf[i++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  };
  while (i < buf.length) {
    const key = readVarint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      readVarint();
    } else if (wire === 2) {
      const len = readVarint();
      const val = buf.slice(i, i + len);
      i += len;
      if (field === 2) msg.source = val.toString('utf8');
      else if (field === 3) msg.destination = val.toString('utf8');
      else if (field === 4) msg.namespace = val.toString('utf8');
      else if (field === 6) msg.payload = val.toString('utf8');
    } else {
      break; // no other wire types in this message
    }
  }
  if (msg.payload) {
    try { msg.data = JSON.parse(msg.payload); } catch (e) { msg.data = null; }
  }
  return msg;
}

// ---- Session ----

class CastSession extends EventEmitter {
  constructor(device) {
    super();
    this.device = device;
    this.socket = null;
    this.requestId = 1;
    this.pending = new Map();
    this.transportId = null;
    this.sessionId = null;
    this.heartbeat = null;
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.device.host,
        port: this.device.port,
        rejectUnauthorized: false, // Cast devices use self-signed certificates
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Chromecast did not respond'));
      }, 8000);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.send('receiver-0', NS.connection, { type: 'CONNECT' });
        this.heartbeat = setInterval(() => this.send('receiver-0', NS.heartbeat, { type: 'PING' }), 5000);
        resolve();
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
        const wasOpen = !!this.socket;
        this.close();
        if (wasOpen) this.emit('closed');
      });
      socket.on('close', () => {
        const wasOpen = !!this.socket;
        this.close();
        if (wasOpen) this.emit('closed');
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const msg = decodeMessage(this.buffer.slice(4, 4 + len));
      this.buffer = this.buffer.slice(4 + len);
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    const data = msg.data || {};
    if (msg.namespace === NS.heartbeat && data.type === 'PING') {
      this.send(msg.source, NS.heartbeat, { type: 'PONG' });
      return;
    }
    // Notify if the app was closed (something else opened on the TV, stopped via remote).
    if (msg.namespace === NS.receiver && data.type === 'RECEIVER_STATUS' && this.sessionId) {
      const apps = (data.status && data.status.applications) || [];
      if (!apps.some((a) => a.sessionId === this.sessionId)) this.emit('app-stopped');
    }
    if (msg.namespace === NS.connection && data.type === 'CLOSE' && msg.source === this.transportId) {
      this.emit('app-stopped');
    }
    this.emit('message', msg);
    if (data.requestId && this.pending.has(data.requestId)) {
      const { resolve, timer } = this.pending.get(data.requestId);
      clearTimeout(timer);
      this.pending.delete(data.requestId);
      resolve(data);
    }
  }

  send(destination, namespace, payload) {
    if (!this.socket) return;
    this.socket.write(encodeMessage({ source: 'sender-0', destination, namespace, payload }));
  }

  request(destination, namespace, payload, timeoutMs = 15000) {
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Chromecast timed out (' + payload.type + ')'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(destination, namespace, { ...payload, requestId });
    });
  }

  // Launches a receiver app on the TV and opens a virtual connection to it.
  async launch(appId) {
    if (!this.socket) await this.connect();
    const status = await this.request('receiver-0', NS.receiver, { type: 'LAUNCH', appId });
    if (status.type === 'LAUNCH_ERROR') throw new Error('Could not launch Chromecast app: ' + (status.reason || ''));
    const app = ((status.status && status.status.applications) || []).find((a) => a.appId === appId);
    if (!app) throw new Error('Chromecast receiver app did not start');
    this.transportId = app.transportId;
    this.sessionId = app.sessionId;
    this.send(this.transportId, NS.connection, { type: 'CONNECT' });
    return app;
  }

  async play(url, contentType, title) {
    await this.launch(DEFAULT_MEDIA_RECEIVER);
    const res = await this.request(this.transportId, NS.media, {
      type: 'LOAD',
      autoplay: true,
      currentTime: 0,
      media: {
        contentId: url,
        contentType,
        streamType: 'LIVE',
        metadata: { type: 0, metadataType: 0, title },
      },
    }, 30000);
    if (res.type === 'LOAD_FAILED' || res.type === 'LOAD_CANCELLED' || res.type === 'INVALID_REQUEST') {
      throw new Error('Chromecast could not open the stream (' + res.type + ')');
    }
  }

  async stop() {
    if (this.socket && this.sessionId) {
      try {
        await this.request('receiver-0', NS.receiver, { type: 'STOP', sessionId: this.sessionId }, 3000);
      } catch (e) { /* may already be closed */ }
    }
    this.close();
  }

  close() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Chromecast connection closed'));
    }
    this.pending.clear();
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.destroy();
    }
  }
}

module.exports = { discover, CastSession, NS };
