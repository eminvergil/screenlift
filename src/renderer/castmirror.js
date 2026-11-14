'use strict';

// Low-latency mirroring to Chromecast / Google TV: video and audio are encoded here, in a single
// pass on the GPU (WebCodecs); encoded frames go to the main process, which sends them to the TV
// over UDP as Cast Streaming packets (see src/mirror.js). No intermediate files, ffmpeg or HLS.

const MIRROR_CODECS = {
  // Codec → [name in the Cast offer, WebCodecs configuration]
  h264: (w, h, fps) => ({
    codec: w * h > 1920 * 1088 || fps > 60 ? 'avc1.640033' : 'avc1.64002A', // High 5.1 / 4.2
    avc: { format: 'annexb' },
  }),
  hevc: () => ({ codec: 'hvc1.1.6.L153.B0', hevc: { format: 'annexb' } }),
  vp9: () => ({ codec: 'vp09.00.41.08' }),
  av1: () => ({ codec: 'av01.0.12M.08' }),
  vp8: () => ({ codec: 'vp8' }),
};

const epochNow = () => performance.timeOrigin + performance.now();

function mirrorVideoConfig(codec, w, h, fps, bitrate, hw = 'no-preference') {
  return {
    ...MIRROR_CODECS[codec](w, h, fps),
    width: w,
    height: h,
    displayWidth: w,
    displayHeight: h,
    bitrate: Math.round(bitrate),
    framerate: fps,
    latencyMode: 'realtime',
    hardwareAcceleration: hw,
  };
}

// Codecs to offer the TV based on the user's codec preference (those this computer can
// encode). The TV picks one it supports; every receiver has H.264 and VP8.
// The hardware encoder is tried first for each codec: with "no-preference" Chromium may
// encode H.264 on the CPU (OpenH264) at small resolutions.
async function mirrorCodecCandidates(pref, w, h, fps) {
  const first = { H265: 'hevc', AV1: 'av1', VP9: 'vp9', H264: 'h264' }[pref];
  const order = [...new Set([first, 'h264', 'vp8'].filter(Boolean))];
  const out = [];
  for (const codec of order) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      try {
        const { supported } = await VideoEncoder.isConfigSupported(mirrorVideoConfig(codec, w, h, fps, 8e6, hw));
        if (supported) {
          out.push({ codec, hw });
          break;
        }
      } catch (e) { /* not supported */ }
    }
  }
  return out;
}

class CastMirror {
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.closed = false;
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.readers = [];
    this.forceKey = true;
    this.info = null;
    this.size = null;
    this.lastStats = null;
  }

  async start(deviceId) {
    const vt = this.stream.getVideoTracks()[0];
    const at = this.stream.getAudioTracks()[0] || null;
    const st = vt.getSettings();
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const w = even(st.width || 1920);
    const h = even(st.height || 1080);
    const fps = Math.min(60, this.opts.fps || 60);
    const candidates = await mirrorCodecCandidates(this.opts.codec, w, h, fps);
    const codecs = candidates.map((c) => c.codec);
    if (!codecs.length) throw new Error('No suitable video encoder found on this computer');
    const efficient = (c) => (c === 'hevc' || c === 'av1' ? 0.7 : 1);
    const bitrateFor = (c) => Math.min(20e6, Math.max(2e6, w * h * fps * (this.opts.bpp || 0.1) * efficient(c)));

    this.info = await api.mirrorStart({
      deviceId,
      width: w,
      height: h,
      fps,
      videoBitrate: Math.max(...codecs.map(bitrateFor)),
      audio: !!at,
      // Receiver playout buffer: retransmission needs at least ~200 ms.
      targetDelay: 200 + (Number(this.opts.latency) || 0),
      codecs,
    });
    if (this.closed) return this.info;
    this.codec = this.info.videoCodec;
    this.hw = (candidates.find((c) => c.codec === this.codec) || {}).hw;
    this.hardware = this.hw === 'prefer-hardware';
    this.fps = fps;
    this.bitrate = bitrateFor(this.codec);
    this.startVideo(vt);
    if (at && this.info.audioCodec) this.startAudio(at);
    return this.info;
  }

  requestKeyFrame() {
    this.forceKey = true;
  }

  configureVideo(w, h) {
    this.size = { w, h };
    this.videoEncoder.configure(mirrorVideoConfig(this.codec, w, h, this.fps, this.bitrate, this.hw));
    this.forceKey = true;
  }

  startVideo(track) {
    let base = null; // frame timestamp (µs) → Unix ms
    this.videoEncoder = new VideoEncoder({
      output: (chunk) => {
        if (this.closed) return;
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        api.mirrorFrame({ kind: 'video', data, key: chunk.type === 'key', ts: base + chunk.timestamp / 1000 });
      },
      error: (e) => this.onError('Video encoder error: ' + e.message),
    });
    const proc = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
    const reader = proc.readable.getReader();
    this.readers.push(reader);
    const pump = async () => {
      while (!this.closed) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        try {
          if (this.closed) break;
          // If the encoder can't keep up, don't queue stale frames; avoid building up latency.
          if (this.videoEncoder.encodeQueueSize > 1) continue;
          if (base === null) base = epochNow() - frame.timestamp / 1000;
          const w = frame.displayWidth & ~1;
          const h = frame.displayHeight & ~1;
          // If the window size changes, reconfigure the encoder for the new size (the TV fits the image itself).
          if (!this.size || this.size.w !== w || this.size.h !== h) this.configureVideo(w, h);
          const keyFrame = this.forceKey;
          this.forceKey = false;
          this.videoEncoder.encode(frame, { keyFrame });
        } finally {
          frame.close();
        }
      }
    };
    pump().catch((e) => this.onError('Could not capture video: ' + e.message));
  }

  startAudio(track) {
    let base = null;
    let configured = false;
    this.audioEncoder = new AudioEncoder({
      output: (chunk) => {
        if (this.closed) return;
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        api.mirrorFrame({ kind: 'audio', data, key: true, ts: base + chunk.timestamp / 1000 });
      },
      error: (e) => console.warn('Audio encoder error', e),
    });
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    this.readers.push(reader);
    const pump = async () => {
      while (!this.closed) {
        const { value: data, done } = await reader.read();
        if (done) break;
        try {
          if (this.closed || this.audioEncoder.state === 'closed') break;
          if (!configured) {
            configured = true;
            this.audioEncoder.configure({
              codec: 'opus',
              sampleRate: data.sampleRate,
              numberOfChannels: Math.min(2, data.numberOfChannels),
              bitrate: 128000,
              opus: { frameDuration: 10000 }, // 10 ms frames: same as Chrome, low latency
            });
          }
          if (base === null) base = epochNow() - data.timestamp / 1000;
          this.audioEncoder.encode(data);
        } finally {
          data.close();
        }
      }
    };
    pump().catch((e) => console.warn('Could not capture audio', e));
  }

  // For the top bar: actual fps and bitrate (from counters in the main process).
  async stats() {
    const s = await api.mirrorStats().catch(() => null);
    if (!s) return null;
    const t = performance.now();
    const prev = this.lastStats;
    this.lastStats = { t, ...s };
    if (!prev) return null;
    const dt = (t - prev.t) / 1000;
    return {
      fps: (s.frames - prev.frames) / dt,
      mbps: ((s.bytes - prev.bytes) * 8) / dt / 1e6,
      resent: s.resent - prev.resent,
      size: this.size,
      codec: this.codec,
      hardware: this.hardware,
    };
  }

  onError(msg) {
    if (this.closed) return;
    console.error(msg);
    if (this.onfail) this.onfail(msg);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.readers) r.cancel().catch(() => {});
    for (const enc of [this.videoEncoder, this.audioEncoder]) {
      if (enc && enc.state !== 'closed') {
        try { enc.close(); } catch (e) { /* ignore */ }
      }
    }
    await api.mirrorStop().catch(() => {});
  }
}
