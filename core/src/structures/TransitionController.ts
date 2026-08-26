import type { Track } from "../types";

export interface TransitionControllerOptions {
	enabled?: boolean;
	durationMs?: number;
	smartEnabled?: boolean;
	genreAware?: boolean;
	beatAlign?: boolean;
	baseDurationMs?: number;
	minDurationMs?: number;
	maxDurationMs?: number;
	beatAlignMaxWaitMs?: number;
	genreDurations?: Record<string, number>;
}

export interface TransitionPlan {
	enabled: boolean;
	durationMs: number;
	waitForBeat: boolean;
	beatAlignMaxWaitMs: number;
}

/** Pure transition policy. Actual audio crossfade belongs to PlaybackController. */
export class TransitionController {
	private readonly options: Required<Omit<TransitionControllerOptions, "genreDurations">> & { genreDurations: Record<string, number> };

	public constructor(options: TransitionControllerOptions = {}) {
		const minDurationMs = Math.max(0, options.minDurationMs ?? 120);
		this.options = {
			enabled: options.enabled ?? true,
			durationMs: Math.max(0, options.durationMs ?? 500),
			smartEnabled: options.smartEnabled ?? true,
			genreAware: options.genreAware ?? true,
			beatAlign: options.beatAlign ?? true,
			baseDurationMs: Math.max(0, options.baseDurationMs ?? options.durationMs ?? 500),
			minDurationMs,
			maxDurationMs: Math.max(minDurationMs, options.maxDurationMs ?? 8000),
			beatAlignMaxWaitMs: Math.max(0, options.beatAlignMaxWaitMs ?? 180),
			genreDurations: { chill: 700, ambient: 750, lofi: 650, pop: 450, rock: 350, edm: 220, house: 250, techno: 200, ...(options.genreDurations ?? {}) },
		};
	}

	public plan(from: Track | null, to: Track | null): TransitionPlan {
		if (!this.options.enabled || !from || !to) return { enabled: false, durationMs: 0, waitForBeat: false, beatAlignMaxWaitMs: 0 };
		let duration = this.options.smartEnabled ? this.options.baseDurationMs : this.options.durationMs;
		if (this.options.genreAware) {
			const genre = this.genreOf(to) ?? this.genreOf(from);
			if (genre) duration = this.options.genreDurations[genre] ?? duration;
		}
		duration = Math.min(this.options.maxDurationMs, Math.max(this.options.minDurationMs, duration));
		return { enabled: duration > 0, durationMs: duration, waitForBeat: this.options.smartEnabled && this.options.beatAlign, beatAlignMaxWaitMs: this.options.beatAlignMaxWaitMs };
	}

	public beatWaitMs(track: Track | null, positionMs: number): number {
		if (!track || !this.options.smartEnabled || !this.options.beatAlign) return 0;
		const bpmRaw = (track as Track & { metadata?: Record<string, unknown> }).metadata?.bpm;
		const bpm = typeof bpmRaw === "number" ? bpmRaw : Number(bpmRaw);
		if (!Number.isFinite(bpm) || bpm <= 0) return 0;
		const beatMs = 60000 / bpm;
		const remainder = Math.max(0, positionMs) % beatMs;
		const waitMs = beatMs - remainder;
		return waitMs > 0 && waitMs <= this.options.beatAlignMaxWaitMs ? waitMs : 0;
	}

	public get settings(): Readonly<typeof this.options> { return this.options; }

	private genreOf(track: Track): string | null {
		const metadata = (track as Track & { metadata?: Record<string, unknown> }).metadata;
		const value = metadata?.genre;
		return typeof value === "string" ? value.toLowerCase().trim() : null;
	}
}
