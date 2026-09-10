import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { Readable } from "stream";
import type { StreamInfo, Track } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { PlayerBus } from "../structures/PlayerBus";
import { CONTROLLER_RPC, type TtsIsTTSRequest, type TtsPlayRequest } from "./ControllerBusContract";
import type { TTSControllerOptions } from "../types";

/** Owns TTS stream resolution and the independent interrupt playback lifecycle. */
export class TTSController {
	public readonly ttsPlayer: AudioPlayer;
	private readonly pluginManager: PluginManager;
	private readonly extensionManager?: ExtensionManager;
	private readonly debug: (...args: any[]) => void;
	private connection: VoiceConnection | null;
	private readonly audioPlayer?: AudioPlayer;
	private readonly bus?: PlayerBus;
	private readonly maxTimeTts: number;
	private readonly volume: number;
	private readonly interrupt: boolean;
	private readonly lifecycleAbort = new AbortController();
	private disposed = false;
	private activeResource: AudioResource | null = null;
	private running: Promise<void> | null = null;
	private readonly onError: (error: Error) => void;
	private readonly detachBusHandlers: Array<() => void> = [];

	constructor(options: TTSControllerOptions) {
		this.pluginManager = options.pluginManager;
		this.extensionManager = options.extensionManager;
		this.connection = options.connection ?? null;
		this.audioPlayer = options.audioPlayer;
		this.bus = options.bus;
		this.debug = options.debug ?? (() => undefined);
		this.maxTimeTts =
			Number.isFinite(options.maxTimeTts) && (options.maxTimeTts as number) > 0 ? (options.maxTimeTts as number) : 60_000;
		this.volume = Number.isFinite(options.volume) ? Math.max(0, Math.min(100, options.volume as number)) : 100;
		this.interrupt = options.interrupt ?? true;
		this.ttsPlayer = new AudioPlayer();
		this.onError = (error) => {
			this.debug("[TTSController] audio player error:", error instanceof Error ? error : new Error(String(error)));
			this.ttsPlayer.stop(true);
		};
		this.ttsPlayer.on("error", this.onError);
		if (options.bus) {
			this.detachBusHandlers.push(
				options.bus.registerQuery("tts.hasPlayer", () => Boolean(this.ttsPlayer)),
				options.bus.registerQuery("ttsInterrupt", () => this.interrupt),
				options.bus.registerRpc<TtsIsTTSRequest, boolean>(CONTROLLER_RPC.ttsIsTTS, ({ track }) => this.isTTS(track)),
				options.bus.registerRpc<TtsPlayRequest, void>(CONTROLLER_RPC.ttsPlay, ({ track }) => this.play(track)),
				options.bus.onOutput("[Connection]->[Player]:connected", (event) => this.setConnection(event.connection)),
				options.bus.onOutput("[Connection]->[Player]:disconnected", () => this.setConnection(null)),
			);
		}
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

	/** Legacy-compatible TTS interrupt playback. */
	public play(track: Track): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("TTSController is disposed"));
		if (!this.isTTS(track)) return Promise.reject(new Error("Track is not a TTS track"));
		if (this.running) return this.running;
		this.running = this.playInternal(track).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async playInternal(track: Track): Promise<void> {
		const connection = this.connection;
		if (this.disposed || this.lifecycleAbort.signal.aborted) throw this.abortError();
		if (!connection) throw new Error("Cannot play TTS without a voice connection");
		const wasPlaying = this.audioPlayer?.state.status === AudioPlayerStatus.Playing;
		let started = false;
		try {
			const streamInfo = await this.resolve(track);
			if (this.disposed || this.lifecycleAbort.signal.aborted) throw this.abortError();
			const stream = streamInfo.stream as Readable;
			const resource = createAudioResource(stream as any, { metadata: track, inlineVolume: true });
			this.activeResource = resource;
			resource.volume?.setVolume(this.volume / 100);
			if (wasPlaying) this.audioPlayer?.pause(true);
			connection.subscribe(this.ttsPlayer);
			void this.bus
				?.requestRpc("player.emitTtsStart", { track })
				.catch((error) => this.debug("[TTSController] failed to publish ttsStart:", error));
			started = true;
			this.ttsPlayer.play(resource);
			await this.waitForPlayingOrIdle();
			if (!this.disposed && this.ttsPlayer.state.status === AudioPlayerStatus.Playing) await this.waitForIdle(track);
		} finally {
			this.activeResource = null;
			this.ttsPlayer.stop(true);
			if (!this.disposed && this.audioPlayer && this.connection) {
				connection.subscribe(this.audioPlayer);
				if (wasPlaying && this.audioPlayer.state.status === AudioPlayerStatus.Paused) this.audioPlayer.unpause();
			}
			if (started && !this.disposed)
				void this.bus
					?.requestRpc("player.emitTtsEnd", undefined)
					.catch((error) => this.debug("[TTSController] failed to publish ttsEnd:", error));
		}
	}

	private waitForPlayingOrIdle(): Promise<void> {
		if (this.disposed || this.lifecycleAbort.signal.aborted) return Promise.reject(this.abortError());
		const status = this.ttsPlayer.state.status;
		if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Idle) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const onState = (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
				if (newState.status === AudioPlayerStatus.Playing || newState.status === AudioPlayerStatus.Idle) {
					this.ttsPlayer.removeListener("stateChange", onState);
					this.lifecycleAbort.signal.removeEventListener("abort", onAbort);
					resolve();
				}
			};
			const onAbort = () => {
				this.ttsPlayer.removeListener("stateChange", onState);
				reject(this.abortError());
			};
			this.ttsPlayer.on("stateChange", onState);
			this.lifecycleAbort.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private waitForIdle(track: Track): Promise<void> {
		if (this.disposed || this.lifecycleAbort.signal.aborted) return Promise.reject(this.abortError());
		if (this.ttsPlayer.state.status === AudioPlayerStatus.Idle) return Promise.resolve();
		const declaredSeconds = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : undefined;
		const declaredMs = declaredSeconds !== undefined ? declaredSeconds * 1_000 : undefined;
		const idleTimeout = declaredMs ? Math.min(this.maxTimeTts, Math.max(1_000, declaredMs + 1_500)) : this.maxTimeTts;
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				this.ttsPlayer.removeListener("stateChange", onState);
				this.lifecycleAbort.signal.removeEventListener("abort", onAbort);
				if (timer) clearTimeout(timer);
			};
			const onState = (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
				if (newState.status === AudioPlayerStatus.Idle) {
					cleanup();
					resolve();
				}
			};
			const onAbort = () => {
				cleanup();
				reject(this.abortError());
			};
			this.ttsPlayer.on("stateChange", onState);
			this.lifecycleAbort.signal.addEventListener("abort", onAbort, { once: true });
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

	private abortError(): Error {
		const error = new Error("TTS playback was aborted");
		error.name = "AbortError";
		return error;
	}

	public get player(): AudioPlayer {
		return this.ttsPlayer;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		for (const detach of this.detachBusHandlers.splice(0)) detach();
		this.ttsPlayer.removeListener("error", this.onError);
		this.ttsPlayer.stop(true);
		this.activeResource = null;
		this.connection = null;
	}
}
