// Tauri frontend component integration
import { WebAudioClient, getFrequencyBands } from "@ziplayer/client";

export class DesktopAudioPlayer {
	constructor({ gatewayUrl = "ws://127.0.0.1:8080", sessionId = "tauri-player" } = {}) {
		this.gatewayUrl = gatewayUrl;
		this.sessionId = sessionId;
		this.client = new WebAudioClient({
			analyserOptions: { fftSize: 1024 },
		});

		this.client.addEventListener("statechange", ({ detail }) => {
			console.log(`[Tauri] Playback state: ${detail.state}`);
		});

		this.client.addEventListener("error", ({ detail }) => {
			console.error("[Tauri] Playback error:", detail.error);
		});
	}

	async start() {
		// Ensure AudioContext is resumed within user event loop
		await this.client.unlockAudio();
		await this.client.connect({
			gatewayUrl: this.gatewayUrl,
			sessionId: this.sessionId,
		});
	}

	async stop() {
		await this.client.disconnect();
	}
}
