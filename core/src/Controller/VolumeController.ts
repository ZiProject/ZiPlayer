import type { AudioResource } from "@discordjs/voice";
import type { PlayerBus } from "../structures/PlayerBus";

export interface VolumeControllerOptions {
	initialVolume?: number;
	loudness?: { enabled?: boolean; target?: number; min?: number; max?: number };
}

/** Owns player volume state and resource-level volume application. */
export class VolumeController {
	private volume: number;
	private readonly loudness: Required<NonNullable<VolumeControllerOptions["loudness"]>>;
	private disposed = false;
	constructor(
		private readonly bus: PlayerBus,
		options: VolumeControllerOptions = {},
	) {
		this.volume = this.clamp(options.initialVolume ?? 100);
		this.loudness = {
			enabled: options.loudness?.enabled ?? false,
			target: options.loudness?.target ?? 1,
			min: options.loudness?.min ?? 0,
			max: options.loudness?.max ?? 2,
		};
	}
	get value(): number {
		return this.volume;
	}
	get settings(): Readonly<typeof this.loudness> {
		return this.loudness;
	}
	setVolume(value: number): number {
		if (this.disposed) return this.volume;
		this.volume = this.clamp(value);
		this.bus.publish("volumeChanged", this.volume);
		return this.volume;
	}
	apply(resource: AudioResource | null, gain = 1): void {
		if (!resource?.volume) return;
		const normalized = this.clampGain(gain);
		resource.volume.setVolume((this.volume / 100) * normalized);
	}
	applyLoudness(resource: AudioResource | null, measuredGain?: number): void {
		if (!this.loudness.enabled) {
			this.apply(resource);
			return;
		}
		const correction = measuredGain && measuredGain > 0 ? this.loudness.target / measuredGain : 1;
		this.apply(resource, correction);
	}
	dispose(): void {
		this.disposed = true;
	}
	private clamp(value: number): number {
		return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
	}
	private clampGain(value: number): number {
		return Math.min(this.loudness.max, Math.max(this.loudness.min, Number.isFinite(value) ? value : 1));
	}
}
