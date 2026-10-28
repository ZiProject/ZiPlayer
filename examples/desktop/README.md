# Desktop Audio Integration: Electron and Tauri

This directory provides integration references and configuration examples for running `@ziplayer/client` inside desktop
application environments:

- **Electron** (Chromium renderer process)
- **Tauri** (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS)

Neither platform requires Node.js runtime APIs in the renderer or a custom native C/Rust audio output backend. The existing
`@ziplayer/client` Web Audio + Opus pipeline executes directly within the web frontend/renderer.

---

## Architecture Overview

```
                      +-----------------------------+
                      |   ZiPlayer Audio Engine     |
                      |  (Node.js / Discord Bot)    |
                      +--------------+--------------+
                                     |
                          Opus Wire Format v1
                       via WebSocket Gateway (/listen)
                                     |
                                     v
+-------------------------------------------------------------------------+
| Desktop Application Frontend (Electron Renderer / Tauri WebView)        |
|                                                                         |
|  1. WebSocket Client  -->  Receives Wire Format v1 Opus frames          |
|  2. OpusDecoderAdapter-->  WebAssembly decodes Opus to Float32 stereo   |
|  3. AudioWorkletNode  -->  Low-latency jitter buffer & PCM playback     |
|  4. AnalyserNode      -->  Hardware-accelerated spectrum & beat energy  |
|  5. AudioContext      -->  Output to OS default audio device            |
+-------------------------------------------------------------------------+
```

---

## 1. Electron Integration

### Security Requirements

- Keep `contextIsolation: true` and `nodeIntegration: false`.
- Do not move audio decoding or playback into the Node.js main process.
- All Web Audio and WebSocket communication operates within the Chromium renderer process.

### Configuration

#### Main Process (`main.js`)

```javascript
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

function createWindow() {
	const win = new BrowserWindow({
		width: 900,
		height: 600,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	win.loadFile("index.html");
}

app.whenReady().then(createWindow);
```

#### Preload Script (`preload.js`)

Only expose non-audio application APIs if required:

```javascript
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktopEnv", {
	platform: process.platform,
});
```

#### Renderer Process (`renderer.js`)

```javascript
import { WebAudioClient } from "@ziplayer/client";

const client = new WebAudioClient({
	startupBufferMs: 100,
	maxBufferSeconds: 2,
});

// Autoplay policy: Electron windows may launch with an un-interacted AudioContext.
// Listen for suspended notification or unlock on first user gesture.
client.addEventListener("suspended", () => {
	console.info("Audio suspended awaiting user click.");
});

client.addEventListener("statechange", ({ detail }) => {
	console.log(`Playback state changed: ${detail.state}`);
});

document.getElementById("connect-btn").addEventListener("click", async () => {
	// Unlock / resume AudioContext on user interaction
	await client.unlockAudio();

	await client.connect({
		gatewayUrl: "ws://127.0.0.1:8080",
		sessionId: "electron-guild-player",
	});
});

// Safe cleanup on window unload
window.addEventListener("beforeunload", async () => {
	await client.disconnect();
});
```

---

## 2. Tauri Integration

### Security Requirements and CSP

Tauri enforces Content Security Policy (CSP) headers in `src-tauri/tauri.conf.json`. For `@ziplayer/client` to function:

1. `connect-src` must permit WebSocket connections to the gateway (`ws:` and `wss:`).
2. `script-src` must include `'wasm-unsafe-eval'` (or `'unsafe-eval'`) because `opus-decoder` compiles WebAssembly from in-memory
   byte buffers.
3. If using dynamically generated AudioWorklet blobs, `script-src` must include `blob:` and `worker-src` must include `blob:`.
   Alternatively, supply a static `workletUrl`.

#### Tauri Configuration (`tauri.conf.json`)

```json
{
	"tauri": {
		"security": {
			"csp": "default-src 'self'; connect-src 'self' ws: wss: http: https:; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'"
		}
	}
}
```

#### Tauri Frontend Component (`app.js`)

```javascript
import { WebAudioClient, getFrequencyBands } from "@ziplayer/client";

// Initialize client
const client = new WebAudioClient({
	analyserOptions: { fftSize: 1024 },
});

// Handle user click to start listening
export async function startListening(gatewayUrl, sessionId) {
	// Ensure AudioContext is running on user interaction
	await client.unlockAudio();

	await client.connect({
		gatewayUrl,
		sessionId,
	});
}

// Cleanup on component unmount or window close
export async function stopListening() {
	await client.disconnect();
}
```

---

## 3. Real-Runtime Verification Checklist

| Environment                                | Verified in CI / Tests                           | Real-Runtime Verification Procedure                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard Browser (Chrome, Firefox, Safari) | Mocked in `@ziplayer/client` test suite          | Launch `examples/backend` server, open `http://localhost:8080`, click Play.                                                                                                                                                            |
| Electron Renderer                          | Mocked lifecycle, events, worklet, decoder tests | 1. `npm start` in an Electron app with `contextIsolation: true`.<br>2. Confirm audio plays through speakers.<br>3. Verify DevTools shows 0 CSP / WASM errors.<br>4. Close window and confirm no lingering WebSockets or audio threads. |
| Tauri WebView (Windows WebView2)           | Mocked lifecycle, events, worklet, decoder tests | 1. `cargo tauri dev`<br>2. Click connect; confirm audio unpauses via `unlockAudio()`.<br>3. Verify DevTools console confirms `audio:config` and Opus frames received.                                                                  |
| Tauri WebView (macOS / Linux WebKit)       | Mocked lifecycle, events, worklet, decoder tests | Verify 48 kHz AudioContext compatibility with OS default audio server (PulseAudio/PipeWire/CoreAudio).                                                                                                                                 |
