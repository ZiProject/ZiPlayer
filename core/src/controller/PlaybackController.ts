import {
	AudioPlayer,
	AudioPlayerState,
	AudioPlayerStatus,
	AudioResource,
	createAudioResource,
	type StreamType,
} from "@discordjs/voice";
import { Readable } from "stream";
import type { Bus } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track, PlaybackControllerOptions } from "../types";
import type { AntiStuckRetryHandlers } from "../types";
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
	readonly audioPlayer: AudioPlayer;
	readonly stuckTimeoutMs: number;
	readonly recoveryHandlers: AntiStuckRetryHandlers;
	readonly lifecycleAbort: AbortController;
	readonly detachBusHandlers: Array<() => void>;
	readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;
	readonly onError: (error: Error) => void;
	activeResource: AudioResource | null;
	activeSession: PlaybackSession | null;
	transitionTimer: ReturnType<typeof setTimeout> | null;
	fadeTimer: ReturnType<typeof setInterval> | null;
	stuckTimer: ReturnType<typeof setTimeout> | null;
	resourceRefreshInProgress: boolean;
	fadeGain: number | null;
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
		bus.registerRpc<{ resource: AudioResource; session?: PlaybackSession; from?: Track | null; to?: Track }, void>(
			CONTROLLER_RPC.playbackPlay,
			({ resource, session, from, to }, ctx) => this.play(ctx.playerId, resource, session, from, to),
		);
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackPause, (_req, ctx) => this.pause(ctx.playerId));
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackResume, (_req, ctx) => this.resume(ctx.playerId));
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackStop, (_req, ctx) => this.stop(ctx.playerId));
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
				return this.createResource(stream, track, inputType);
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
		const slot: PlaybackSlot = {
			playerId,
			audioPlayer: options.audioPlayer,
			stuckTimeoutMs: Math.max(0, options.stuckTimeoutMs ?? 10000),
			lifecycleAbort: new AbortController(),
			detachBusHandlers: [],
			activeResource: null,
			activeSession: null,
			transitionTimer: null,
			fadeTimer: null,
			stuckTimer: null,
			resourceRefreshInProgress: false,
			fadeGain: null,
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
					void this.reportStuck(slot, session, `audio player error: ${normalized.message}`);
				} else {
					this.bus.event(playerId, { type: BUS_EVENT.streamError, error: normalized, track: null });
				}
			},
		};
		slot.detachBusHandlers.push(
			this.bus.subscribe(playerId, BUS_EVENT.volumeRequested, () => {
				if (!slot.activeResource) return;
				const track = slot.activeSession?.track ?? (slot.activeResource.metadata as Track | undefined);
				this.applyTargetVolume(slot, slot.activeResource, track, slot.fadeGain ?? 1);
			}),
		);
		slot.audioPlayer.on("stateChange", slot.onStateChange);
		slot.audioPlayer.on("error", slot.onError);
		this.slots.set(playerId, slot);
	}

	/** Releases `playerId`'s slot: cancels timers, drops listeners and stops its AudioPlayer. */
	public detach(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		this.slots.delete(playerId);
		slot.resourceRefreshInProgress = false;
		slot.disposed = true;
		slot.lifecycleAbort.abort();
		this.cancelTransition(slot);
		this.clearStuckWatchdog(slot);
		slot.activeSession?.destroy();
		slot.activeSession = null;
		for (const detach of slot.detachBusHandlers.splice(0)) detach();
		slot.audioPlayer.removeListener("stateChange", slot.onStateChange);
		slot.audioPlayer.removeListener("error", slot.onError);
		slot.audioPlayer.stop(true);
		slot.activeResource = null;
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
		for (const slot of this.slots.values()) {
			switch (slot.audioPlayer.state.status) {
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
		return this.slots.get(playerId)?.audioPlayer.state ?? null;
	}
	public status(playerId: string): AudioPlayerStatus | undefined {
		return this.slots.get(playerId)?.audioPlayer.state.status;
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

	private applyTargetVolume(slot: PlaybackSlot, resource: AudioResource | null, track?: Track | null, gain = 1): void {
		if (!resource?.volume) return;
		const target = this.requestVolumeTarget(slot.playerId, track);
		resource.volume.setVolume(target * Math.max(0, Number.isFinite(gain) ? gain : 1));
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
				slot.audioPlayer.state.status !== AudioPlayerStatus.Buffering ||
				slot.activeResource !== resource ||
				slot.activeSession !== session
			)
				return;
			const currentDuration = Number(resource?.playbackDuration ?? session.position);
			if (currentDuration === initialDuration)
				void this.reportStuck(slot, session, `buffering stalled for ${slot.stuckTimeoutMs}ms`);
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
		if (slot.audioPlayer.state.status === AudioPlayerStatus.Buffering) this.armStuckWatchdog(slot);
	}
	public reportFilterError(playerId: string, error: Error): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		const session = slot.activeSession;
		if (!session?.isActive() || slot.resourceRefreshInProgress) {
			if (session?.isActive()) void this.reportStuck(slot, session, `filter processing failed: ${error.message}`);
			return;
		}
		void this.reportStuck(slot, session, `filter processing failed: ${error.message}`);
	}

	// ---------------------------------------------------------------------
	// Playback operations
	// ---------------------------------------------------------------------

	/** Pure factory (no per-player state involved). */
	public createResource(stream: Readable, track: Track, inputType?: StreamType): AudioResource {
		const resolvedInputType = inputType ?? (stream as Readable & { inputType?: StreamType }).inputType;
		return createAudioResource(stream, {
			metadata: track,
			inlineVolume: true,
			...(resolvedInputType ? { inputType: resolvedInputType } : {}),
		});
	}

	public play(playerId: string, resource: AudioResource, session?: PlaybackSession, from?: Track | null, to?: Track): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		if (session && !session.isActive()) return;
		this.cancelTransition(slot);
		const track = session?.track ?? to ?? (resource.metadata as Track | undefined);
		const plan = from && to ? this.requestTransitionPlan(playerId, from, to) : undefined;
		if (plan?.enabled && slot.activeResource && slot.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
			this.fadeTransition(slot, slot.activeResource, resource, plan, session, track);
			return;
		}
		slot.fadeGain = null;
		this.applyTargetVolume(slot, resource, track, 1);
		if (session) session.setResource(resource);
		slot.activeSession = session ?? null;
		slot.activeResource = resource;
		slot.audioPlayer.play(resource);
		this.retirePendingSession(playerId);
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
		if (!resource?.volume) return;
		const duration = Math.max(0, durationMs);
		if (duration === 0) {
			if (!abortSignal.aborted && !slot.disposed) resource.volume.setVolume(to);
			return;
		}
		const start = Date.now();
		while (!abortSignal.aborted && !slot.disposed) {
			const progress = Math.min(1, (Date.now() - start) / duration);
			resource.volume.setVolume(from + (to - from) * progress);
			if (progress >= 1) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}
	public async applyCrossfadeIn(playerId: string, resource: AudioResource, track: Track): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot || !resource?.volume || slot.disposed) return;
		this.applyTargetVolume(slot, resource, track, 1);
		const target = resource.volume.volume;
		resource.volume.setVolume(0);
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
		if (!resource?.volume) return;
		const track = slot.activeSession?.track ?? (resource.metadata as Track | undefined);
		const current = Number(resource.volume.volume ?? 0);
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
		if (slot && !slot.disposed) this.stop(playerId);
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
	): void {
		slot.fadeGain = 0;
		this.applyTargetVolume(slot, newResource, track, 0);
		const outgoingTrack = slot.activeSession?.track ?? (oldResource.metadata as Track | undefined) ?? null;
		const outgoingPosition = slot.activeSession?.position ?? 0;
		const wait = plan.waitForBeat ? this.requestBeatWait(slot.playerId, outgoingTrack, outgoingPosition) : 0;
		const begin = () => {
			slot.transitionTimer = null;
			if (slot.disposed || (session && !session.isActive())) {
				this.cancelFadeSlot(slot);
				return;
			}
			slot.fadeGain = 0;
			this.applyTargetVolume(slot, newResource, track, 0);
			slot.audioPlayer.play(newResource);
			this.retirePendingSession(slot.playerId);
			if (session) session.setResource(newResource);
			slot.activeSession = session ?? null;
			slot.activeResource = newResource;
			const start = Date.now();
			slot.fadeTimer = setInterval(() => {
				if (session && !session.isActive()) {
					this.cancelFadeSlot(slot);
					return;
				}
				const p = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs));
				slot.fadeGain = p;
				this.applyTargetVolume(slot, newResource, track, p);
				if (p >= 1) {
					this.cancelFadeSlot(slot);
					this.applyTargetVolume(slot, newResource, track, 1);
				}
			}, 25);
		};
		if (wait > 0) slot.transitionTimer = setTimeout(begin, wait);
		else begin();
	}

	private cancelFadeSlot(slot: PlaybackSlot): void {
		if (slot.fadeTimer) {
			clearInterval(slot.fadeTimer);
			slot.fadeTimer = null;
		}
		if (slot.fadeGain !== null) {
			slot.fadeGain = null;
			if (slot.activeResource) {
				const track = slot.activeSession?.track ?? (slot.activeResource.metadata as Track | undefined);
				this.applyTargetVolume(slot, slot.activeResource, track, 1);
			}
		}
	}
	private cancelTransition(slot: PlaybackSlot): void {
		if (slot.transitionTimer) {
			clearTimeout(slot.transitionTimer);
			slot.transitionTimer = null;
		}
		this.cancelFadeSlot(slot);
	}
	public pause(playerId: string): boolean {
		return this.slots.get(playerId)?.audioPlayer.pause(true) ?? false;
	}
	public resume(playerId: string): boolean {
		return this.slots.get(playerId)?.audioPlayer.unpause() ?? false;
	}
	public stop(playerId: string): boolean {
		const slot = this.slots.get(playerId);
		if (!slot) return false;
		this.cancelTransition(slot);
		slot.activeSession = null;
		slot.activeResource = null;
		return slot.audioPlayer.stop(true);
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
