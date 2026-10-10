import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, StreamType } from "@discordjs/voice";
import { Readable } from "stream";
import type {
	AudioFrameFormat,
	AudioOutputBackend,
	AudioOutputHandle,
	AudioOutputState,
	AudioOutputInput,
} from "../output/AudioOutputBackend";
import { AudioOutputUnsupportedOperationError } from "../output/AudioOutputBackend";
import { audioFrameFormatFromDiscordStreamType, DiscordVoiceOutputBackend } from "../output/DiscordVoiceOutputBackend";
import type { Bus } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track, PlaybackControllerOptions } from "../types";
import { PlaybackMode } from "../types";
import type { AntiStuckRetryHandlers } from "../types";
import { createAudioProcessingEngine, type AudioProcessingOptions } from "../audio/AudioProcessingEngine";
import {
	BUS_EVENT,
	CONTROLLER_RPC,
	PLAYER_QUERY,
	PLAYER_RPC,
	PLAYER_ACTION,
	type TransitionPlanResponse,
} from "../structures/BusContract";

/** Everything the controller keeps for ONE player. Lives only inside `PlaybackController.slots`. */
interface PlaybackSlot {
	readonly playerId: string;
	readonly audioPlayer: AudioPlayer | null;
	readonly outputBackend: AudioOutputBackend<AudioResource>;
	backendInitialization: Promise<void> | null;
	readonly stuckTimeoutMs: number;
	readonly recoveryHandlers: AntiStuckRetryHandlers;
	readonly lifecycleAbort: AbortController;
	readonly detachBusHandlers: Array<() => void>;
	readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;
	readonly onError: (error: Error) => void;
	activeResource: AudioResource | null;
	activeHandle: AudioOutputHandle<AudioResource> | null;
	outputState: AudioOutputState;
	readonly handles: Map<AudioResource, AudioOutputHandle<AudioResource>>;
	readonly handleDetachers: Map<AudioResource, () => void>;
	readonly volumeValues: Map<AudioResource, number>;
	readonly disposalPromises: WeakMap<AudioOutputHandle<AudioResource>, Promise<void>>;
	readonly stopPromises: Map<AudioOutputHandle<AudioResource>, Promise<boolean>>;
	readonly startAbortControllers: Map<AudioOutputHandle<AudioResource>, AbortController>;
	activeSession: PlaybackSession | null;
	transitionTimer: ReturnType<typeof setTimeout> | null;
	transitionStartResolve: (() => void) | null;
	fadeTimer: ReturnType<typeof setInterval> | null;
	stuckTimer: ReturnType<typeof setTimeout> | null;
	resourceRefreshInProgress: boolean;
	fadeGain: number | null;
	fadeResource: AudioResource | null;
	disposed: boolean;
}

const NO_TRANSITION: TransitionPlanResponse = { enabled: false, durationMs: 0, waitForBeat: false, beatAlignMaxWaitMs: 0 };

/**
 * Owns every player's discord.js `AudioPlayer` playback state behind the Bus.
 *
 * Shared, singleton controller — created once in `ensureSharedControllers()`. Each
 * player's `AudioPlayer`, active resource/session, fade/stuck timers and listeners live
 * in an internal `Map<playerId, PlaybackSlot>` (opened by `attach(playerId, ...)`,
 * released by `detach(playerId)`). All RPC handlers and queries below are registered
 * exactly once, in the constructor, and route by `ctx.playerId` / the query's `playerId`.
 */
export class PlaybackController {
	private readonly bus: Bus;
	private readonly slots = new Map<string, PlaybackSlot>();
	private readonly processingOptions = new Map<string, AudioProcessingOptions>();
	private readonly remoteStopPromises = new Map<string, Promise<boolean>>();

	public constructor(bus: Bus) {
		this.bus = bus;

		const at = (playerId: string) => this.slots.get(playerId);
		bus.registerRpc<{ resource: AudioResource; from: number; to: number; durationMs: number }, void>(
			PLAYER_RPC.transitionFade,
			({ resource, from, to, durationMs }, ctx) => this.fadeResourceVolume(ctx.playerId, resource, from, to, durationMs),
		);
		bus.registerRpc<{ resource: AudioResource; track: Track }, void>(PLAYER_RPC.transitionFadeIn, ({ resource, track }, ctx) =>
			this.applyCrossfadeIn(ctx.playerId, resource, track),
		);
		bus.registerRpc<void, void>(PLAYER_RPC.transitionFadeOutCurrent, (_req, ctx) => this.applyCrossfadeOutCurrent(ctx.playerId));
		bus.registerRpc<void, void>(PLAYER_RPC.transitionSkipAndStop, (_req, ctx) => this.crossfadeSkipAndStop(ctx.playerId));
		bus.registerRpc<
			{ resource: AudioResource; session?: PlaybackSession; from?: Track | null; to?: Track },
			void | Promise<void>
		>(CONTROLLER_RPC.playbackPlay, ({ resource, session, from, to }, ctx) =>
			this.play(ctx.playerId, resource, session, from, to, ctx.signal),
		);
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackPause, (_req, ctx) => this.pause(ctx.playerId, ctx.signal));
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackResume, (_req, ctx) => this.resume(ctx.playerId, ctx.signal));
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackStop, (_req, ctx) => this.stop(ctx.playerId, ctx.signal));
		bus.registerRpc<void, void>(CONTROLLER_RPC.playbackBeginResourceRefresh, (_req, ctx) =>
			this.beginResourceRefresh(ctx.playerId),
		);
		bus.registerRpc<void, void>(CONTROLLER_RPC.playbackEndResourceRefresh, (_req, ctx) => this.endResourceRefresh(ctx.playerId));
		bus.registerRpc<{ error: Error }, void>(CONTROLLER_RPC.playbackReportFilterError, ({ error }, ctx) =>
			this.reportFilterError(ctx.playerId, error),
		);
		bus.registerRpc<{ stream: Readable; track: Track; inputType?: StreamType }, AudioResource>(
			PLAYER_RPC.resourceCreate,
			({ stream, track, inputType }, ctx) => {
				if (!this.slots.has(ctx.playerId)) throw new Error("No PlaybackController registered for this player");
				return this.createResource(ctx.playerId, stream, track, inputType, ctx.signal);
			},
		);
		bus.registerQuery(PLAYER_QUERY.audioPlayer, (playerId) => at(playerId)?.audioPlayer as any);
		bus.registerQuery(PLAYER_QUERY.currentResource, (playerId) => this.currentResource(playerId));
		bus.registerQuery(PLAYER_QUERY.playbackSession, (playerId) => this.currentSessionSnapshot(playerId));
		bus.registerQuery(PLAYER_QUERY.playerState, (playerId) => this.status(playerId) ?? AudioPlayerStatus.Idle);
		bus.registerQuery(PLAYER_QUERY.isPlaying, (playerId) => this.status(playerId) === AudioPlayerStatus.Playing);
		bus.registerQuery(PLAYER_QUERY.isPaused, (playerId) => this.status(playerId) === AudioPlayerStatus.Paused);
		bus.registerQuery(PLAYER_QUERY.isIdle, (playerId) => this.status(playerId) === AudioPlayerStatus.Idle);
		bus.registerQuery(PLAYER_QUERY.isBuffering, (playerId) => this.status(playerId) === AudioPlayerStatus.Buffering);
		bus.registerQuery(PLAYER_QUERY.isLive, (playerId) => Boolean(this.currentSessionTrack(playerId)?.isLive));
		bus.registerQuery(PLAYER_QUERY.position, (playerId) => this.position(playerId));
	}

	// ---------------------------------------------------------------------
	// Per-player lifecycle
	// ---------------------------------------------------------------------

	/** Opens a slot for `playerId` around its `AudioPlayer`. Re-attaching replaces (and releases) the old slot. */
	public attach(playerId: string, options: PlaybackControllerOptions): void {
		if (this.slots.has(playerId)) this.detach(playerId);
		if (options.audioProcessing?.enabled) this.processingOptions.set(playerId, options.audioProcessing);
		else this.processingOptions.delete(playerId);
		if (!options.audioOutputBackendFactory && !options.audioPlayer) {
			throw new TypeError("An audioPlayer is required unless an audioOutputBackendFactory is provided");
		}
		const outputBackend =
			options.audioOutputBackendFactory ?
				options.audioOutputBackendFactory({ playerId })
			:	new DiscordVoiceOutputBackend(options.audioPlayer!);
		const slot: PlaybackSlot = {
			playerId,
			audioPlayer: options.audioPlayer ?? null,
			outputBackend,
			backendInitialization: null,
			stuckTimeoutMs: Math.max(0, options.stuckTimeoutMs ?? 10000),
			lifecycleAbort: new AbortController(),
			detachBusHandlers: [],
			activeResource: null,
			activeHandle: null,
			outputState: options.audioPlayer ? this.mapPlayerStatus(options.audioPlayer.state.status) : "ready",
			handles: new Map(),
			handleDetachers: new Map(),
			volumeValues: new Map(),
			disposalPromises: new WeakMap(),
			stopPromises: new Map(),
			startAbortControllers: new Map(),
			activeSession: null,
			transitionTimer: null,
			transitionStartResolve: null,
			fadeTimer: null,
			stuckTimer: null,
			resourceRefreshInProgress: false,
			fadeGain: null,
			fadeResource: null,
			disposed: false,
			recoveryHandlers: {
				retry: async ({ session }) => {
					if (!session.isActive()) return false;
					try {
						await this.bus.requestRpc(
							playerId,
							PLAYER_RPC.playbackRefreshResource,
							{ position: session.position },
							{ signal: session.signal, timeoutMs: 30000 },
						);
						return session.isActive();
					} catch {
						return false;
					}
				},
				skip: ({ session }) =>
					this.bus.action(playerId, { type: PLAYER_ACTION.skip }, { signal: session.signal, sessionId: session.sessionId }),
			},
			onStateChange: (a, b) => {
				slot.outputState = this.mapPlayerStatus(b.status);
				this.bus.publish(playerId, BUS_EVENT.stateChanged, a, b);
				if (b.status === AudioPlayerStatus.Buffering) this.armStuckWatchdog(slot);
				else this.clearStuckWatchdog(slot);
				if (b.status === AudioPlayerStatus.Idle && a.status !== AudioPlayerStatus.Idle) {
					const previousResource = "resource" in a ? a.resource : undefined;
					if (previousResource && slot.activeResource && previousResource !== slot.activeResource) return;
					const session = slot.activeSession;
					if (session?.isActive()) this.bus.event(playerId, { type: BUS_EVENT.trackEnd, session: session.snapshot() });
					slot.activeSession = null;
					slot.activeResource = null;
				}
			},
			onError: (error) => {
				const normalized = error instanceof Error ? error : new Error(String(error));
				const session = slot.activeSession;
				if (session?.isActive()) {
					this.bus.event(playerId, { type: BUS_EVENT.trackError, session: session.snapshot(), error: normalized });
					void this.reportStuck(slot, session, `audio player error: ${normalized.message}`).catch((reportError) =>
						this.reportAsyncFailure(slot, reportError, session.track),
					);
				} else {
					this.bus.event(playerId, { type: BUS_EVENT.streamError, error: normalized, track: null });
				}
			},
		};
		slot.detachBusHandlers.push(
			this.bus.subscribe(playerId, BUS_EVENT.volumeRequested, () => {
				if (!slot.activeResource) return;
				const track = slot.activeSession?.track ?? (slot.activeResource.metadata as Track | undefined);
				void this.applyTargetVolume(slot, slot.activeResource, track, slot.fadeGain ?? 1).catch((error) =>
					this.reportOutputOperationError(slot, slot.activeHandle, error),
				);
			}),
		);
		slot.audioPlayer?.on("stateChange", slot.onStateChange);
		if (options.audioOutputBackendFactory) slot.audioPlayer?.on("error", slot.onError);
		this.slots.set(playerId, slot);
	}

	/** Releases `playerId`'s slot: cancels timers, drops listeners and stops its AudioPlayer. */
	public detach(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		this.processingOptions.delete(playerId);
		this.slots.delete(playerId);
		slot.resourceRefreshInProgress = false;
		slot.disposed = true;
		slot.lifecycleAbort.abort();
		this.cancelTransition(slot);
		this.clearStuckWatchdog(slot);
		slot.activeSession?.destroy();
		slot.activeSession = null;
		for (const detach of slot.detachBusHandlers.splice(0)) detach();
		slot.audioPlayer?.removeListener("stateChange", slot.onStateChange);
		if (slot.audioPlayer && !(slot.outputBackend instanceof DiscordVoiceOutputBackend)) {
			slot.audioPlayer.removeListener("error", slot.onError);
		}
		const handleDisposals = [...slot.handles.values()].map((handle) => this.disposeOutputHandle(slot, handle));
		void Promise.all(handleDisposals)
			.then(() => slot.outputBackend.dispose())
			.catch((error) => {
				this.reportAsyncFailure(slot, error, null);
			});
		slot.activeResource = null;
		slot.activeHandle = null;
	}

	/** Global shutdown: releases every player's slot. */
	public dispose(playerId?: string): void {
		if (playerId) {
			this.detach(playerId);
			return;
		}
		for (const id of [...this.slots.keys()]) this.detach(id);
	}

	public getActiveResource(playerId: string): AudioResource | null {
		return this.slots.get(playerId)?.activeResource ?? null;
	}

	public getFadeGain(playerId: string): number | null {
		return this.slots.get(playerId)?.fadeGain ?? null;
	}

	public cancelFade(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (slot) this.cancelFadeSlot(slot);
	}

	public has(playerId: string): boolean {
		return this.slots.has(playerId);
	}

	// ---------------------------------------------------------------------
	// Per-player state accessors
	// ---------------------------------------------------------------------

	public countAttached(): number {
		return this.slots.size;
	}
	public aggregateSnapshot(): { playing: number; paused: number; idle: number; total: number } {
		let playing = 0;
		let paused = 0;
		let idle = 0;
		for (const playerId of this.slots.keys()) {
			switch (this.status(playerId)) {
				case AudioPlayerStatus.Playing:
					playing++;
					break;
				case AudioPlayerStatus.Paused:
					paused++;
					break;
				default:
					idle++;
					break;
			}
		}
		return { playing, paused, idle, total: this.slots.size };
	}
	public getAudioPlayer(playerId: string): AudioPlayer | null {
		return this.slots.get(playerId)?.audioPlayer ?? null;
	}
	public state(playerId: string): AudioPlayerState | null {
		return this.slots.get(playerId)?.audioPlayer?.state ?? null;
	}
	public status(playerId: string): AudioPlayerStatus | undefined {
		const slot = this.slots.get(playerId);
		return slot ? (slot.audioPlayer?.state.status ?? this.mapOutputState(slot.outputState)) : undefined;
	}
	private mapPlayerStatus(status: AudioPlayerStatus): AudioOutputState {
		switch (status) {
			case AudioPlayerStatus.Buffering:
				return "buffering";
			case AudioPlayerStatus.Playing:
				return "playing";
			case AudioPlayerStatus.Paused:
			case AudioPlayerStatus.AutoPaused:
				return "paused";
			case AudioPlayerStatus.Idle:
				return "stopped";
		}
	}
	private mapOutputState(state: AudioOutputState): AudioPlayerStatus {
		switch (state) {
			case "buffering":
				return AudioPlayerStatus.Buffering;
			case "playing":
				return AudioPlayerStatus.Playing;
			case "paused":
				return AudioPlayerStatus.Paused;
			default:
				return AudioPlayerStatus.Idle;
		}
	}
	public currentResource(playerId: string): AudioResource | null {
		const slot = this.slots.get(playerId);
		return slot?.activeSession?.resource ?? slot?.activeResource ?? null;
	}
	public currentSessionSnapshot(playerId: string) {
		return this.slots.get(playerId)?.activeSession?.snapshot() ?? null;
	}
	public currentSessionTrack(playerId: string): Track | null | undefined {
		return this.slots.get(playerId)?.activeSession?.track;
	}
	public position(playerId: string): number | null {
		const session = this.slots.get(playerId)?.activeSession;
		if (!session) return null;
		const duration = Number(session.resource?.playbackDuration);
		if (Number.isFinite(duration) && (duration > 0 || session.position === 0))
			session.updatePosition(session.getPlaybackOffset() + duration);
		return session.position;
	}
	public volumeValue(playerId: string): number {
		return this.bus.querySync(playerId, PLAYER_QUERY.volume) ?? 100;
	}

	// ---------------------------------------------------------------------
	// Bus helpers (controller-to-controller traffic always goes through the Bus)
	// ---------------------------------------------------------------------

	private requestTransitionPlan(playerId: string, from: Track | null, to: Track | null): TransitionPlanResponse {
		try {
			return this.bus.requestRpcSync(playerId, CONTROLLER_RPC.transitionPlan, { from, to });
		} catch {
			return NO_TRANSITION;
		}
	}

	private requestBeatWait(playerId: string, track: Track | null, positionMs: number): number {
		try {
			return this.bus.requestRpcSync(playerId, CONTROLLER_RPC.transitionBeatWait, { track, positionMs });
		} catch {
			return 0;
		}
	}

	private requestVolumeTarget(playerId: string, track?: Track | null): number {
		try {
			return this.bus.requestRpcSync(playerId, CONTROLLER_RPC.volumeTarget, { track });
		} catch {
			return 1;
		}
	}

	private async applyTargetVolume(
		slot: PlaybackSlot,
		resource: AudioResource | null,
		track?: Track | null,
		gain = 1,
		signal?: AbortSignal,
	): Promise<void> {
		if (!resource) return;
		const handle = slot.handles.get(resource);
		const target = this.requestVolumeTarget(slot.playerId, track);
		const value = target * Math.max(0, Number.isFinite(gain) ? gain : 1);
		if (slot.outputBackend.capabilities.volume === "unsupported") {
			if (value === 1) return;
			throw new AudioOutputUnsupportedOperationError("volume control");
		}
		if (!handle && slot.outputBackend instanceof DiscordVoiceOutputBackend) {
			slot.outputBackend.setVolume(resource, value);
			slot.volumeValues.set(resource, value);
			return;
		}
		if (!handle) throw new Error("No output handle is registered for the requested resource");
		await handle.setVolume(value, signal ?? slot.lifecycleAbort.signal);
		slot.volumeValues.set(resource, value);
	}

	private retirePendingSession(playerId: string): void {
		try {
			this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackSessionRetirePending, {});
		} catch {}
	}

	// ---------------------------------------------------------------------
	// Stuck watchdog / resource refresh / filter errors
	// ---------------------------------------------------------------------

	private reportStuck(slot: PlaybackSlot, session: PlaybackSession, reason: string): Promise<boolean> {
		if (!session.isActive()) return Promise.resolve(false);
		return this.bus.requestRpc(
			slot.playerId,
			CONTROLLER_RPC.antiStuckReport,
			{ session, reason, handlers: slot.recoveryHandlers },
			{ signal: session.signal },
		);
	}

	private armStuckWatchdog(slot: PlaybackSlot): void {
		this.clearStuckWatchdog(slot);
		if (slot.resourceRefreshInProgress || slot.stuckTimeoutMs <= 0 || !slot.activeSession?.isActive()) return;
		const resource = slot.activeResource;
		const session = slot.activeSession;
		const initialDuration = Number(resource?.playbackDuration ?? session.position);
		slot.stuckTimer = setTimeout(() => {
			slot.stuckTimer = null;
			if (
				slot.resourceRefreshInProgress ||
				slot.outputState !== "buffering" ||
				slot.activeResource !== resource ||
				slot.activeSession !== session
			)
				return;
			const currentDuration = Number(resource?.playbackDuration ?? session.position);
			if (currentDuration === initialDuration)
				void this.reportStuck(slot, session, `buffering stalled for ${slot.stuckTimeoutMs}ms`).catch((error) =>
					this.reportAsyncFailure(slot, error, session.track),
				);
			else this.armStuckWatchdog(slot);
		}, slot.stuckTimeoutMs);
	}
	private clearStuckWatchdog(slot: PlaybackSlot): void {
		if (slot.stuckTimer) clearTimeout(slot.stuckTimer);
		slot.stuckTimer = null;
	}
	public beginResourceRefresh(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		slot.resourceRefreshInProgress = true;
		this.clearStuckWatchdog(slot);
	}
	public endResourceRefresh(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		slot.resourceRefreshInProgress = false;
		if (slot.outputState === "buffering") this.armStuckWatchdog(slot);
	}
	public reportFilterError(playerId: string, error: Error): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		const session = slot.activeSession;
		if (!session?.isActive() || slot.resourceRefreshInProgress) {
			if (session?.isActive())
				void this.reportStuck(slot, session, `filter processing failed: ${error.message}`).catch((reportError) =>
					this.reportAsyncFailure(slot, reportError, session.track),
				);
			return;
		}
		void this.reportStuck(slot, session, `filter processing failed: ${error.message}`).catch((reportError) =>
			this.reportAsyncFailure(slot, reportError, session.track),
		);
	}

	private reportAsyncFailure(slot: PlaybackSlot, error: unknown, track: Track | null): void {
		this.bus.event(slot.playerId, {
			type: BUS_EVENT.streamError,
			error: error instanceof Error ? error : new Error(String(error)),
			track,
		});
	}

	// ---------------------------------------------------------------------
	// Playback operations
	// ---------------------------------------------------------------------

	/** Pure factory (no per-player state involved). */
	public createResource(
		playerId: string,
		stream: Readable,
		track: Track,
		inputType?: StreamType,
		signal?: AbortSignal,
	): AudioResource {
		const resolvedInputType = inputType ?? (stream as Readable & { inputType?: StreamType }).inputType;
		const processingOptions = this.processingOptions.get(playerId) ?? {};
		const slot = this.slots.get(playerId);
		if (!slot) throw new Error("No output backend is attached for this player");
		const outputSignal =
			slot ?
				signal ? AbortSignal.any([slot.lifecycleAbort.signal, signal])
				:	slot.lifecycleAbort.signal
			:	signal;
		if (processingOptions.enabled) {
			if (processingOptions.outputFormat === "encoded") {
				if (!stream.destroyed) stream.destroy();
				throw new TypeError("Audio processing currently supports PCM output only; encoded output is unavailable");
			}
			let engine: ReturnType<typeof createAudioProcessingEngine>;
			try {
				engine = createAudioProcessingEngine(processingOptions);
			} catch (error) {
				if (!stream.destroyed) stream.destroy();
				throw error;
			}
			const channels = processingOptions.channels ?? 2;
			const sampleFormat = processingOptions.outputFormat === "pcmFloat32" ? "f32" : "s16";
			const outputFormat: AudioFrameFormat = {
				kind: "pcm",
				sampleFormat,
				endianness: "little",
				sampleRateHz: processingOptions.resampleRate ?? processingOptions.sampleRate ?? 48_000,
				channels,
				channelLayout: "interleaved",
				chunkAlignmentBytes: channels * (sampleFormat === "f32" ? 4 : 2),
			};
			let processedStream: Readable;
			const abortProcessing = () => {
				if (!stream.destroyed) stream.destroy();
				if (!processedStream.destroyed) processedStream.destroy();
			};
			processedStream = Readable.from(
				(async function* () {
					let pipeline: Awaited<ReturnType<typeof engine.createPipeline>> | null = null;
					let completed = false;
					try {
						pipeline = await engine.createPipeline(processingOptions, { playerId, track, signal: outputSignal });
						for await (const chunk of pipeline.process(stream, outputSignal)) {
							if (outputSignal?.aborted) return;
							yield chunk;
						}
						completed = true;
					} catch (error) {
						if (outputSignal?.aborted) return;
						if (!stream.destroyed) stream.destroy();
						throw new Error(
							`Audio processing failed for ${track.title}: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
					} finally {
						outputSignal?.removeEventListener("abort", abortProcessing);
						await pipeline?.dispose();
						if (!completed && !stream.destroyed) stream.destroy();
					}
				})(),
				{ objectMode: false },
			);
			if (outputSignal) {
				if (outputSignal.aborted) abortProcessing();
				else outputSignal.addEventListener("abort", abortProcessing, { once: true });
			}
			processedStream.once("close", () => outputSignal?.removeEventListener("abort", abortProcessing));
			return this.createOutputResource(slot, processedStream, track, outputFormat, outputSignal);
		}
		return this.createOutputResource(slot, stream, track, audioFrameFormatFromDiscordStreamType(resolvedInputType), outputSignal);
	}

	private createOutputResource(
		slot: PlaybackSlot,
		stream: Readable,
		track: Track,
		format: AudioFrameFormat,
		signal?: AbortSignal,
	): AudioResource {
		const input: AudioOutputInput = { stream, format, ownership: "transfer" };
		if (slot.outputBackend.capabilities.ownership !== "both" && slot.outputBackend.capabilities.ownership !== input.ownership) {
			if (!stream.destroyed) stream.destroy();
			throw new TypeError(`Output backend does not accept ${input.ownership} stream ownership`);
		}
		try {
			const handle = slot.outputBackend.createSession(input, { metadata: track, signal });
			this.registerOutputHandle(slot, handle);
			return handle.resource;
		} catch (error) {
			if (input.ownership === "transfer" && !stream.destroyed) stream.destroy();
			throw error;
		}
	}

	private registerOutputHandle(slot: PlaybackSlot, handle: AudioOutputHandle<AudioResource>): void {
		if (slot.handles.get(handle.resource) === handle) return;
		const detach = handle.onEvent((event) => {
			if (slot.handles.get(handle.resource) !== handle) return;
			if (event.type === "error") {
				this.handleOutputError(slot, handle, event.error);
				return;
			}
			if (slot.activeHandle !== handle) return;
			slot.outputState = event.state;
			if (event.state === "buffering") this.armStuckWatchdog(slot);
			else this.clearStuckWatchdog(slot);
			if (event.state === "ended" && slot.activeHandle === handle) {
				const session = slot.activeSession;
				if (session?.isActive()) this.bus.event(slot.playerId, { type: BUS_EVENT.trackEnd, session: session.snapshot() });
				slot.activeSession = null;
				slot.activeResource = null;
				slot.activeHandle = null;
			} else if (event.state === "stopped" && slot.activeHandle === handle) {
				slot.activeSession?.markStopped();
				slot.activeSession = null;
				slot.activeResource = null;
				slot.activeHandle = null;
			}
		});
		slot.handles.set(handle.resource, handle);
		slot.handleDetachers.set(handle.resource, detach);
	}

	private handleOutputError(slot: PlaybackSlot, handle: AudioOutputHandle<AudioResource>, error: Error): void {
		if (slot.handles.get(handle.resource) !== handle) return;
		if (slot.activeHandle !== handle) {
			this.bus.event(slot.playerId, {
				type: BUS_EVENT.streamError,
				error,
				track: (handle.resource as AudioResource).metadata as Track | null,
			});
			void this.disposeOutputHandle(slot, handle);
			return;
		}
		slot.outputState = "failed";
		const session = slot.activeSession;
		if (session?.isActive()) {
			this.bus.event(slot.playerId, { type: BUS_EVENT.trackError, session: session.snapshot(), error });
			void this.reportStuck(slot, session, `audio output error: ${error.message}`).catch((reportError) =>
				this.bus.event(slot.playerId, {
					type: BUS_EVENT.streamError,
					error: reportError instanceof Error ? reportError : new Error(String(reportError)),
					track: session.track,
				}),
			);
		} else {
			this.bus.event(slot.playerId, { type: BUS_EVENT.streamError, error, track: null });
		}
		slot.activeHandle = null;
		slot.activeResource = null;
		void this.disposeOutputHandle(slot, handle);
	}

	private reportOutputOperationError(slot: PlaybackSlot, handle: AudioOutputHandle<AudioResource> | null, error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		if (handle && slot.handles.get(handle.resource) === handle) {
			this.handleOutputError(slot, handle, normalized);
			return;
		}
		this.bus.event(slot.playerId, { type: BUS_EVENT.streamError, error: normalized, track: null });
	}

	public play(
		playerId: string,
		resource: AudioResource,
		session?: PlaybackSession,
		from?: Track | null,
		to?: Track,
		signal?: AbortSignal,
	): void | Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		if (session && !session.isActive()) return;
		let handle = slot.handles.get(resource);
		if (!handle && slot.outputBackend instanceof DiscordVoiceOutputBackend) {
			handle = slot.outputBackend.getSessionHandle(resource);
			this.registerOutputHandle(slot, handle);
		}
		if (!handle) throw new Error("No output handle is registered for the requested resource");
		if (slot.outputBackend instanceof DiscordVoiceOutputBackend) {
			return this.playDiscordCompatibility(slot, resource, handle, session, from, to);
		}
		return this.playWithBackend(slot, resource, handle, session, from, to, signal);
	}

	private async playWithBackend(
		slot: PlaybackSlot,
		resource: AudioResource,
		handle: AudioOutputHandle<AudioResource>,
		session?: PlaybackSession,
		from?: Track | null,
		to?: Track,
		signal?: AbortSignal,
	): Promise<void> {
		const playerId = slot.playerId;
		this.cancelTransition(slot);
		const track = session?.track ?? to ?? (resource.metadata as Track | undefined);
		const plan = from && to ? this.requestTransitionPlan(playerId, from, to) : undefined;
		if (
			plan?.enabled &&
			slot.activeResource &&
			slot.outputState !== "stopped" &&
			slot.outputState !== "ended" &&
			slot.outputState !== "failed"
		) {
			if (slot.outputBackend.capabilities.volume === "unsupported") {
				await this.disposeOutputHandle(slot, handle);
				throw new AudioOutputUnsupportedOperationError("crossfade volume control");
			}
			if (slot.outputBackend.capabilities.replacement === "unsupported") {
				await this.disposeOutputHandle(slot, handle);
				throw new AudioOutputUnsupportedOperationError("track replacement");
			}
			try {
				await this.fadeTransition(slot, slot.activeResource, resource, plan, session, track);
			} catch (error) {
				if (slot.fadeResource === resource) {
					if (slot.fadeTimer) clearInterval(slot.fadeTimer);
					slot.fadeTimer = null;
					slot.fadeGain = null;
					slot.fadeResource = null;
				}
				if (slot.activeHandle === handle) {
					this.handleOutputError(slot, handle, error instanceof Error ? error : new Error(String(error)));
				} else {
					await this.disposeOutputHandle(slot, handle);
				}
				throw error;
			}
			return;
		}
		slot.fadeGain = null;
		try {
			await this.startOutputHandle(slot, handle, signal ?? session?.signal, (activeSignal) =>
				this.applyTargetVolume(slot, resource, track, 1, activeSignal),
			);
			if (slot.disposed || slot.activeHandle !== handle) {
				throw this.outputAbortError();
			}
			if (session) session.setResource(resource);
			slot.activeSession = session ?? null;
			slot.activeResource = resource;
			this.retirePendingSession(playerId);
		} catch (error) {
			if (slot.activeHandle !== handle) await this.disposeOutputHandle(slot, handle);
			throw error;
		}
	}

	private playDiscordCompatibility(
		slot: PlaybackSlot,
		resource: AudioResource,
		handle: AudioOutputHandle<AudioResource>,
		session?: PlaybackSession,
		from?: Track | null,
		to?: Track,
	): void {
		this.cancelTransition(slot);
		const track = session?.track ?? to ?? (resource.metadata as Track | undefined);
		const plan = from && to ? this.requestTransitionPlan(slot.playerId, from, to) : undefined;
		const currentStatus = slot.audioPlayer?.state.status ?? this.mapOutputState(slot.outputState);
		if (plan?.enabled && slot.activeResource && currentStatus !== AudioPlayerStatus.Idle) {
			if (slot.outputBackend.capabilities.volume === "unsupported") {
				void this.disposeOutputHandle(slot, handle);
				throw new AudioOutputUnsupportedOperationError("crossfade volume control");
			}
			if (slot.outputBackend.capabilities.replacement === "unsupported") {
				void this.disposeOutputHandle(slot, handle);
				throw new AudioOutputUnsupportedOperationError("track replacement");
			}
			void this.fadeTransition(slot, slot.activeResource, resource, plan, session, track).catch((error) =>
				this.reportOutputOperationError(slot, slot.handles.get(resource) ?? null, error),
			);
			return;
		}
		slot.fadeGain = null;
		void this.applyTargetVolume(slot, resource, track, 1).catch((error) => {
			this.reportOutputOperationError(slot, handle, error);
		});
		if (session) session.setResource(resource);
		slot.activeSession = session ?? null;
		slot.activeResource = resource;
		slot.activeHandle = handle;
		try {
			handle.start(session?.signal);
			slot.outputState = handle.state;
			this.retirePendingSession(slot.playerId);
		} catch (error) {
			this.handleOutputError(slot, handle, error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private async startOutputHandle(
		slot: PlaybackSlot,
		handle: AudioOutputHandle<AudioResource>,
		signal?: AbortSignal,
		beforeStart?: (signal: AbortSignal) => void | Promise<void>,
	): Promise<void> {
		const lifecycleSignal = slot.lifecycleAbort.signal;
		const startAbort = new AbortController();
		slot.startAbortControllers.set(handle, startAbort);
		const signals = [lifecycleSignal, startAbort.signal];
		if (signal) signals.push(signal);
		const activeSignal = AbortSignal.any(signals);
		let previous = slot.activeHandle;
		try {
			slot.backendInitialization ??= slot.outputBackend.initialize(lifecycleSignal);
			await this.awaitWithAbort(slot.backendInitialization, activeSignal);
			await this.awaitWithAbort(handle.ready, activeSignal);
			if (activeSignal.aborted) throw new Error("Audio output start was aborted");
			previous = slot.activeHandle;
			if (previous && previous !== handle) {
				if (slot.outputBackend.capabilities.replacement === "unsupported") {
					throw new AudioOutputUnsupportedOperationError("track replacement");
				}
				if (slot.outputBackend.capabilities.replacement === "stop-before-start") {
					try {
						await previous.stop(activeSignal);
					} catch (error) {
						await this.disposeOutputHandle(slot, previous);
						if (slot.activeHandle === previous) {
							slot.activeHandle = null;
							slot.activeResource = null;
							slot.activeSession?.markStopped();
							slot.activeSession = null;
						}
						throw error;
					}
					await this.disposeOutputHandle(slot, previous);
					if (slot.activeHandle === previous) {
						slot.activeHandle = null;
						slot.activeResource = null;
						slot.activeSession?.markStopped();
						slot.activeSession = null;
					}
				}
			}
			await beforeStart?.(activeSignal);
			if (activeSignal.aborted || slot.disposed) throw this.outputAbortError();
			await handle.start(activeSignal);
			if (activeSignal.aborted || slot.disposed) throw this.outputAbortError();
			if (slot.handles.get(handle.resource) !== handle || handle.state === "failed") {
				throw new Error("Audio output handle failed during startup");
			}
			slot.activeHandle = handle;
			slot.outputState = handle.state;
			if (previous && previous !== handle) await this.disposeOutputHandle(slot, previous);
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (slot.activeHandle === handle) {
				this.handleOutputError(slot, handle, normalized);
			} else if (!activeSignal.aborted && !(normalized.name === "AbortError")) {
				this.reportOutputOperationError(slot, handle, normalized);
			}
			if (
				previous &&
				slot.activeHandle === previous &&
				(previous.state === "stopped" || previous.state === "ended" || previous.state === "failed")
			) {
				slot.activeHandle = null;
				slot.activeResource = null;
				slot.activeSession?.markStopped();
				slot.activeSession = null;
				slot.outputState = previous.state;
				await this.disposeOutputHandle(slot, previous);
			}
			throw error;
		} finally {
			if (slot.startAbortControllers.get(handle) === startAbort) {
				slot.startAbortControllers.delete(handle);
			}
		}
	}

	private async awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		if (signal.aborted) throw this.outputAbortError();
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(this.outputAbortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	private outputAbortError(): Error {
		const error = new Error("Audio output operation was aborted");
		error.name = "AbortError";
		return error;
	}

	private async disposeOutputHandle(slot: PlaybackSlot, handle: AudioOutputHandle<AudioResource>): Promise<void> {
		const existing = slot.disposalPromises.get(handle);
		if (existing) return existing;
		const detach = slot.handleDetachers.get(handle.resource);
		detach?.();
		slot.handleDetachers.delete(handle.resource);
		slot.handles.delete(handle.resource);
		slot.volumeValues.delete(handle.resource);
		let finishDisposal!: () => void;
		const disposal = new Promise<void>((resolve) => {
			finishDisposal = resolve;
		});
		slot.disposalPromises.set(handle, disposal);
		const reportDisposalFailure = (error: unknown) => {
			try {
				this.bus.event(slot.playerId, {
					type: BUS_EVENT.streamError,
					error: error instanceof Error ? error : new Error(String(error)),
					track: slot.activeSession?.track ?? ((handle.resource as AudioResource).metadata as Track | null),
				});
			} catch (reportError) {
				console.error("[PlaybackController] Failed to report output disposal error:", reportError);
			} finally {
				finishDisposal();
			}
		};
		try {
			void Promise.resolve(handle.dispose()).then(finishDisposal, reportDisposalFailure);
		} catch (error) {
			reportDisposalFailure(error);
		}
		return disposal;
	}

	public async fadeResourceVolume(
		playerId: string,
		resource: AudioResource,
		from: number,
		to: number,
		durationMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		const abortSignal = signal ?? slot.lifecycleAbort.signal;
		if (!resource) return;
		const duration = Math.max(0, durationMs);
		if (duration === 0) {
			if (!abortSignal.aborted && !slot.disposed) await this.setResourceVolume(slot, resource, to);
			return;
		}
		const start = Date.now();
		while (!abortSignal.aborted && !slot.disposed) {
			const progress = Math.min(1, (Date.now() - start) / duration);
			await this.setResourceVolume(slot, resource, from + (to - from) * progress);
			if (progress >= 1) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}
	private async setResourceVolume(slot: PlaybackSlot, resource: AudioResource, value: number): Promise<void> {
		const handle = slot.handles.get(resource);
		if (slot.outputBackend.capabilities.volume === "unsupported") {
			throw new AudioOutputUnsupportedOperationError("volume control");
		}
		if (!handle && slot.outputBackend instanceof DiscordVoiceOutputBackend) {
			slot.outputBackend.setVolume(resource, value);
			slot.volumeValues.set(resource, value);
			return;
		}
		if (!handle) throw new Error("No output handle is registered for the requested resource");
		await handle.setVolume(value, slot.lifecycleAbort.signal);
		slot.volumeValues.set(resource, value);
	}
	public async applyCrossfadeIn(playerId: string, resource: AudioResource, track: Track): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot || slot.disposed) return;
		if (slot.outputBackend.capabilities.volume === "unsupported") {
			throw new AudioOutputUnsupportedOperationError("crossfade volume control");
		}
		await this.applyTargetVolume(slot, resource, track, 1);
		const target = slot.volumeValues.get(resource) ?? 0;
		await this.setResourceVolume(slot, resource, 0);
		await this.fadeResourceVolume(
			playerId,
			resource,
			0,
			target,
			this.requestTransitionPlan(playerId, slot.activeSession?.track ?? null, track).durationMs,
			slot.lifecycleAbort.signal,
		);
	}
	public async applyCrossfadeOutCurrent(playerId: string): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot || slot.disposed) return;
		const resource = slot.activeResource;
		if (!resource) return;
		const track = slot.activeSession?.track ?? (resource.metadata as Track | undefined);
		const current =
			slot.volumeValues.get(resource) ??
			(slot.outputBackend instanceof DiscordVoiceOutputBackend ? slot.outputBackend.getVolume(resource) : null);
		if (current == null) return;
		await this.fadeResourceVolume(
			playerId,
			resource,
			current,
			0,
			this.requestTransitionPlan(playerId, track ?? null, track ?? null).durationMs,
			slot.lifecycleAbort.signal,
		);
	}
	public async crossfadeSkipAndStop(playerId: string): Promise<void> {
		await this.applyCrossfadeOutCurrent(playerId);
		const slot = this.slots.get(playerId);
		if (slot && !slot.disposed) await this.stop(playerId);
	}
	public getTrackTargetVolume(playerId: string, track?: Track | null): number {
		return this.requestVolumeTarget(playerId, track);
	}
	private fadeTransition(
		slot: PlaybackSlot,
		oldResource: AudioResource,
		newResource: AudioResource,
		plan: TransitionPlanResponse,
		session?: PlaybackSession,
		track?: Track,
	): Promise<void> {
		slot.fadeGain = 0;
		slot.fadeResource = newResource;
		const outgoingTrack = slot.activeSession?.track ?? (oldResource.metadata as Track | undefined) ?? null;
		const outgoingPosition = slot.activeSession?.position ?? 0;
		const wait = plan.waitForBeat ? this.requestBeatWait(slot.playerId, outgoingTrack, outgoingPosition) : 0;
		const begin = async (): Promise<void> => {
			slot.transitionTimer = null;
			if (slot.disposed || (session && !session.isActive())) {
				this.cancelFadeSlot(slot);
				return;
			}
			slot.fadeGain = 0;
			const handle = slot.handles.get(newResource);
			if (!handle) throw new Error("No output handle is registered for the transition resource");
			await this.startOutputHandle(slot, handle, session?.signal, (activeSignal) =>
				this.applyTargetVolume(slot, newResource, track, 0, activeSignal),
			);
			if (slot.disposed || slot.activeHandle !== handle) {
				if (slot.activeHandle !== handle) await this.disposeOutputHandle(slot, handle);
				return;
			}
			if (session && !session.isActive()) {
				try {
					await handle.stop(slot.lifecycleAbort.signal);
				} catch (error) {
					this.reportOutputOperationError(slot, handle, error);
				}
				await this.disposeOutputHandle(slot, handle);
				if (slot.activeHandle === handle) {
					slot.activeHandle = null;
					slot.activeResource = null;
					slot.activeSession = null;
					slot.outputState = "stopped";
				}
				return;
			}
			if (session) session.setResource(newResource);
			slot.activeSession = session ?? null;
			slot.activeResource = newResource;
			this.retirePendingSession(slot.playerId);
			if (slot.fadeGain === null) {
				slot.fadeResource = null;
				await this.applyTargetVolume(slot, newResource, track, 1);
				return;
			}
			const start = Date.now();
			slot.fadeTimer = setInterval(() => {
				if (session && !session.isActive()) {
					this.cancelFadeSlot(slot);
					return;
				}
				const p = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs));
				slot.fadeGain = p;
				void this.applyTargetVolume(slot, newResource, track, p).catch((error) =>
					this.reportOutputOperationError(slot, handle, error),
				);
				if (p >= 1) {
					this.cancelFadeSlot(slot);
					void this.applyTargetVolume(slot, newResource, track, 1).catch((error) =>
						this.reportOutputOperationError(slot, handle, error),
					);
				}
			}, 25);
		};
		return new Promise<void>((resolve, reject) => {
			const run = () => {
				slot.transitionTimer = null;
				slot.transitionStartResolve = null;
				void begin().then(resolve, reject);
			};
			if (wait > 0) {
				slot.transitionStartResolve = resolve;
				slot.transitionTimer = setTimeout(run, wait);
			} else {
				void begin().then(resolve, reject);
			}
		});
	}

	private cancelFadeSlot(slot: PlaybackSlot): void {
		if (slot.fadeTimer) {
			clearInterval(slot.fadeTimer);
			slot.fadeTimer = null;
		}
		if (slot.fadeGain !== null) {
			slot.fadeGain = null;
			const resource = slot.fadeResource ?? slot.activeResource;
			slot.fadeResource = null;
			if (resource) {
				const track =
					resource === slot.activeResource ?
						(slot.activeSession?.track ?? (resource.metadata as Track | undefined))
					:	(resource.metadata as Track | undefined);
				void this.applyTargetVolume(slot, resource, track, 1).catch((error) => {
					const handle = slot.handles.get(resource);
					this.reportOutputOperationError(slot, handle ?? null, error);
				});
			}
		}
	}
	private cancelTransition(slot: PlaybackSlot): void {
		if (slot.transitionTimer) {
			clearTimeout(slot.transitionTimer);
			slot.transitionTimer = null;
			const resource = slot.fadeResource;
			const handle = resource ? slot.handles.get(resource) : undefined;
			if (handle && slot.activeHandle !== handle) {
				void this.disposeOutputHandle(slot, handle);
			}
			slot.transitionStartResolve?.();
			slot.transitionStartResolve = null;
		}
		this.cancelFadeSlot(slot);
	}
	public async pause(playerId: string, signal?: AbortSignal): Promise<boolean> {
		const mode = this.bus.querySync(playerId, PLAYER_QUERY.playbackMode);
		if (mode === PlaybackMode.REMOTE) {
			return this.bus.requestRpc(playerId, CONTROLLER_RPC.playbackRemotePause, {});
		}
		const slot = this.slots.get(playerId);
		if (!slot?.activeHandle) return false;
		if (!slot.outputBackend.capabilities.pause) throw new AudioOutputUnsupportedOperationError("pause");
		return slot.activeHandle.pause(signal ?? slot.lifecycleAbort.signal);
	}
	public async resume(playerId: string, signal?: AbortSignal): Promise<boolean> {
		const mode = this.bus.querySync(playerId, PLAYER_QUERY.playbackMode);
		if (mode === PlaybackMode.REMOTE) {
			return this.bus.requestRpc(playerId, CONTROLLER_RPC.playbackRemoteResume, {});
		}
		const slot = this.slots.get(playerId);
		if (!slot?.activeHandle) return false;
		if (!slot.outputBackend.capabilities.resume) throw new AudioOutputUnsupportedOperationError("resume");
		return slot.activeHandle.resume(signal ?? slot.lifecycleAbort.signal);
	}
	public async stop(playerId: string, signal?: AbortSignal): Promise<boolean> {
		const mode = this.bus.querySync(playerId, PLAYER_QUERY.playbackMode);
		if (mode === PlaybackMode.REMOTE) {
			const pending = this.remoteStopPromises.get(playerId);
			if (pending) return pending;
			const operation = this.bus.requestRpc<Record<string, never>, boolean>(
				playerId,
				CONTROLLER_RPC.playbackRemoteStop,
				{},
				{ signal },
			);
			this.remoteStopPromises.set(playerId, operation);
			try {
				return await operation;
			} finally {
				if (this.remoteStopPromises.get(playerId) === operation) this.remoteStopPromises.delete(playerId);
			}
		}
		const slot = this.slots.get(playerId);
		if (!slot) return false;
		this.cancelTransition(slot);
		for (const startAbort of slot.startAbortControllers.values()) startAbort.abort();
		const handle = slot.activeHandle;
		const pendingDisposals = [...slot.handles.values()]
			.filter((candidate) => candidate !== handle)
			.map((candidate) => this.disposeOutputHandle(slot, candidate));
		await Promise.all(pendingDisposals);
		if (!handle) return false;
		const ongoing = slot.stopPromises.get(handle);
		if (ongoing) return ongoing;
		const operation = Promise.resolve().then(async () => {
			const session = slot.activeSession;
			let stopped = false;
			let stopError: unknown;
			let stopFailed = false;
			try {
				if (!slot.outputBackend.capabilities.stop) {
					throw new AudioOutputUnsupportedOperationError("stop");
				}
				const stopSignal = signal ?? slot.lifecycleAbort.signal;
				const stopOperation = Promise.resolve().then(() => handle.stop(stopSignal));
				stopped = await this.awaitWithAbort(stopOperation, stopSignal);
			} catch (error) {
				stopFailed = true;
				stopError = error;
			}
			await this.disposeOutputHandle(slot, handle);
			if (slot.activeHandle === handle) {
				slot.activeHandle = null;
				slot.activeResource = null;
				slot.outputState = "stopped";
				if (slot.activeSession === session) {
					session?.markStopped();
					slot.activeSession = null;
				}
			}
			if (stopFailed) throw stopError;
			return stopped;
		});
		slot.stopPromises.set(handle, operation);
		try {
			return await operation;
		} finally {
			if (slot.stopPromises.get(handle) === operation) slot.stopPromises.delete(handle);
		}
	}
	public async seek(playerId: string, position: number, session?: PlaybackSession): Promise<boolean> {
		if (!this.slots.has(playerId)) return false;
		if (!Number.isFinite(position) || position < 0) return false;
		if (session && !session.isActive()) return false;
		try {
			await this.bus.requestRpc(playerId, PLAYER_RPC.playbackRefreshResource, { position });
			return !session || session.isActive();
		} catch {
			return false;
		}
	}
	public setVolume(playerId: string, value: number): number {
		try {
			return this.bus.requestRpcSync(playerId, CONTROLLER_RPC.volumeSet, { value });
		} catch {
			return this.volumeValue(playerId);
		}
	}
}
