// ffmpeg process that turns the screen capture into an H.264 + AAC stream TVs can play.
// Input: WebM chunks from the UI's MediaRecorder (stdin).
// Output: live MPEG-TS over HTTP for DLNA, HLS (temp directory) for Chromecast.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function ffmpegPath() {
  let p = require('ffmpeg-static');
  // In the packaged app the binary is unpacked outside the asar archive.
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

const MAX_CLIENT_BACKLOG = 32 * 1024 * 1024;

// ---- Hardware encoder selection ----
// TV casting re-encodes the video; doing it on the GPU improves smoothness
// and keeps the CPU free. At startup the app probes which hardware encoder works.

function encoderArgs(name, bitrate, fps, level = '4.2') {
  const rate = ['-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate];
  const gop = ['-g', String(fps), '-keyint_min', String(fps), '-bf', '0'];
  const hevc = name.startsWith('hevc') || name === 'libx265';
  const profile = hevc ? 'main' : 'high';
  switch (name) {
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox':
      return { pix: 'nv12', args: ['-c:v', name, '-realtime', '1', '-prio_speed', '1', '-profile:v', profile, ...rate, ...gop] };
    case 'h264_nvenc':
    case 'hevc_nvenc':
      return { pix: 'yuv420p', args: ['-c:v', name, '-preset', 'p2', '-tune', 'll', '-rc', 'cbr', '-profile:v', profile, ...rate, ...gop] };
    case 'h264_qsv':
    case 'hevc_qsv':
      return { pix: 'nv12', args: ['-c:v', name, '-preset', 'veryfast', '-look_ahead', '0', '-profile:v', profile, ...rate, ...gop] };
    case 'h264_amf':
    case 'hevc_amf':
      return { pix: 'nv12', args: ['-c:v', name, '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'cbr', '-profile:v', profile, ...rate, ...gop] };
    case 'h264_mf':
    case 'hevc_mf':
      return { pix: 'nv12', args: ['-c:v', name, '-hw_encoding', '1', '-scenario', 'display_remoting', '-rate_control', 'cbr', ...rate, ...gop] };
    case 'libx265':
      return {
        pix: 'yuv420p',
        args: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency', ...rate, ...gop, '-x265-params', 'log-level=error'],
      };
    default:
      return {
        pix: 'yuv420p',
        args: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-level:v', level, ...rate, ...gop, '-sc_threshold', '0'],
      };
  }
}

// Hardware encoders, fastest first. If none works, fall back to the CPU encoder.
const CANDIDATES = {
  h264: {
    darwin: ['h264_videotoolbox'],
    win32: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'],
    linux: ['h264_nvenc', 'h264_qsv'],
    fallback: 'libx264',
  },
  hevc: {
    darwin: ['hevc_videotoolbox'],
    win32: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'],
    linux: ['hevc_nvenc', 'hevc_qsv'],
    fallback: 'libx265',
  },
};

function tryEncoder(name) {
  return new Promise((resolve) => {
    const { pix, args } = encoderArgs(name, '8M', 60);
    const p = spawn(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60',
      '-frames:v', '30', '-vf', `format=${pix}`, ...args, '-f', 'null', '-',
    ], { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill('SIGKILL'), 8000);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const encoderPromises = {};
function detectEncoder(family = 'h264') {
  if (!encoderPromises[family]) {
    encoderPromises[family] = (async () => {
      const c = CANDIDATES[family];
      for (const name of c[process.platform] || []) {
        if (await tryEncoder(name)) return name;
      }
      return c.fallback;
    })();
  }
  return encoderPromises[family];
}

const ENCODER_LABELS = {
  h264_videotoolbox: 'H.264 · Apple VideoToolbox (hardware)',
  h264_nvenc: 'H.264 · NVIDIA NVENC (hardware)',
  h264_qsv: 'H.264 · Intel Quick Sync (hardware)',
  h264_amf: 'H.264 · AMD AMF (hardware)',
  h264_mf: 'H.264 · Media Foundation (hardware)',
  libx264: 'H.264 · x264 (CPU)',
  hevc_videotoolbox: 'HEVC · Apple VideoToolbox (hardware)',
  hevc_nvenc: 'HEVC · NVIDIA NVENC (hardware)',
  hevc_qsv: 'HEVC · Intel Quick Sync (hardware)',
  hevc_amf: 'HEVC · AMD AMF (hardware)',
  hevc_mf: 'HEVC · Media Foundation (hardware)',
  libx265: 'HEVC · x265 (CPU)',
};

// Scaling filter for video that doesn't match the TV's 16:9 screen.
function fitFilter(fit, w, h) {
  const even = (e) => `trunc((${e})/2)*2`;
  switch (fit) {
    case 'cover': // cover: crop the edges
      return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h}`;
    case 'fill': // stretch: aspect ratio is distorted
      return `scale=${w}:${h}:flags=bilinear`;
    case 'none': // original size: no scaling; center-crop if larger, letterbox if smaller
      return `crop='${even(`min(iw,${w})`)}':'${even(`min(ih,${h})`)}',pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
    default: // contain: black bars
      return (
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bilinear,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`
      );
  }
}

class Streamer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.clients = new Set();
    this.hlsDir = null;
    this.mode = null;
    this.bytesOut = 0;
    this.encoder = null;
  }

  get running() {
    return !!this.proc;
  }

  async start({ mode, hasAudio, height = 1080, fps = 60, fit = 'contain', codec = 'h264', bpp = 0.1 }) {
    this.stop();
    this.mode = mode;
    this.bytesOut = 0;
    const family = codec === 'hevc' ? 'hevc' : 'h264';
    const encoder = await detectEncoder(family);
    this.encoder = encoder;
    const width = Math.round((height * 16) / 9 / 2) * 2;
    // Bits per pixel (per profile); HEVC delivers the same quality with ~35% fewer bits.
    // The cap is a rate TVs on Wi-Fi can comfortably handle.
    const bps = Math.min(30e6, Math.max(4e6, width * height * fps * bpp * (family === 'hevc' ? 0.7 : 1)));
    const videoBitrate = Math.round(bps / 1000) + 'k';
    const level = height >= 2160 ? (fps > 30 ? '5.2' : '5.1') : height >= 1440 ? '5.1' : height >= 1080 && fps > 30 ? '4.2' : '4.1';
    const { pix, args: encArgs } = encoderArgs(encoder, videoBitrate, fps, level);

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+genpts+nobuffer',
      '-probesize', '1M', '-analyzeduration', '1M',
      '-thread_queue_size', '1024',
      '-f', 'matroska', '-i', 'pipe:0',
    ];
    if (!hasAudio) {
      // Silent audio track: some TVs refuse to play video without audio.
      args.push('-thread_queue_size', '1024', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }
    args.push(
      '-map', '0:v:0',
      '-map', hasAudio ? '0:a:0' : '1:a:0',
      // Whatever the window size, send a standard 16:9 picture to the TV (using the selected fit mode).
      '-vf',
      `fps=${fps},${fitFilter(fit, width, height)},setsar=1,format=${pix}`,
      ...encArgs,
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'
    );

    if (mode === 'hls') {
      this.hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenlift-hls-'));
      args.push(
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
        '-hls_segment_filename', path.join(this.hlsDir, 'seg_%05d.ts'),
        path.join(this.hlsDir, 'live.m3u8')
      );
    } else {
      args.push(
        '-f', 'mpegts',
        '-mpegts_flags', '+resend_headers',
        '-muxdelay', '0', '-muxpreload', '0',
        '-flush_packets', '1',
        'pipe:1'
      );
    }

    const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (chunk) => {
      this.bytesOut += chunk.length;
      if (this.bytesOut === chunk.length) this.emit('ready');
      for (const res of this.clients) {
        if (res.writableLength > MAX_CLIENT_BACKLOG) {
          res.destroy(); // if the TV can't keep up, drop it; on reconnect it resumes from the current frame
          this.clients.delete(res);
        } else {
          res.write(chunk);
        }
      }
    });
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
      process.stdout.write('[ffmpeg] ' + d);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.closeClients();
      this.emit('exit', code, stderrTail);
    });
  }

  write(buf) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(buf);
  }

  // In DLNA mode, attaches the TV's HTTP connection to the stream.
  addClient(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  // Waits until the stream is ready to play (first bytes / first HLS segments).
  waitReady(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (!this.proc) return reject(new Error('Encoder (ffmpeg) exited unexpectedly'));
        if (this.mode === 'hls') {
          const playlist = path.join(this.hlsDir, 'live.m3u8');
          if (fs.existsSync(playlist) && (fs.readFileSync(playlist, 'utf8').match(/#EXTINF/g) || []).length >= 2) {
            return resolve();
          }
        } else if (this.bytesOut > 0) {
          return resolve();
        }
        if (Date.now() - started > timeoutMs) return reject(new Error('Could not encode video (timed out)'));
        setTimeout(check, 200);
      };
      check();
    });
  }

  hlsFile(name) {
    if (!this.hlsDir || !/^[\w.-]+$/.test(name)) return null;
    const p = path.join(this.hlsDir, name);
    return fs.existsSync(p) ? p : null;
  }

  closeClients() {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.stdin.end(); } catch (e) { /* ignore */ }
      proc.kill('SIGKILL');
    }
    this.closeClients();
    if (this.hlsDir) {
      const dir = this.hlsDir;
      this.hlsDir = null;
      setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 1000);
    }
    this.mode = null;
  }
}

module.exports = { Streamer, detectEncoder, ENCODER_LABELS };
