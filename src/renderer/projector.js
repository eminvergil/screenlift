// Fullscreen output on a display connected by cable / AirPlay / Miracast.
// No encoding: the captured image is drawn directly by the GPU (lowest latency).
const video = document.getElementById('video');
const hint = document.getElementById('hint');
let fit = 'contain';

setTimeout(() => hint.classList.add('hide'), 3000);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

// If the image does not match the screen: fit, fill (crop), stretch or 1:1 pixels.
function applyFit() {
  const s = video.style;
  if (fit === 'none' && video.videoWidth) {
    const dpr = window.devicePixelRatio || 1;
    s.objectFit = 'fill';
    s.width = video.videoWidth / dpr + 'px';
    s.height = video.videoHeight / dpr + 'px';
    s.position = 'absolute';
    s.left = '50%';
    s.top = '50%';
    s.transform = 'translate(-50%, -50%)';
  } else {
    s.objectFit = fit === 'none' ? 'contain' : fit;
    s.width = s.height = s.position = s.left = s.top = s.transform = '';
  }
}
video.addEventListener('resize', applyFit);
window.screenlift.on('fit', (f) => {
  fit = f;
  applyFit();
});

(async () => {
  try {
    const opts = await window.screenlift.projectorOptions();
    fit = opts.fit;
    applyFit();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: opts.fps, max: opts.fps } },
      audio: false,
    });
    video.srcObject = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => window.close());
  } catch (e) {
    window.screenlift.projectorError(e.message || String(e));
  }
})();
