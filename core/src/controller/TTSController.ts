import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { Readable } from "stream";
import type { StreamInfo, Track } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";

export interface TTSControllerOptions {
	pluginManager: PluginManager;
	extensionManager?: ExtensionManager;
	connection?: VoiceConnection | null;
	audioPlayer?: AudioPlayer;
	debug?: (...args: any[]) => void;
	onStart?: (track: Track) => void;
	onEnd?: () => void;
	/** Maximum amount of time a TTS playback may remain active. */
	maxTimeTts?: number;
	/** TTS output volume, expressed as a percentage (0-100). */
	volume?: number;
}

/** Owns TTS stream resolution and the independent interrupt playback lifecycle. */
export class TTSController {
	public readonly ttsPlayer: AudioPlayer;
	private readonly pluginManager: PluginManager;
	private readonly extensionManager?: ExtensionManager;
	private readonly debug: (...args: any[]) => void;
	private connection: VoiceConnection | null;
	private readonly audioPlayer?: AudioPlayer;
	private readonly onStart?: (track: Track) => void;
	private readonly onEnd?: () => void;
	private readonly maxTimeTts: number;
	private readonly volume: number;
	private activeResource: AudioResource | null = null;
	private running: Promise<void> | null = null;

	constructor(options: TTSControllerOptions) {
		this.pluginManager = options.pluginManager;
		this.extensionManager = options.extensionManager;
		this.connection = options.connection ?? null;
		this.audioPlayer = options.audioPlayer;
		this.debug = options.debug ?? (() => undefined);
		this.onStart = options.onStart;
		this.onEnd = options.onEnd;
		this.maxTimeTts =
			Number.isFinite(options.maxTimeTts) && (options.maxTimeTts as number) > 0 ? (options.maxTimeTts as number) : 60_000;
		this.volume = Number.isFinite(options.volume) ? Math.max(0, Math.min(100, options.volume as number)) : 100;
		this.ttsPlayer = new AudioPlayer();
	}

	public setConnection(connection: VoiceConnection | null): void {
		this.connection = connection;
	}

	isTTS(track: Track): boolean {
		return track.source?.toLowerCase() === "tts" || track.id?.toLowerCase().startsWith("tts-") || !!track.metadata?.tts;
	}

	async resolve(track: Track): Promise<StreamInfo> {
		if (!this.isTTS(track)) throw new Error("Track is not a TTS track");
		try {
			const extensionStream = this.extensionManager ? await this.extensionManager.provideStream(track) : null;
			if (extensionStream?.stream || extensionStream?.remote) return extensionStream;
			const stream = await this.pluginManager.getStream(track);
			if (!stream) throw new Error(`No TTS stream available for track: ${track.title}`);
			return stream;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.debug("[TTSController] resolve failed:", err);
			throw err;
		}
	}

	/**
	 * Legacy-compatible TTS interrupt playback.
	 * TTS uses a dedicated AudioPlayer and is not part of normal track lifecycle events.
	 */
	public play(track: Track): Promise<void> {
		if (!this.isTTS(track)) return Promise.reject(new Error("Track is not a TTS track"));
		if (this.running) return this.running;
		this.running = this.playInternal(track).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async playInternal(track: Track): Promise<void> {
		const connection = this.connection;
		if (!connection) throw new Error("Cannot play TTS without a voice connection");

		const wasPlaying = this.audioPlayer?.state.status === AudioPlayerStatus.Playing;
		let started = false;

		try {
			const streamInfo = await this.resolve(track);
			const stream = streamInfo.stream as Readable;
			const resource = createAudioResource(stream as any, { metadata: track, inlineVolume: true });
			this.activeResource = resource;
			resource.volume?.setVolume(this.volume / 100);

			if (wasPlaying) this.audioPlayer?.pause(true);
			connection.subscribe(this.ttsPlayer);

			// Preserve Player.old.ts ordering: subscribe -> ttsStart -> play.
			this.onStart?.(track);
			started = true;
			this.ttsPlayer.play(resource);

			await this.waitForPlayingOrIdle();
			if (this.ttsPlayer.state.status === AudioPlayerStatus.Playing) {
				await this.waitForIdle(track);
			}
		} finally {
			this.activeResource = null;
			this.ttsPlayer.stop(true);

			if (this.audioPlayer) {
				connection.subscribe(this.audioPlayer);
				if (wasPlaying && this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
					this.audioPlayer.unpause();
				}
			}

			if (started) this.onEnd?.();
		}
	}

	private waitForPlayingOrIdle(): Promise<void> {
		const status = this.ttsPlayer.state.status;
		if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Idle) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const onState = (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
				if (newState.status === AudioPlayerStatus.Playing || newState.status === AudioPlayerStatus.Idle) {
					this.ttsPlayer.removeListener("stateChange", onState);
					resolve();
				}
			};
			this.ttsPlayer.on("stateChange", onState);
		});
	}

	private waitForIdle(track: Track): Promise<void> {
		if (this.ttsPlayer.state.status === AudioPlayerStatus.Idle) return Promise.resolve();

		const declaredMs = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : undefined;
		const idleTimeout = declaredMs ? Math.min(this.maxTimeTts, Math.max(1_000, declaredMs + 1_500)) : this.maxTimeTts;

		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				this.ttsPlayer.removeListener("stateChange", onState);
				if (timer) clearTimeout(timer);
			};
			const onState = (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
				if (newState.status === AudioPlayerStatus.Idle) {
					cleanup();
					resolve();
				}
			};
			this.ttsPlayer.on("stateChange", onState);
			timer = setTimeout(() => {
				cleanup();
				this.debug(`[TTSController] idle timeout after ${idleTimeout}ms for: ${track.title}`);
				const stream = this.activeResource?.playStream;
				if (stream && typeof stream.destroy === "function" && !stream.destroyed) stream.destroy();
				this.ttsPlayer.stop(true);
				resolve();
			}, idleTimeout);
		});
	}

	public get player(): AudioPlayer {
		return this.ttsPlayer;
	}

	dispose(): void {
		this.ttsPlayer.stop(true);
		this.activeResource = null;
		this.connection = null;
		this.running = null;
	}
}
