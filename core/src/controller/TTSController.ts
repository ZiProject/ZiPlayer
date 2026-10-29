import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { Readable } from "stream";
import type { StreamInfo, Track } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { Bus } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import { playerDataMap } from "../structures/PlayerDataRegistry";
import {
	CONTROLLER_RPC,
	PLAYER_QUERY,
	type TtsIsTTSRequest,
	type TtsPlayRequest,
	type TtsSkipRequest,
	type TtsSkipResponse,
	type TtsStopRequest,
} from "../structures/BusContract";
import type { TTSControllerOptions } from "../types";

interface TTSQueueItem {
	id: string;
	track: Track;
	signal?: AbortSignal;
	resolve: () => void;
	reject: (error: Error) => void;
	abortController: AbortController;
	state: "pending" | "preparing" | "playing" | "completed" | "aborted";
}

interface TTSState {
	playerId: string;
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
	onError: (error: Error) => void;

	// Per-player sequential FIFO queue & worker
	queue: TTSQueueItem[];
	currentItem: TTSQueueItem | null;
	workerPromise: Promise<void> | null;

	// Underlying playback restoration tracking
	wasMusicPlaying: boolean;
	interruptedSessionId: string | null;
}

/** Shared TTS controller with audio, queue, and playback state isolated per playerId. */
export class TTSController {
	public get states(): Map<string, TTSState> {
		return playerDataMap(this.bus, "controller.tts.states");
	}

	constructor(private readonly bus: Bus) {
		bus.registerQuery(PLAYER_QUERY.ttsHasPlayer, (playerId) => Boolean(this.states.get(playerId)?.ttsPlayer));
		bus.registerQuery(PLAYER_QUERY.ttsInterrupt, (playerId) => this.states.get(playerId)?.interrupt ?? true);
		bus.registerQuery(PLAYER_QUERY.ttsIsActive, (playerId) => {
			const state = this.states.get(playerId);
			return Boolean(state && !state.disposed && (state.currentItem !== null || state.queue.length > 0));
		});

		bus.registerRpc<TtsIsTTSRequest, boolean>(CONTROLLER_RPC.ttsIsTTS, ({ track }) => this.isTTS(track));

		bus.registerRpc<TtsPlayRequest, void>(CONTROLLER_RPC.ttsPlay, ({ track }, ctx) => {
			const state = this.states.get(ctx.playerId);
			if (!state) return Promise.reject(new Error("TTSController is disposed"));
			return this.enqueue(ctx.playerId, state, track, ctx.signal);
		});

		bus.registerRpc<TtsSkipRequest, TtsSkipResponse>(CONTROLLER_RPC.ttsSkip, (_req, ctx) => {
			const skipped = this.skip(ctx.playerId);
			return { skipped };
		});

		bus.registerRpc<TtsStopRequest, void>(CONTROLLER_RPC.ttsStop, (_req, ctx) => {
			this.stop(ctx.playerId);
		});
	}

	attach(playerId: string, options: Omit<TTSControllerOptions, "bus"> & { bus?: never }): void {
		this.detach(playerId);
		const state: TTSState = {
			playerId,
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
			ttsPlayer: new AudioPlayer(),
			onError: (_error: Error) => {},
			queue: [],
			currentItem: null,
			workerPromise: null,
			wasMusicPlaying: false,
			interruptedSessionId: null,
		};

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

	public isTTS(track: Track): boolean {
		return (
			track.source?.toLowerCase() === "tts" ||
			track.id?.toLowerCase().startsWith("tts-") ||
			track.url?.toLowerCase().startsWith("tts://") ||
			Boolean(track.metadata?.tts)
		);
	}

	/**
	 * Skips the currently active TTS utterance, advancing to the next queued utterance
	 * or restoring underlying music if no further utterances are queued.
	 * Returns true if a TTS operation was active and skipped, false otherwise.
	 */
	public skip(playerId: string): boolean {
		const state = this.states.get(playerId);
		if (!state || state.disposed) return false;

		// 1. Current item is active (preparing or playing) and not yet aborted
		if (state.currentItem && !state.currentItem.abortController.signal.aborted) {
			state.debug(`[TTSController] skipping active utterance: ${state.currentItem.track.title ?? state.currentItem.id}`);
			state.currentItem.abortController.abort();
			state.ttsPlayer.stop(true);
			const stream = state.activeResource?.playStream;
			if (stream && typeof (stream as any).destroy === "function" && !(stream as any).destroyed) {
				(stream as any).destroy();
			}
			return true;
		}

		// 2. Current item is already aborted (unwinding) or null, but pending items exist in the queue
		while (state.queue.length > 0) {
			const nextItem = state.queue.shift()!;
			if (!nextItem.abortController.signal.aborted) {
				state.debug(`[TTSController] skipping queued utterance: ${nextItem.track.title ?? nextItem.id}`);
				nextItem.abortController.abort();
				nextItem.reject(this.abortError("TTS playback was skipped"));
				return true;
			}
		}

		// 3. If current item exists (even if aborted and unwinding), TTS is still handling the skip
		if (state.currentItem) {
			return true;
		}

		return false;
	}

	/**
	 * Stops all TTS playback for the player and clears the pending queue.
	 */
	public stop(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state || state.disposed) return;
		state.debug("[TTSController] stopping all TTS operations and clearing queue");
		this.clearQueue(state, "TTS playback was stopped");
		this.restorePlaybackIfNeeded(playerId, state);
	}

	/**
	 * Accepts and queues a TTS track in the player's sequential FIFO queue.
	 * Returns a Promise that settles when THIS utterance completes, fails, or is skipped.
	 */
	private enqueue(playerId: string, state: TTSState, track: Track, signal?: AbortSignal): Promise<void> {
		if (state.disposed || state.lifecycleAbort.signal.aborted) {
			return Promise.reject(this.abortError("TTSController is disposed"));
		}
		if (signal?.aborted) {
			return Promise.reject(this.abortError("TTS request was aborted before execution"));
		}
		if (!this.isTTS(track)) {
			return Promise.reject(new Error("Track is not a TTS track"));
		}

		const itemAbortController = new AbortController();

		let resolvePromise!: () => void;
		let rejectPromise!: (error: Error) => void;
		const promise = new Promise<void>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});

		const item: TTSQueueItem = {
			id: `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			track,
			signal,
			abortController: itemAbortController,
			state: "pending",
			resolve: () => {
				if (item.state !== "completed" && item.state !== "aborted") {
					item.state = "completed";
					cleanupListeners();
					resolvePromise();
				}
			},
			reject: (err: Error) => {
				if (item.state !== "completed" && item.state !== "aborted") {
					item.state = "aborted";
					cleanupListeners();
					rejectPromise(err);
				}
			},
		};

		const onCallerAbort = () => {
			itemAbortController.abort();
			if (item.state === "pending") {
				const idx = state.queue.indexOf(item);
				if (idx !== -1) state.queue.splice(idx, 1);
				item.reject(this.abortError("TTS request was aborted while waiting in queue"));
			}
		};

		const onLifecycleAbort = () => {
			itemAbortController.abort();
			if (item.state === "pending") {
				const idx = state.queue.indexOf(item);
				if (idx !== -1) state.queue.splice(idx, 1);
				item.reject(this.abortError("TTSController is disposed"));
			}
		};

		const cleanupListeners = () => {
			if (signal) signal.removeEventListener("abort", onCallerAbort);
			state.lifecycleAbort.signal.removeEventListener("abort", onLifecycleAbort);
		};

		if (signal) signal.addEventListener("abort", onCallerAbort, { once: true });
		state.lifecycleAbort.signal.addEventListener("abort", onLifecycleAbort, { once: true });

		state.queue.push(item);
		state.debug(`[TTSController] enqueued TTS utterance: ${track.title ?? item.id} (queue size: ${state.queue.length})`);

		this.ensureWorker(playerId, state);
		return promise;
	}

	private ensureWorker(playerId: string, state: TTSState): void {
		if (state.workerPromise) return;
		state.workerPromise = this.runWorker(playerId, state).finally(() => {
			state.workerPromise = null;
			this.restorePlaybackIfNeeded(playerId, state);
		});
	}

	private async runWorker(playerId: string, state: TTSState): Promise<void> {
		while (!state.disposed && !state.lifecycleAbort.signal.aborted && state.queue.length > 0) {
			const item = state.queue.shift()!;
			if (item.state === "aborted" || item.abortController.signal.aborted) {
				continue;
			}

			state.currentItem = item;
			try {
				await this.playOne(playerId, state, item);
				item.resolve();
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				item.reject(err);
			} finally {
				state.currentItem = null;
			}
		}
	}

	private async playOne(playerId: string, state: TTSState, item: TTSQueueItem): Promise<void> {
		if (state.disposed || state.lifecycleAbort.signal.aborted || item.abortController.signal.aborted) {
			throw this.abortError();
		}

		const connection = this.getConnection(playerId);
		if (!connection) {
			throw new Error("Cannot play TTS without a voice connection");
		}

		item.state = "preparing";

		// Record initial underlying music playback state on the first utterance in this burst
		const currentSession = this.getCurrentMusicSession(playerId);
		if (state.interruptedSessionId === null) {
			state.wasMusicPlaying = state.audioPlayer?.state.status === AudioPlayerStatus.Playing;
			state.interruptedSessionId = currentSession?.sessionId ?? null;
		}

		let started = false;
		let stream: Readable | null = null;
		try {
			const streamInfo = await this.resolve(state, item.track, item.abortController.signal);
			if (state.disposed || state.lifecycleAbort.signal.aborted || item.abortController.signal.aborted) {
				throw this.abortError("TTS playback was skipped");
			}

			stream = streamInfo.stream as Readable;
			const resource = createAudioResource(stream as any, { metadata: item.track, inlineVolume: true });
			state.activeResource = resource;
			resource.volume?.setVolume(state.volume / 100);

			if (state.wasMusicPlaying && state.audioPlayer?.state.status === AudioPlayerStatus.Playing) {
				state.audioPlayer?.pause(true);
			}
			connection.subscribe(state.ttsPlayer);

			item.state = "playing";
			started = true;
			void this.bus
				.requestRpc(playerId, CONTROLLER_RPC.playerEmitTtsStart, { track: item.track })
				.catch((error: unknown) => state.debug("[TTSController] failed to publish ttsStart:", error));

			state.ttsPlayer.play(resource);

			await this.waitForPlayingOrIdle(state, item.abortController.signal);
			if (!state.disposed && !item.abortController.signal.aborted && state.ttsPlayer.state.status === AudioPlayerStatus.Playing) {
				await this.waitForIdle(state, item.track, item.abortController.signal);
			}

			if (item.abortController.signal.aborted) {
				throw this.abortError("TTS playback was skipped");
			}
		} finally {
			state.activeResource = null;
			state.ttsPlayer.stop(true);
			if (stream && typeof (stream as any).destroy === "function" && !(stream as any).destroyed) {
				(stream as any).destroy();
			}
			if (started && !state.disposed) {
				void this.bus
					.requestRpc(playerId, CONTROLLER_RPC.playerEmitTtsEnd, undefined)
					.catch((error: unknown) => state.debug("[TTSController] failed to publish ttsEnd:", error));
			}
		}
	}

	private restorePlaybackIfNeeded(playerId: string, state: TTSState): void {
		if (state.disposed) return;
		if (state.queue.length > 0 || state.currentItem !== null) return;

		const connection = this.getConnection(playerId);
		const wasPlaying = state.wasMusicPlaying;
		const recordedSessionId = state.interruptedSessionId;

		state.wasMusicPlaying = false;
		state.interruptedSessionId = null;

		if (!state.audioPlayer || !connection) return;

		connection.subscribe(state.audioPlayer);

		if (wasPlaying && state.audioPlayer.state.status === AudioPlayerStatus.Paused) {
			const currentSession = this.getCurrentMusicSession(playerId);
			// Only resume if the session is still active and was NOT replaced by a newer track
			if (currentSession && currentSession.isActive()) {
				if (!recordedSessionId || currentSession.sessionId === recordedSessionId) {
					state.audioPlayer.unpause();
				}
			}
		}
	}

	private getConnection(playerId: string): VoiceConnection | null {
		return this.bus.querySync(playerId, PLAYER_QUERY.voiceConnection) ?? null;
	}

	private getCurrentMusicSession(playerId: string): PlaybackSession | null {
		return (this.bus.querySync(playerId, PLAYER_QUERY.playbackSessionInternal) as PlaybackSession | null) ?? null;
	}

	private async resolve(state: TTSState, track: Track, itemSignal?: AbortSignal): Promise<StreamInfo> {
		if (!this.isTTS(track)) throw new Error("Track is not a TTS track");
		if (itemSignal?.aborted || state.lifecycleAbort.signal.aborted) throw this.abortError();

		try {
			const extensionStream = state.extensionManager ? await state.extensionManager.provideStream(track) : null;
			if (extensionStream?.stream || extensionStream?.remote) return extensionStream;

			if (itemSignal?.aborted || state.lifecycleAbort.signal.aborted) throw this.abortError();

			const stream = await state.pluginManager.getStream(track, {
				context: { playerId: state.playerId, signal: itemSignal },
			});
			if (!stream) throw new Error(`No TTS stream available for track: ${track.title}`);
			return stream;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			state.debug("[TTSController] resolve failed:", err);
			throw err;
		}
	}

	private waitForPlayingOrIdle(state: TTSState, itemSignal: AbortSignal): Promise<void> {
		if (state.disposed || state.lifecycleAbort.signal.aborted || itemSignal.aborted) {
			return Promise.reject(this.abortError());
		}
		const status = state.ttsPlayer.state.status;
		if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Idle) {
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			const cleanup = () => {
				state.ttsPlayer.removeListener("stateChange", onState);
				state.lifecycleAbort.signal.removeEventListener("abort", onAbort);
				itemSignal.removeEventListener("abort", onAbort);
			};
			const onState = (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
				if (newState.status === AudioPlayerStatus.Playing || newState.status === AudioPlayerStatus.Idle) {
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
			itemSignal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private waitForIdle(state: TTSState, track: Track, itemSignal: AbortSignal): Promise<void> {
		if (state.disposed || state.lifecycleAbort.signal.aborted || itemSignal.aborted) {
			return Promise.reject(this.abortError());
		}
		if (state.ttsPlayer.state.status === AudioPlayerStatus.Idle) {
			return Promise.resolve();
		}

		const declaredSeconds = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : undefined;
		const declaredMs = declaredSeconds !== undefined ? declaredSeconds * 1_000 : undefined;
		const idleTimeout = declaredMs ? Math.min(state.maxTimeTts, Math.max(1_000, declaredMs + 1_500)) : state.maxTimeTts;

		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				state.ttsPlayer.removeListener("stateChange", onState);
				state.lifecycleAbort.signal.removeEventListener("abort", onAbort);
				itemSignal.removeEventListener("abort", onAbort);
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
			itemSignal.addEventListener("abort", onAbort, { once: true });

			timer = setTimeout(() => {
				cleanup();
				state.debug(`[TTSController] idle timeout after ${idleTimeout}ms for: ${track.title}`);
				const stream = state.activeResource?.playStream;
				if (stream && typeof (stream as any).destroy === "function" && !(stream as any).destroyed) {
					(stream as any).destroy();
				}
				state.ttsPlayer.stop(true);
				resolve();
			}, idleTimeout);
			if (typeof timer.unref === "function") {
				timer.unref();
			}
		});
	}

	private abortError(message = "TTS playback was aborted"): Error {
		const error = new Error(message);
		error.name = "AbortError";
		return error;
	}

	private clearQueue(state: TTSState, reason = "TTS playback was aborted"): void {
		if (state.currentItem) {
			state.currentItem.abortController.abort();
		}
		while (state.queue.length > 0) {
			const item = state.queue.shift()!;
			item.abortController.abort();
			item.reject(this.abortError(reason));
		}
		state.ttsPlayer.stop(true);
		const stream = state.activeResource?.playStream;
		if (stream && typeof (stream as any).destroy === "function" && !(stream as any).destroyed) {
			(stream as any).destroy();
		}
	}

	private dispose(state: TTSState): void {
		if (state.disposed) return;
		state.disposed = true;
		state.lifecycleAbort.abort();
		this.clearQueue(state, "TTSController is disposed");
		state.ttsPlayer.removeListener("error", state.onError);
		state.ttsPlayer.stop(true);
		state.activeResource = null;
		state.wasMusicPlaying = false;
		state.interruptedSessionId = null;
	}
}
