// Low-latency mirroring for Chromecast / Google TV (Cast Streaming).
//
// The same protocol Chrome's "Cast tab" feature uses:
//  1. Google's mirroring receiver (0F5096E8) is launched on the TV.
//  2. An OFFER is sent on the urn:x-cast:com.google.cast.webrtc channel; the TV replies with an
//     ANSWER giving its UDP port and the streams it selected.
//  3. Each encoded frame is encrypted with AES-128-CTR, split into Cast RTP packets and sent
//     over UDP. The TV reports lost packets (NACK) and key frame requests (PLI) via RTCP.
//
// Packet formats are taken from the Open Screen source code (cast/streaming/impl).
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { CastSession, NS } = require('./cast');

const MIRRORING_APP_ID = '0F5096E8';
// Android TV / Google TV receivers expect 127 for audio and 96 for video regardless of codec
// (Chrome always sends these too).
const PT_AUDIO = 127;
const PT_VIDEO = 96;
const MAX_PAYLOAD = 1400; // below 1472 (Ethernet MTU - IP - UDP), leaving room for headers
const RTCP_INTERVAL_MS = 500;
const HISTORY_FRAMES = 300; // recent frames kept for retransmission (per stream)
const NTP_UNIX_OFFSET = 2208988800;

const now = () => performance.timeOrigin + performance.now(); // Unix ms, sub-ms precision

function hex(buf) {
  return buf.toString('hex');
}

function ntpTimestamp(ms) {
  const secs = ms / 1000 + NTP_UNIX_OFFSET;
  const whole = Math.floor(secs);
  const frac = Math.floor((secs - whole) * 2 ** 32);
  const b = Buffer.alloc(8);
  b.writeUInt32BE(whole >>> 0, 0);
  b.writeUInt32BE(frac >>> 0, 4);
  return b;
}

class RtpStream {
  constructor({ kind, ssrc, payloadType, rate, codec }) {
    this.kind = kind;
    this.ssrc = ssrc;
    this.payloadType = payloadType;
    this.rate = rate; // RTP clock rate (90000 video, 48000 audio)
    this.codec = codec;
    this.key = crypto.randomBytes(16);
    this.ivMask = crypto.randomBytes(16);
    this.seq = crypto.randomInt(0, 0x10000);
    this.nextFrameId = 0;
    this.lastRtp = null;
    this.frames = new Map(); // frameId → { packets: Buffer[], resentAt: number[] }
    this.packetCount = 0;
    this.octetCount = 0;
    this.receiverSsrc = null;
  }

  encrypt(frameId, data) {
    const nonce = Buffer.alloc(16);
    nonce.writeUInt32BE(frameId >>> 0, 8);
    for (let i = 0; i < 16; i++) nonce[i] ^= this.ivMask[i];
    const c = crypto.createCipheriv('aes-128-ctr', this.key, nonce);
    return Buffer.concat([c.update(data), c.final()]);
  }

  // Splits a frame into Cast RTP packets.
  packetize(data, isKey, rtpTimestamp) {
    const frameId = this.nextFrameId++;
    const refId = isKey ? frameId : frameId - 1;
    const payload = this.encrypt(frameId, data);
    const count = Math.max(1, Math.ceil(payload.length / MAX_PAYLOAD));
    if (count > 0xfffe) throw new Error('Frame too large');
    const packets = [];
    for (let i = 0; i < count; i++) {
      const chunk = payload.subarray(i * MAX_PAYLOAD, Math.min(payload.length, (i + 1) * MAX_PAYLOAD));
      const p = Buffer.allocUnsafe(19 + chunk.length);
      p[0] = 0x80;
      p[1] = (i === count - 1 ? 0x80 : 0) | this.payloadType;
      // Sequence number is written at send time (retransmissions also get a new number).
      p.writeUInt32BE(rtpTimestamp >>> 0, 4);
      p.writeUInt32BE(this.ssrc >>> 0, 8);
      p[12] = (isKey ? 0x80 : 0) | 0x40; // key frame + "has reference frame ID", no extensions
      p[13] = frameId & 0xff;
      p.writeUInt16BE(i, 14);
      p.writeUInt16BE(count - 1, 16);
      p[18] = refId & 0xff;
      chunk.copy(p, 19);
      packets.push(p);
    }
    this.frames.set(frameId, { packets, resentAt: new Array(count).fill(0) });
    if (this.frames.size > HISTORY_FRAMES) this.frames.delete(this.frames.keys().next().value);
    this.lastRtp = rtpTimestamp >>> 0;
    return packets;
  }

  stamp(p) {
    p.writeUInt16BE(this.seq, 2);
    this.seq = (this.seq + 1) & 0xffff;
    this.packetCount++;
    this.octetCount += p.length - 12;
    return p;
  }

  // Expands an 8-bit frame ID to the full ID closest to the last sent frame.
  expandFrameId(low8) {
    const last = this.nextFrameId - 1;
    let id = (last & ~0xff) | low8;
    if (id > last) id -= 0x100;
    return id;
  }

  senderReport(t0) {
    const t = now();
    const b = Buffer.alloc(28);
    b[0] = 0x80; // V=2, no report blocks
    b[1] = 200;
    b.writeUInt16BE(6, 2); // length: number of 32-bit words - 1
    b.writeUInt32BE(this.ssrc >>> 0, 4);
    ntpTimestamp(t).copy(b, 8);
    b.writeUInt32BE(Math.round((t - t0) * (this.rate / 1000)) >>> 0, 16);
    b.writeUInt32BE(this.packetCount >>> 0, 20);
    b.writeUInt32BE(this.octetCount >>> 0, 24);
    return b;
  }
}

class MirrorSession extends EventEmitter {
  constructor(device) {
    super();
    this.device = device;
    this.cast = null;
    this.udp = null;
    this.remote = null;
    this.audio = null;
    this.video = null;
    this.t0 = 0;
    this.rtcpTimer = null;
    this.closed = false;
    this.lastPli = 0;
    this.stats = { frames: 0, bytes: 0, resent: 0, plis: 0 };
  }

  // opts: { width, height, fps, videoBitrate, audio: bool, targetDelay, codecs: ['h264','vp8'] }
  async start(opts) {
    const cast = new CastSession(this.device);
    this.cast = cast;
    cast.on('closed', () => this.fail('Lost connection to the TV'));
    cast.on('app-stopped', () => this.fail('The TV stopped mirroring'));
    await cast.launch(MIRRORING_APP_ID);
    if (this.closed) throw new Error('Cancelled');

    // Offer audio and video streams; the TV picks one of each that it supports.
    const targetDelay = Math.round(opts.targetDelay || 400);
    const baseSsrc = crypto.randomInt(1, 500000);
    const offered = [];
    if (opts.audio) {
      offered.push(new RtpStream({ kind: 'audio', ssrc: baseSsrc, payloadType: PT_AUDIO, rate: 48000, codec: 'opus' }));
    }
    for (const codec of opts.codecs || ['h264', 'vp8']) {
      offered.push(
        new RtpStream({ kind: 'video', ssrc: baseSsrc + 1 + offered.length, payloadType: PT_VIDEO, rate: 90000, codec })
      );
    }
    const supportedStreams = offered.map((s, index) => {
      const common = {
        index,
        type: s.kind === 'audio' ? 'audio_source' : 'video_source',
        codecName: s.codec,
        rtpProfile: 'cast',
        rtpPayloadType: s.payloadType,
        ssrc: s.ssrc,
        targetDelay,
        aesKey: hex(s.key),
        aesIvMask: hex(s.ivMask),
        receiverRtcpEventLog: false,
        timeBase: '1/' + s.rate,
      };
      if (s.kind === 'audio') return { ...common, channels: 2, bitRate: 128000 };
      return {
        ...common,
        maxFrameRate: `${Math.round(opts.fps * 1000)}/1000`,
        maxBitRate: Math.round(opts.videoBitrate),
        resolutions: [{ width: opts.width, height: opts.height }],
      };
    });

    const seqNum = crypto.randomInt(1, 1e9);
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cast.off('message', onMsg);
        reject(new Error('The TV did not respond to the mirroring offer'));
      }, 10000);
      const onMsg = (msg) => {
        if (msg.namespace !== NS.webrtc || !msg.data) return;
        const d = msg.data;
        if (d.type !== 'ANSWER' || (d.seqNum !== undefined && d.seqNum !== seqNum)) return;
        clearTimeout(timer);
        cast.off('message', onMsg);
        if (d.result !== 'ok' || !d.answer) {
          const why = (d.error && (d.error.description || d.error.code)) || d.result || 'unknown';
          return reject(new Error('The TV rejected mirroring: ' + why));
        }
        resolve(d.answer);
      };
      cast.on('message', onMsg);
      cast.send(cast.transportId, NS.webrtc, {
        type: 'OFFER',
        seqNum,
        offer: { castMode: 'mirroring', receiverGetStatus: false, supportedStreams },
      });
    });
    if (this.closed) throw new Error('Cancelled');

    const indexes = answer.sendIndexes || [];
    const ssrcs = answer.ssrcs || [];
    indexes.forEach((idx, i) => {
      const s = offered[idx];
      if (!s) return;
      s.receiverSsrc = ssrcs[i];
      if (s.kind === 'audio' && !this.audio) this.audio = s;
      if (s.kind === 'video' && !this.video) this.video = s;
    });
    if (!this.video) throw new Error('The TV accepted none of the video streams');
    if (!answer.udpPort) throw new Error('The TV did not provide a UDP port');

    this.remote = { host: this.device.host, port: answer.udpPort };
    await this.openUdp();
    this.t0 = now();
    this.rtcpTimer = setInterval(() => this.sendReports(), RTCP_INTERVAL_MS);
    return {
      videoCodec: this.video.codec,
      audioCodec: this.audio ? this.audio.codec : null,
      targetDelay,
    };
  }

  openUdp() {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket('udp4');
      this.udp = udp;
      udp.on('error', (e) => {
        reject(e);
        this.fail('Network error: ' + e.message);
      });
      udp.on('message', (buf) => this.onRtcp(buf));
      udp.bind(0, () => {
        try {
          udp.setSendBufferSize(4 * 1024 * 1024);
          udp.setRecvBufferSize(1024 * 1024);
        } catch (e) { /* system limit; continue with defaults */ }
        resolve();
      });
    });
  }

  sendRaw(buf) {
    if (!this.udp || this.closed) return;
    this.udp.send(buf, this.remote.port, this.remote.host, () => {});
  }

  // kind: 'audio' | 'video'; captureMs: capture time (Unix ms)
  sendFrame(kind, data, isKey, captureMs) {
    const s = kind === 'audio' ? this.audio : this.video;
    if (!s || !this.udp || this.closed) return;
    const rtp = Math.round((captureMs - this.t0) * (s.rate / 1000));
    // RTP timestamp must not go backwards (clock drift or out-of-order frame).
    const ts = s.lastRtp !== null && ((rtp - s.lastRtp) | 0) <= 0 ? (s.lastRtp + 1) >>> 0 : rtp >>> 0;
    const first = s.nextFrameId === 0;
    const packets = s.packetize(Buffer.from(data), isKey, ts);
    if (first) this.sendRaw(s.senderReport(this.t0)); // receiver learns timing from the first report
    for (const p of packets) this.sendRaw(s.stamp(p));
    if (kind === 'video') {
      this.stats.frames++;
      this.stats.bytes += data.byteLength;
    }
  }

  sendReports() {
    for (const s of [this.audio, this.video]) if (s && s.nextFrameId > 0) this.sendRaw(s.senderReport(this.t0));
  }

  // RTCP packets from the TV (several packets may arrive back-to-back).
  onRtcp(buf) {
    let off = 0;
    while (off + 4 <= buf.length) {
      const first = buf[off];
      const pt = buf[off + 1];
      const len = (buf.readUInt16BE(off + 2) + 1) * 4;
      if (first >> 6 !== 2 || off + len > buf.length) break;
      const pkt = buf.subarray(off, off + len);
      off += len;
      if (pt !== 206 || pkt.length < 12) continue; // only feedback / PLI matters
      const fmt = first & 0x1f;
      const mediaSsrc = pkt.readUInt32BE(8);
      const s = [this.audio, this.video].find((x) => x && x.ssrc === mediaSsrc);
      if (!s) continue;
      if (fmt === 1) {
        // Picture Loss Indicator: the TV can't decode the picture, request a key frame.
        if (s.kind === 'video') this.requestKeyFrame();
      } else if (fmt === 15 && pkt.length >= 16 && pkt.readUInt32BE(12) === 0x43415354 /* CAST */) {
        this.onFeedback(s, pkt);
      }
    }
  }

  onFeedback(s, pkt) {
    if (pkt.length < 20) return;
    const numLoss = pkt[17];
    let o = 20;
    const t = now();
    for (let i = 0; i < numLoss && o + 4 <= pkt.length; i++, o += 4) {
      const frameId = s.expandFrameId(pkt[o]);
      const pid = pkt.readUInt16BE(o + 1);
      const bits = pkt[o + 3];
      const f = s.frames.get(frameId);
      if (!f) {
        // A frame that is too old was requested; send a fresh key frame instead.
        if (s.kind === 'video') this.requestKeyFrame();
        continue;
      }
      const ids = [];
      if (pid === 0xffff) {
        for (let k = 0; k < f.packets.length; k++) ids.push(k);
      } else {
        ids.push(pid);
        for (let b = 0; b < 8; b++) if (bits & (1 << b)) ids.push(pid + b + 1);
      }
      for (const k of ids) {
        if (k >= f.packets.length) continue;
        if (t - f.resentAt[k] < 15) continue; // don't resend the same packet back-to-back
        f.resentAt[k] = t;
        this.sendRaw(s.stamp(Buffer.from(f.packets[k]))); // copy: the original send may still be queued
        this.stats.resent++;
      }
    }
  }

  requestKeyFrame() {
    const t = now();
    if (t - this.lastPli < 300) return;
    this.lastPli = t;
    this.stats.plis++;
    this.emit('keyframe');
  }

  fail(reason) {
    if (this.closed) return;
    this.stop();
    this.emit('failed', reason);
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.rtcpTimer);
    if (this.udp) {
      try { this.udp.close(); } catch (e) { /* ignore */ }
      this.udp = null;
    }
    if (this.cast) {
      const c = this.cast;
      this.cast = null;
      c.removeAllListeners('closed');
      c.removeAllListeners('app-stopped');
      await c.stop();
    }
  }
}

module.exports = { MirrorSession, RtpStream, MIRRORING_APP_ID };
