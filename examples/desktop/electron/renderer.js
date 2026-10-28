// Electron Renderer script
// Uses @ziplayer/client directly inside the Chromium renderer without Node.js integration
import { WebAudioClient, getFrequencyBands, getBassEnergy } from "@ziplayer/client";

const client = new WebAudioClient({
	startupBufferMs: 100,
	maxBufferSeconds: 2,
	analyserOptions: {
		fftSize: 2048,
		smoothingTimeConstant: 0.65,
	},
});

const statusEl = document.getElementById("status");
const playBtn = document.getElementById("play-btn");

client.addEventListener("statechange", ({ detail }) => {
	if (statusEl) statusEl.textContent = `State: ${detail.state}`;
});

client.addEventListener("suspended", () => {
	if (statusEl) statusEl.textContent = "Audio suspended by Autoplay policy. Click Play to start.";
});

client.addEventListener("error", ({ detail }) => {
	console.error("Desktop audio error:", detail.error);
});

playBtn?.addEventListener("click", async () => {
	// 1. Unlock AudioContext on user click
	await client.unlockAudio();

	// 2. Connect to the WebSocket gateway
	await client.connect({
		gatewayUrl: "ws://127.0.0.1:8080",
		sessionId: "electron-demo-player",
	});
});

window.addEventListener("beforeunload", async () => {
	// 3. Cleanly close sockets and release AudioContext on window close
	await client.disconnect();
});
