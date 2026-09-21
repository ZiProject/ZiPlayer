import type { AudioResource } from "@discordjs/voice";
import type { Bus, PlayerAction, PlayerActionExecutionContext } from "../structures/Bus";
import type { Track } from "../types";
import {
	BUS_EVENT,
	CONTROLLER_RPC,
	PLAYER_QUERY,
	PLAYER_RPC,
	type VolumeTargetRequest,
	type VolumeSetRequest,
} from "../structures/BusContract";
import type { VolumeControllerOptions } from "../types";

type ActiveResourceState = {
	resource: AudioResource | null;
	track?: Track | null;
	gain?: number;
};

interface VolumeState {
	volume: number;
	loudness: Required<NonNullable<VolumeControllerOptions["loudness"]>>;
	activeResourceResolver: (() => ActiveResourceState) | null;
}

/** Shared, singleton controller: owns per-player volume state and resource-level volume
 *  application, keyed by playerId. */
export class VolumeController {
	private readonly states = new Map<string, VolumeState>();
	private disposed = false;

	constructor(private readonly bus: Bus) {
		bus.onAction((action, context) => this.handleAction(action, context));
		bus.registerQuery(PLAYER_QUERY.volume, (playerId) => this.value(playerId));
		bus.registerRpc<VolumeSetRequest, number>(PLAYER_RPC.volumeSet, ({ value }, ctx) => this.setVolume(ctx.playerId, value));
		bus.registerRpc<VolumeTargetRequest, number>(CONTROLLER_RPC.volumeTarget, ({ track }, ctx) =>
			this.getTargetVolume(ctx.playerId, track),
		);
		bus.registerRpc<VolumeSetRequest, number>(CONTROLLER_RPC.volumeSet, ({ value }, ctx) => this.setVolume(ctx.playerId, value));
	}

	attach(playerId: string, options: VolumeControllerOptions = {}): void {
		this.states.set(playerId, {
			volume: this.clamp(options.initialVolume ?? 100),
			loudness: {
				enabled: options.loudness?.enabled ?? false,
				targetLUFS: options.loudness?.targetLUFS ?? -14,
				maxBoostDb: Math.max(0, options.loudness?.maxBoostDb ?? 6),
				maxCutDb: Math.max(0, options.loudness?.maxCutDb ?? 12),
				limiterCeiling: Math.min(1, Math.max(0, options.loudness?.limiterCeiling ?? 1)),
			},
			activeResourceResolver: null,
		});
	}
	detach(playerId: string): void {
		this.states.delete(playerId);
	}

	private handleAction(action: PlayerAction, context: PlayerActionExecutionContext): void {
		if (context.signal.aborted || action.type !== "SET_VOLUME" || this.disposed) return;
		this.setVolume(context.playerId, action.volume);
	}

	value(playerId: string): number {
		return this.states.get(playerId)?.volume ?? 100;
	}

	settings(playerId: string): Readonly<VolumeState["loudness"]> | undefined {
		return this.states.get(playerId)?.loudness;
	}

	/** Bind the currently active playback resource so volume changes take effect immediately. */
	bindActiveResourceResolver(playerId: string, resolver: (() => ActiveResourceState) | null): void {
		const state = this.states.get(playerId);
		if (state) state.activeResourceResolver = resolver;
	}

	setVolume(playerId: string, value: number): number {
		const state = this.states.get(playerId);
		if (this.disposed || !state) return state?.volume ?? 100;
		const oldVolume = state.volume;
		state.volume = this.clamp(value);
		if (state.volume !== oldVolume)
			this.bus.event(playerId, { type: BUS_EVENT.volumeRequested, volume: state.volume, oldVolume, newVolume: state.volume });

		const active = state.activeResourceResolver?.();
		if (active?.resource) {
			this.applyLoudness(playerId, active.resource, active.track, active.gain ?? 1);
		}

		return state.volume;
	}

	apply(playerId: string, resource: AudioResource | null, gain = 1): void {
		if (!resource?.volume) return;
		const volume = this.value(playerId);
		resource.volume.setVolume((volume / 100) * this.clampGain(gain));
	}

	/** Apply LUFS-based loudness normalization using track.metadata.lufs. */
	applyLoudness(playerId: string, resource: AudioResource | null, track?: Track | null, transitionGain = 1): void {
		const loudness = this.settings(playerId);
		if (!loudness?.enabled || !track) {
			this.apply(playerId, resource, transitionGain);
			return;
		}

		const measuredLUFS = Number(track.metadata?.lufs);
		if (!Number.isFinite(measuredLUFS)) {
			this.apply(playerId, resource, transitionGain);
			return;
		}

		let correctionDb = loudness.targetLUFS - measuredLUFS;
		correctionDb = Math.min(loudness.maxBoostDb, Math.max(-loudness.maxCutDb, correctionDb));

		const correction = Math.pow(10, correctionDb / 20);
		const limitedCorrection = Math.min(correction, loudness.limiterCeiling);
		this.apply(playerId, resource, limitedCorrection * transitionGain);
	}

	getTargetVolume(playerId: string, track?: Track | null): number {
		const state = this.states.get(playerId);
		const volume = state?.volume ?? 100;
		const loudness = state?.loudness;
		if (!loudness?.enabled || !track) return volume / 100;
		const measuredLUFS = Number(track.metadata?.lufs);
		if (!Number.isFinite(measuredLUFS)) return volume / 100;
		let correctionDb = loudness.targetLUFS - measuredLUFS;
		correctionDb = Math.min(loudness.maxBoostDb, Math.max(-loudness.maxCutDb, correctionDb));
		const correction = Math.pow(10, correctionDb / 20);
		const limitedCorrection = Math.min(correction, loudness.limiterCeiling);
		return (volume / 100) * limitedCorrection;
	}

	dispose(): void {
		this.disposed = true;
		this.states.clear();
	}

	private clamp(value: number): number {
		return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
	}

	private clampGain(value: number): number {
		return Number.isFinite(value) ? Math.max(0, value) : 1;
	}
}
