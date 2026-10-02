import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { Readable } from "stream";
import type { StreamInfo, Track } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { Bus } from "../structures/Bus";
import { CONTROLLER_RPC, PLAYER_QUERY, type TtsIsTTSRequest, type TtsPlayRequest } from "../structures/BusContract";
import type { TTSControllerOptions } from "../types";

interface TTSState {
	ttsPlayer: AudioPlayer;
	pluginManager: PluginManager;
	extensionManager?: ExtensionManager;
	debug: (...args: any[]) => void;
	audioPlayer?: AudioPlayer;
	maxTimeTts: number;
	volume: number;
	interrupt: boolean;
	lifecycleAbort: AbortController;
	disposed: boolean;
	activeResource: AudioResource | null;
	running: Promise<void> | null;
	onError: (error: Error) => void;
}

/** Shared TTS controller with audio and playback state isolated per playerId. */
export class TTSController {
	public readonly states = new Map<string, TTSState>();

	constructor(private readonly bus: Bus) {
		bus.registerQuery(PLAYER_QUERY.ttsHasPlayer, (playerId) => Boolean(this.states.get(playerId)?.ttsPlayer));
		bus.registerQuery(PLAYER_QUERY.ttsInterrupt, (playerId) => this.states.get(playerId)?.interrupt ?? true);
		bus.registerRpc<TtsIsTTSRequest, boolean>(CONTROLLER_RPC.ttsIsTTS, ({ track }, ctx) => this.isTTS(track));
		bus.registerRpc<TtsPlayRequest, void>(CONTROLLER_RPC.ttsPlay, ({ track }, ctx) => {
			const state = this.states.get(ctx.playerId);
			if (!state) return Promise.reject(new Error("TTSController is disposed"));
			return this.play(ctx.playerId, state, track);
		});
	}

	attach(playerId: string, options: Omit<TTSControllerOptions, "bus"> & { bus?: never }): void {
		this.detach(playerId);
		const state = {
			pluginManager: options.pluginManager,
			extensionManager: options.extensionManager,
			audioPlayer: options.audioPlayer,
			debug: options.debug ?? (() => undefined),
			maxTimeTts:
				Number.isFinite(options.maxTimeTts) && (options.maxTimeTts as number) > 0 ? (options.maxTimeTts as number) : 60_000,
			volume: Number.isFinite(options.volume) ? Math.max(0, Math.min(100, options.volume as number)) : 100,
			interrupt: options.interrupt ?? true,
			lifecycleAbort: new AbortController(),
			disposed: false,
			activeResource: null,
			running: null,
			ttsPlayer: new AudioPlayer(),
			onError: (_error: Error) => {},
		} satisfies TTSState;
		state.onError = (error) => {
			state.debug("[TTSController] audio player error:", error instanceof Error ? error : new Error(String(error)));
			state.ttsPlayer.stop(true);
		};
		state.ttsPlayer.on("error", state.onError);
		this.states.set(playerId, state);
	}

	detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		this.dispose(state);
	}

	public player(playerId: string): AudioPlayer | undefined {
		return this.states.get(playerId)?.ttsPlayer;
	}

	private isTTS(track: Track): boolean {
		return track.source?.toLowerCase() === "tts" || track.id?.toLowerCase().startsWith("tts-") || !!track.metadata?.tts;
	}

	private async resolve(state: TTSState, track: Track): Promise<StreamInfo> {
		if (!this.isTTS(track)) throw new Error("Track is not a TTS track");
		try {
			const extensionStream = state.extensionManager ? await state.extensionManager.provideStream(track) : null;
			if (extensionStream?.stream || extensionStream?.remote) return extensionStream;
			const stream = await state.pluginManager.getStream(track);
			if (!stream) throw new Error(`No TTS stream available for track: ${track.title}`);
			return stream;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			state.debug("[TTSController] resolve failed:", err);
			throw err;
		}
	}

	private play(playerId: string, state: TTSState, track: Track): Promise<void> {
		if (state.disposed) return Promise.reject(new Error("TTSController is disposed"));
		if (!this.isTTS(track)) return Promise.reject(new Error("Track is not a TTS track"));
		if (state.running) return state.running;
		const running = this.playInternal(playerId, state, track).finally(() => {
			state.running = null;
		});
		state.running = running;
		return running;
	}

	private getConnection(playerId: string): VoiceConnection | null {
		return (this.bus.querySync(playerId, PLAYER_QUERY.connection) as VoiceConnection | null) ?? null;
	}

	private async playInternal(playerId: string, state: TTSState, track: Track): Promise<void> {
		const connection = this.getConnection(playerId);
		if (state.disposed || state.lifecycleAbort.signal.aborted) throw this.abortError();
		if (!connection) throw new Error("Cannot play TTS without a voice connection");
		const wasPlaying = state.audioPlayer?.state.status === AudioPlayerStatus.Playing;
		let started = false;
		try {
			const streamInfo = await this.resolve(state, track);
			if (state.disposed || state.lifecycleAbort.signal.aborted) throw this.abortError();
			const stream = streamInfo.stream as Readable;
			const resource = createAudioResource(stream as any, { metadata: track, inlineVolume: true });
			state.activeResource = resource;
			resource.volume?.setVolume(state.volume / 100);
			if (wasPlaying) state.audioPlayer?.pause(true);
			connection.subscribe(state.ttsPlayer);
			void this.bus
				.requestRpc(playerId, CONTROLLER_RPC.playerEmitTtsStart, { track })
				.catch((error: unknown) => state.debug("[TTSController] failed to publish ttsStart:", error));
			started = true;
			state.ttsPlayer.play(resource);
			await this.waitForPlayingOrIdle(state);
			if (!state.disposed && state.ttsPlayer.state.status === AudioPlayerStatus.Playing) await this.waitForIdle(state, track);
		} finally {
			state.activeResource = null;
			state.ttsPlayer.stop(true);
			const currentConnection = this.getConnection(playerId);
			if (!state.disposed && state.audioPlayer && currentConnection) {
				currentConnection.subscribe(state.audioPlayer);
				if (wasPlaying && state.audioPlayer.state.status === AudioPlayerStatus.Paused) state.audioPlayer.unpause();
			}
			if (started && !state.disposed)
				void this.bus
					.requestRpc(playerId, CONTROLLER_RPC.playerEmitTtsEnd, undefined)
					.catch((error: unknown) => state.debug("[TTSController] failed to publish ttsEnd:", error));
		}
	}

	private waitForPlayingOrIdle(state: TTSState): Promise<void> {
		if (state.disposed || state.lifecycleAbort.signal.aborted) return Promise.reject(this.abortError());
		const status = state.ttsPlayer.state.status;
		if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Idle) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const onState = (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
				if (newState.status === AudioPlayerStatus.Playing || newState.status === AudioPlayerStatus.Idle) {
					state.ttsPlayer.removeListener("stateChange", onState);
					state.lifecycleAbort.signal.removeEventListener("abort", onAbort);
					resolve();
				}
			};
			const onAbort = () => {
				state.ttsPlayer.removeListener("stateChange", onState);
				reject(this.abortError());
			};
			state.ttsPlayer.on("stateChange", onState);
			state.lifecycleAbort.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private waitForIdle(state: TTSState, track: Track): Promise<void> {
		if (state.disposed || state.lifecycleAbort.signal.aborted) return Promise.reject(this.abortError());
		if (state.ttsPlayer.state.status === AudioPlayerStatus.Idle) return Promise.resolve();
		const declaredSeconds = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : undefined;
		const declaredMs = declaredSeconds !== undefined ? declaredSeconds * 1_000 : undefined;
		const idleTimeout = declaredMs ? Math.min(state.maxTimeTts, Math.max(1_000, declaredMs + 1_500)) : state.maxTimeTts;
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				state.ttsPlayer.removeListener("stateChange", onState);
				state.lifecycleAbort.signal.removeEventListener("abort", onAbort);
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
			state.ttsPlayer.on("stateChange", onState);
			state.lifecycleAbort.signal.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => {
				cleanup();
				state.debug(`[TTSController] idle timeout after ${idleTimeout}ms for: ${track.title}`);
				const stream = state.activeResource?.playStream;
				if (stream && typeof stream.destroy === "function" && !stream.destroyed) stream.destroy();
				state.ttsPlayer.stop(true);
				resolve();
			}, idleTimeout);
		});
	}

	private abortError(): Error {
		const error = new Error("TTS playback was aborted");
		error.name = "AbortError";
		return error;
	}

	private dispose(state: TTSState): void {
		if (state.disposed) return;
		state.disposed = true;
		state.lifecycleAbort.abort();
		state.ttsPlayer.removeListener("error", state.onError);
		state.ttsPlayer.stop(true);
		state.activeResource = null;
	}
}
