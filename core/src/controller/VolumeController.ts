import type { AudioResource } from "@discordjs/voice";
import type { PlayerBus, PlayerAction, PlayerActionExecutionContext } from "../structures/PlayerBus";
import type { Track } from "../types";

export interface VolumeControllerOptions {
	initialVolume?: number;
	loudness?: {
		enabled?: boolean;
		targetLUFS?: number;
		maxBoostDb?: number;
		maxCutDb?: number;
		limiterCeiling?: number;
	};
}

type ActiveResourceState = {
	resource: AudioResource | null;
	track?: Track | null;
	gain?: number;
};

/** Owns player volume state and resource-level volume application. */
export class VolumeController {
	private volume: number;
	private readonly loudness: Required<NonNullable<VolumeControllerOptions["loudness"]>>;
	private disposed = false;
	private activeResourceResolver: (() => ActiveResourceState) | null = null;
	private readonly detachAction: () => void;
	private readonly detachQuery: () => void;

	constructor(
		private readonly bus: PlayerBus,
		options: VolumeControllerOptions = {},
	) {
		this.volume = this.clamp(options.initialVolume ?? 100);
		this.loudness = {
			enabled: options.loudness?.enabled ?? false,
			targetLUFS: options.loudness?.targetLUFS ?? -14,
			maxBoostDb: Math.max(0, options.loudness?.maxBoostDb ?? 6),
			maxCutDb: Math.max(0, options.loudness?.maxCutDb ?? 12),
			limiterCeiling: Math.min(1, Math.max(0, options.loudness?.limiterCeiling ?? 1)),
		};
		this.detachAction = bus.onAction((action, context) => this.handleAction(action, context));
		this.detachQuery = bus.registerQuery("volume", () => this.value);
	}

	private handleAction(action: PlayerAction, context: PlayerActionExecutionContext): void {
		if (context.signal.aborted || action.type !== "SET_VOLUME") return;
		this.setVolume(action.volume);
	}

	get value(): number {
		return this.volume;
	}

	get settings(): Readonly<typeof this.loudness> {
		return this.loudness;
	}

	/** Bind the currently active playback resource so volume changes take effect immediately. */
	bindActiveResourceResolver(resolver: (() => ActiveResourceState) | null): void {
		this.activeResourceResolver = resolver;
	}

	setVolume(value: number): number {
		if (this.disposed) return this.volume;
		this.volume = this.clamp(value);

		const active = this.activeResourceResolver?.();
		if (active?.resource) {
			this.applyLoudness(active.resource, active.track, active.gain ?? 1);
		}

		return this.volume;
	}

	apply(resource: AudioResource | null, gain = 1): void {
		if (!resource?.volume) return;
		resource.volume.setVolume((this.volume / 100) * this.clampGain(gain));
	}

	/** Apply LUFS-based loudness normalization using track.metadata.lufs. */
	applyLoudness(resource: AudioResource | null, track?: Track | null, transitionGain = 1): void {
		if (!this.loudness.enabled || !track) {
			this.apply(resource, transitionGain);
			return;
		}

		const measuredLUFS = Number(track.metadata?.lufs);
		if (!Number.isFinite(measuredLUFS)) {
			this.apply(resource, transitionGain);
			return;
		}

		let correctionDb = this.loudness.targetLUFS - measuredLUFS;
		correctionDb = Math.min(this.loudness.maxBoostDb, Math.max(-this.loudness.maxCutDb, correctionDb));

		const correction = Math.pow(10, correctionDb / 20);
		const limitedCorrection = Math.min(correction, this.loudness.limiterCeiling);
		this.apply(resource, limitedCorrection * transitionGain);
	}

	dispose(): void {
		this.disposed = true;
		this.activeResourceResolver = null;
		this.detachAction();
		this.detachQuery();
	}

	private clamp(value: number): number {
		return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
	}

	private clampGain(value: number): number {
		return Number.isFinite(value) ? Math.max(0, value) : 1;
	}
}
