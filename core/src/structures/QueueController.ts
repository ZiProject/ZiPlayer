import type { LoopMode, Track } from "../types";
import type { PlayerBus } from "./PlayerBus";
import { Queue } from "./Queue";

export interface QueueControllerOptions {
	queue?: Queue;
	bus?: PlayerBus;
}

/** Owns queue policy while Queue remains the data structure/public API. */
export class QueueController {
	public readonly queue: Queue;
	private readonly bus?: PlayerBus;

	public constructor(options: QueueControllerOptions = {}) {
		this.queue = options.queue ?? new Queue();
		this.bus = options.bus;
	}

	public add(track: Track): number { const size = this.queue.add(track); this.publishChanged(); return size; }
	public addMultiple(tracks: Track[]): number { const size = this.queue.addMultiple(tracks); this.publishChanged(); return size; }
	public insert(track: Track, index = 0): number { const size = this.queue.insert(track, index); this.publishChanged(); return size; }
	public remove(index: number): Track | null { const track = this.queue.remove(index); if (track) this.publishChanged(); return track; }
	public next(ignoreLoop = false): Track | null { const track = this.queue.next(ignoreLoop); this.publishChanged(); return track; }
	public previous(): Track | null { const track = this.queue.previous(); this.publishChanged(); return track; }
	public setLoop(mode: LoopMode): LoopMode { const value = this.queue.loop(mode); this.publishChanged(); return value; }
	public setAutoPlay(enabled: boolean): boolean { const value = this.queue.autoPlay(enabled); this.publishChanged(); return value; }
	public clear(): void { this.queue.clear(); this.publishChanged(); }
	public reset(): void { this.queue.reset(); this.publishChanged(); }
	public snapshot(): Track[] { return this.queue.getTracks(); }
	public dispose(): void { this.queue.reset(); }

	private publishChanged(): void {
		this.bus?.publish("queueChanged", this.snapshot());
	}
}
