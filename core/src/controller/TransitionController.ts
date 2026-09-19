import type { Track } from "../types";
import type { GlobalPlayerBus } from "../structures/PlayerBus";
import { CONTROLLER_RPC, type TransitionBeatWaitRequest, type TransitionPlanRequest } from "./ControllerBusContract";
import type { TransitionControllerOptions, TransitionPlan } from "../types";

type ResolvedOptions = Required<Omit<TransitionControllerOptions, "genreDurations" | "bus">> & {
	genreDurations: Record<string, number>;
};

/** Shared, singleton controller: owns per-player transition (crossfade) settings, keyed by playerId. */
export class TransitionController {
	private readonly states = new Map<string, ResolvedOptions>();

	public constructor(bus?: GlobalPlayerBus) {
		if (bus) {
			bus.registerQuery("transitionSettings", (playerId) => (this.states.get(playerId) ?? {}) as Record<string, unknown>);
			bus.registerRpc<TransitionPlanRequest, TransitionPlan>(CONTROLLER_RPC.transitionPlan, ({ from, to }, ctx) =>
				this.plan(ctx.playerId, from, to),
			);
			bus.registerRpc<TransitionBeatWaitRequest, number>(CONTROLLER_RPC.transitionBeatWait, ({ track, positionMs }, ctx) =>
				this.beatWaitMs(ctx.playerId, track, positionMs),
			);
		}
	}

	public attach(playerId: string, options: TransitionControllerOptions = {}): void {
		const minDurationMs = Math.max(0, options.minDurationMs ?? 120);
		this.states.set(playerId, {
			enabled: options.enabled ?? true,
			durationMs: Math.max(0, options.durationMs ?? 5000),
			smartEnabled: options.smartEnabled ?? true,
			genreAware: options.genreAware ?? true,
			beatAlign: options.beatAlign ?? true,
			baseDurationMs: Math.max(0, options.baseDurationMs ?? options.durationMs ?? 5000),
			minDurationMs,
			maxDurationMs: Math.max(minDurationMs, options.maxDurationMs ?? 8000),
			beatAlignMaxWaitMs: Math.max(0, options.beatAlignMaxWaitMs ?? 180),
			genreDurations: {
				chill: 700,
				ambient: 750,
				lofi: 650,
				pop: 450,
				rock: 350,
				edm: 220,
				house: 250,
				techno: 200,
				...(options.genreDurations ?? {}),
			},
		});
	}
	public detach(playerId: string): void {
		this.states.delete(playerId);
	}

	public plan(playerId: string, from: Track | null, to: Track | null): TransitionPlan {
		const options = this.states.get(playerId);
		if (!options?.enabled || !from || !to) return { enabled: false, durationMs: 0, waitForBeat: false, beatAlignMaxWaitMs: 0 };
		let duration = options.smartEnabled ? options.baseDurationMs : options.durationMs;
		if (options.genreAware) {
			const genre = this.genreOf(to) ?? this.genreOf(from);
			if (genre) duration = options.genreDurations[genre] ?? duration;
		}
		duration = Math.min(options.maxDurationMs, Math.max(options.minDurationMs, duration));
		return {
			enabled: duration > 0,
			durationMs: duration,
			waitForBeat: options.smartEnabled && options.beatAlign,
			beatAlignMaxWaitMs: options.beatAlignMaxWaitMs,
		};
	}
	public beatWaitMs(playerId: string, track: Track | null, positionMs: number): number {
		const options = this.states.get(playerId);
		if (!track || !options?.smartEnabled || !options.beatAlign) return 0;
		const bpmRaw = (track as Track & { metadata?: Record<string, unknown> }).metadata?.bpm;
		const bpm = typeof bpmRaw === "number" ? bpmRaw : Number(bpmRaw);
		if (!Number.isFinite(bpm) || bpm <= 0) return 0;
		const beatMs = 60000 / bpm;
		const remainder = Math.max(0, positionMs) % beatMs;
		const waitMs = beatMs - remainder;
		return waitMs > 0 && waitMs <= options.beatAlignMaxWaitMs ? waitMs : 0;
	}
	public settings(playerId: string): Readonly<ResolvedOptions> | undefined {
		return this.states.get(playerId);
	}
	public enabled(playerId: string): boolean {
		return this.states.get(playerId)?.enabled ?? false;
	}
	public dispose(): void {
		this.states.clear();
	}
	private genreOf(track: Track): string | null {
		const metadata = (track as Track & { metadata?: Record<string, unknown> }).metadata;
		const value = metadata?.genre;
		return typeof value === "string" ? value.toLowerCase().trim() : null;
	}
}
