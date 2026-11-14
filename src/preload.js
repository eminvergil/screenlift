const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('screenlift', {
  platform: invoke('platform'),
  permissions: invoke('permissions'),
  openPermissionSettings: invoke('open-permission-settings'),
  openDisplaySettings: invoke('open-display-settings'),
  askMicrophone: invoke('ask-microphone'),
  sources: invoke('sources'),
  displays: invoke('displays'),
  discover: invoke('discover'),
  webInfo: invoke('web-info'),
  selectCapture: invoke('select-capture'),
  projectorOpen: invoke('projector-open'),
  projectorClose: invoke('projector-close'),
  projectorOptions: invoke('projector-options'),
  projectorFit: invoke('projector-fit'),
  projectorError: (msg) => ipcRenderer.send('projector-error', msg),
  tvStart: invoke('tv-start'),
  tvPlay: invoke('tv-play'),
  tvStop: invoke('tv-stop'),
  tvChunk: (buf) => ipcRenderer.send('tv-chunk', buf),
  hideFromCapture: invoke('hide-from-capture'),
  mirrorStart: invoke('mirror-start'),
  mirrorStop: invoke('mirror-stop'),
  mirrorStats: invoke('mirror-stats'),
  mirrorFrame: (frame) => ipcRenderer.send('mirror-frame', frame),
  on: (channel, fn) => {
    const allowed = ['status', 'viewers', 'device-found', 'displays-changed', 'projector-closed', 'stream-failed', 'fit', 'mirror-keyframe', 'mirror-failed'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
