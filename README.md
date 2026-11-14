# 📺 ScreenLift

Cast your whole screen or a single app window to a TV, from Mac or Windows. You pick **what** to cast (a display or one window) and **where** to cast it (which TV or screen).

- **Chromecast / Google TV** with the same low-latency protocol Chrome uses (Cast Streaming), around 0.2–0.6 s of delay
- **DLNA smart TVs** (Samsung, LG, Sony, Philips, …), found automatically
- **Any browser**: open a link or scan a QR code on a TV, phone or tablet (WebRTC, ~100 ms)
- **Wired / AirPlay / Miracast displays**: full-screen at the display's refresh rate, with no encoding at all

## Download

Grab the latest `.dmg` (macOS) from [Releases](https://github.com/eminvergil/screenlift/releases).

> The app isn't notarized by Apple. On first launch, macOS may say it can't verify the app. Open **System Settings → Privacy & Security** and click **Open Anyway**, or run:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/ScreenLift.app
> ```

## Build from source

Requires Node.js 18 or newer.

```bash
git clone https://github.com/eminvergil/screenlift.git
cd screenlift
npm install
npm start
```

To build an installer:

```bash
npm run dist:mac
```

```bash
npm run dist:win
```

> Build the Windows installer on Windows. During `npm install`, `ffmpeg-static` downloads the ffmpeg binary only for the current OS.

## Usage

1. **What to cast**: pick a monitor from the *Screens* tab or a single window from the *Apps* tab. The search box filters the list.
2. **Where to cast**: pick a target.

| Target | How it works | Smoothness / latency |
|--------|--------------|----------------------|
| **Connected displays** | A TV connected by HDMI/USB-C, AirPlay (Mac) or Miracast (Windows, `Win + K` → *Extend*). The selected content is shown full screen on it. | Best: native refresh rate, no delay |
| **Via browser** | Open the address shown in the app (or scan the QR code) in the browser of a TV, phone or tablet. The picture arrives over WebRTC. | Very good: ~100 ms, 60+ fps, full resolution |
| **TVs on your network: DLNA** | Smart TVs such as Samsung, LG, Sony, Philips and Vestel are discovered automatically. | Up to 60 fps, 2–4 s delay |
| **TVs on your network: Chromecast** | Chromecast and Google TV / Android TV devices are discovered automatically and receive the stream over Cast Streaming, the mirroring protocol Chrome uses. | Up to 60 fps, ~0.2–0.6 s delay |

3. Press **Start casting**. If you change the source or the target while casting, the stream restarts automatically.

## Profiles

The profiles in the bottom bar set everything up with one click:

| Profile | Resolution | Frame rate | Buffer | Best for |
|---------|-----------|------------|--------|----------|
| 🎮 **Game** (default) | 1080p | Display refresh rate | 0 ms | Lowest latency |
| 🎬 **Movie / video** | Original | 60 | 200 ms | Smooth playback even on weak Wi-Fi |
| 📊 **Presentation** | Original | 30 | 50 ms | Crisp text, low bandwidth |
| 💎 **Max quality** | Original | Display refresh rate | 100 ms | Highest bitrate |
| 🔋 **Eco** | 720p | 30 | 100 ms | Battery and network friendly, H.264 |
| ⚙︎ **Custom** | — | — | — | Choose everything in the advanced settings |

Changing any advanced setting by hand switches the profile to **Custom**.

## Settings

- **Aspect**: for when the picture doesn't match the TV (a portrait window or a 16:10 Mac screen, for example):
  - *Fit*: the whole picture is visible, with black bars filling the gaps.
  - *Fill*: the screen is filled and overflowing edges are cropped.
  - *Stretch*: the screen is filled and the aspect ratio is distorted.
  - *Original size*: shown pixel for pixel, 1:1.

  On the browser and connected-display targets the ratio changes without interrupting the stream. In the TV's browser, the **⤢ Fit** button picks a ratio for that device only. On DLNA the stream restarts for a few seconds. On Chromecast the TV fits the picture itself.
- **Audio**: none, system audio (Windows; macOS 13+), or an audio input. If system audio isn't available on a Mac, you can select a virtual audio driver such as [BlackHole](https://existential.audio/blackhole/) as the audio input.
- **Advanced settings**:
  - *Resolution*: original, 4K, 1440p, 1080p or 720p. Downscaling happens on the GPU during capture.
  - *Frame rate*: the display's refresh rate (120/144 fps on 120/144 Hz displays), or 30, 60, 90, 120, 144.
  - *Priority*: smoothness (frame rate is kept when the network struggles), balanced, or sharpness.
  - *Codec*: auto, H.264, HEVC, AV1 or VP9 (see below).
  - *Latency buffer*: 0–400 ms. A bigger buffer stutters less on weak Wi-Fi but adds delay.
- **Hide this window from capture**: ScreenLift's own window won't show up on the TV.

Settings are remembered on this computer.

## Under the hood

- **Automatic codec selection**:
  - On the first cast, the app runs a short test stream to measure which codecs this computer can really encode on the GPU, and saves the result. It appears under *Advanced settings*, e.g. "Hardware encoding: H.264, HEVC".
  - When a TV or phone connects, it reports which codecs it can decode in hardware.
  - Each viewer gets the most efficient codec that runs in hardware on both ends, in the order AV1 > HEVC > VP9 > H.264. So a recent Windows GPU picks AV1, a Mac picks HEVC, and an older TV picks H.264.
  - Measured on a MacBook Air (2880×1800): 58–59 fps with hardware HEVC, no dropped frames.
- **Low latency on Chromecast (Cast Streaming)**:
  - The same approach as Chrome's "Cast tab": Google's mirroring receiver is launched on the TV, and video and audio travel over UDP as encrypted RTP packets.
  - Video is encoded once, on the GPU (WebCodecs; H.264, with VP8 as a fallback). Audio is sent as 10 ms Opus frames. No ffmpeg, temp files or HLS involved.
  - Lost packets are retransmitted when the TV asks for them. If the TV can't decode the picture, it requests a new keyframe.
  - The TV's playout buffer is 200 ms + the *Latency buffer* setting: about 200 ms with the *Game* profile and about 400 ms with *Movie*.
  - If the TV doesn't accept this mode, ScreenLift automatically falls back to an HLS stream (3–6 s delay).
  - The wire format follows Google's open-source [Open Screen](https://chromium.googlesource.com/openscreen/) implementation.
- **Hardware encoding on the DLNA path**:
  - ffmpeg finds a working hardware encoder by itself: VideoToolbox, NVIDIA NVENC, Intel Quick Sync, AMD AMF or Media Foundation.
  - DLNA (and Chromecast's HLS fallback) uses H.264 for compatibility. If you select *HEVC* manually, HEVC is used, which gives a sharper picture on 4K TVs at the same bitrate.
- **No blurry start**: WebRTC normally starts at a low bitrate and ramps up slowly. Because we're on a local network, the stream starts at a high bitrate right away. In testing this gave 57 fps at full resolution at the 2.5 s mark, instead of 12 fps.
- **Bitrate** is computed from resolution × fps × profile.
- **Connected displays aren't encoded at all**: the picture is drawn directly by the GPU, with no delay and at the display's refresh rate.
- **No background throttling**: casting doesn't slow down when the window is minimized. On Macs with two GPUs, the discrete GPU is used.
- **Live stats**:
  - The app's top bar shows the real resolution, fps, bitrate, codec and hardware status.
  - On the viewer page, the **ℹ︎ Info** button (or the `I` key) shows receiver-side fps, codec and dropped frames.

> Frame rates above 60 fps only help on the **Connected displays** and **Via browser** targets, and only if both the source display and the TV support them. DLNA and Chromecast players play at most 60 fps, so the app caps those targets at 60.

## Permissions

- **macOS**: on first use, the app asks for *Screen & System Audio Recording* permission (System Settings → Privacy & Security). It also asks for *Local Network* access to find TVs.
- **Windows**: the firewall asks for permission on first launch. Allow **Private networks** so TVs can connect to the computer.

## Troubleshooting

- **The TV isn't listed**: make sure the TV is on and on the same Wi-Fi network as the computer. Guest networks and "AP isolation" stop devices from seeing each other. In that case, use the *Via browser* target.
- **The port in the address isn't 8765**: if that port is taken by another program, ScreenLift tries 8766 and 8767, then picks a random port.
- **"Can't reach the computer" in the browser**: check that you typed the full address (including the 4-letter code at the end) and that the firewall allows the connection.
- **Stuttering**: on weak Wi-Fi, choose *Priority → Smoothness* or lower the resolution. For the smoothest result, connect the TV by cable (*Connected displays*).
- **AirPlay**: it's a closed Apple protocol, so it isn't supported directly. On a Mac, add the TV as a *separate display* via AirPlay. It then appears under *Connected displays* and you can cast any window to it.

## Icon

The icon source is `build/icon.svg`. After editing it, regenerate the Mac (`.icns`), Windows (`.ico`) and in-app icons with the command below (requires `rsvg-convert` and ImageMagick):

```bash
npm run icons
```

## Project layout

```
src/main.js                 Main process: windows, screen-capture permission, IPC
src/server.js               LAN server: viewer page, WebRTC signaling, TV streams
src/streamer.js             ffmpeg: hardware encoder selection, MPEG-TS / HLS output
src/dlna.js                 SSDP discovery + UPnP AVTransport control
src/cast.js                 Chromecast discovery (mDNS) + Cast v2 protocol (no dependencies)
src/mirror.js               Low-latency Chromecast mirroring: OFFER/ANSWER, encrypted Cast RTP, RTCP (NACK/PLI)
src/renderer/               Main UI and the full-screen projector window
src/renderer/castmirror.js  WebCodecs video/audio encoders for mirroring
src/web/viewer.html         Viewer page for TV / phone browsers
src/assets/icon.png         Runtime icon
build/icon.*                Icon source (SVG) and installer icons (.icns / .ico / .png)
scripts/make-icons.sh       Generates all icons from the SVG
```

## License

[MIT](LICENSE)
