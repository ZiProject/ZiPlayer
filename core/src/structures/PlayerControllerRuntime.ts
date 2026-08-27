import type { AudioResource } from "@discordjs/voice";
import type { Track } from "../types";
import type { QueueController } from "../Controller/QueueController";
import type { PreloadController } from "../Controller/PreloadController";
import type { TransitionController } from "../Controller/TransitionController";
import type { AntiStuckController } from "../Controller/AntiStuckController";

export interface PlayerControllerRuntimeHost {
	readonly destroyed: boolean;
	readonly currentResource: AudioResource | null;
	readonly volume: number;
	readonly options: { quality?: string };
	readonly playbackMode: string;
	readonly crossfadeEnabled: boolean;
	readonly queueController: QueueController;
	readonly preloadController: PreloadController;
	readonly transitionController: TransitionController;
	readonly antiStuckController: AntiStuckController;
	startTrack(track: Track): Promise<boolean>;
	loadFreshStream(track: Track): Promise<boolean>;
	stopAudio(): void;
	insertTrack(track: Track, index: number): void;
	clearCurrentPlayback(): void;
}

export class PlayerControllerRuntime {
	public constructor(private readonly host: PlayerControllerRuntimeHost) {}
	public async preloadNext(): Promise<void> {
		if (this.host.destroyed) return;
		await this.host.preloadController.preload();
	}
	public cancelPreload(): void {
		this.host.preloadController.cancel();
	}
	public transitionDuration(from: Track | null, to: Track | null): number {
		return this.host.transitionController.plan(from, to).durationMs;
	}
	public async waitForBeat(track: Track | null, positionMs: number, signal?: AbortSignal): Promise<void> {
		const waitMs = this.host.transitionController.beatWaitMs(track, positionMs);
		if (waitMs <= 0) return;
		await new Promise<void>((resolve) => {
			if (signal?.aborted) return resolve();
			const timer = setTimeout(resolve, waitMs);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}
	public async recover(track: Track, signal: AbortSignal, reason: unknown): Promise<boolean> {
		if (this.host.destroyed) return false;
		const originalQuality = this.host.options.quality;
		try {
			return await this.host.antiStuckController.recoverTrack(track, signal, reason, {
				retry: async ({ retry, signal: retrySignal }) => {
					if (this.host.destroyed || retrySignal.aborted) return false;
					if (this.host.antiStuckController.policy.reduceQualityOnRetry) this.host.options.quality = "low";
					try {
						if (this.host.antiStuckController.policy.reusePreloadFirst && this.host.preloadController.has(track)) {
							if (await this.host.startTrack(track)) return true;
						}
						return await this.host.loadFreshStream(track);
					} finally {
						if (retry === this.host.antiStuckController.policy.maxRetries) this.host.options.quality = originalQuality;
					}
				},
			});
		} finally {
			this.host.options.quality = originalQuality;
		}
	}
	public async playNext(skipLoop = false): Promise<boolean> {
		if (this.host.destroyed) return false;
		while (!this.host.destroyed) {
			const track = this.host.queueController.next(skipLoop);
			skipLoop = false;
			if (!track) {
				if (this.host.queueController.autoPlay && this.host.queueController.willNext) {
					this.host.queueController.add(this.host.queueController.willNext);
					continue;
				}
				this.host.clearCurrentPlayback();
				return false;
			}
			try {
				if (await this.host.startTrack(track)) return true;
				if (this.host.playbackMode === "remote") continue;
				const recovered = await this.recover(track, new AbortController().signal, "TRACK_START_RETURNED_FALSE");
				if (recovered) return true;
				const failures = this.host.antiStuckController.getRetryCount(track);
				if (
					this.host.antiStuckController.policy.enabled &&
					failures < this.host.antiStuckController.policy.controlledSkipThreshold
				)
					this.host.insertTrack(track, 0);
				else continue;
			} catch (error) {
				const recovered = await this.recover(track, new AbortController().signal, error);
				if (recovered) return true;
				const failures = this.host.antiStuckController.getRetryCount(track);
				if (failures < this.host.antiStuckController.policy.controlledSkipThreshold) this.host.insertTrack(track, 0);
			}
		}
		return false;
	}
}
