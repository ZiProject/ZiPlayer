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

	public add(track: Track): number {
		const size = this.queue.add(track);
		this.bus?.publish("queueChanged", this.snapshot());
		return size;
	}

	public addMultiple(tracks: Track[]): number {
		const size = this.queue.addMultiple(tracks);
		this.bus?.publish("queueChanged", this.snapshot());
		return size;
	}

	public insert(track: Track, index = 0): number {
		const size = this.queue.insert(track, index);
		this.bus?.publish("queueChanged", this.snapshot());
		return size;
	}

	public remove(index: number): Track | null {
		const track = this.queue.remove(index);
		if (track) this.bus?.publish("queueChanged", this.snapshot());
		return track;
	}

	public next(ignoreLoop = false): Track | null {
		const track = this.queue.next(ignoreLoop);
		this.bus?.publish("queueChanged", this.snapshot());
		return track;
	}

	public previous(): Track | null {
		const track = this.queue.previous();
		this.bus?.publish("queueChanged", this.snapshot());
		return track;
	}

	public setLoop(mode: LoopMode): LoopMode {
		const value = this.queue.loop(mode);
		this.bus?.publish("queueChanged", this.snapshot());
		return value;
	}

	public setAutoPlay(enabled: boolean): boolean {
		const value = this.queue.autoPlay(enabled);
		this.bus?.publish("queueChanged", this.snapshot());
		return value;
	}

	public clear(): void {
		this.queue.clear();
		this.bus?.publish("queueChanged", this.snapshot());
	}

	public reset(): void {
		this.queue.reset();
		this.bus?.publish("queueChanged", this.snapshot());
	}

	public snapshot(): Track[] {
		const tracks: Track[] = [];
		for (let index = 0; index < this.queue.size; index++) {
			const track = this.queue.get(index);
			if (track) tracks.push(track);
		}
		return tracks;
	}

	public dispose(): void {
		this.queue.reset();
	}
}
