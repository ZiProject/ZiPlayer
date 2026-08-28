import type { LoopMode, Track } from "../types";
import type { PlayerAction, PlayerActionExecutionContext, PlayerBus } from "../structures/PlayerBus";
import { Queue } from "../structures/Queue";

export interface QueueControllerOptions {
	queue?: Queue;
	bus?: PlayerBus;
}

export class QueueController {
	public readonly queue: Queue;
	private readonly bus?: PlayerBus;
	private readonly detachAction?: () => void;
	public constructor(options: QueueControllerOptions = {}) {
		this.queue = options.queue ?? new Queue();
		this.bus = options.bus;
		if (this.bus) this.detachAction = this.bus.onAction((action, context) => this.handleAction(action, context));
	}
	private async handleAction(action: PlayerAction, context: PlayerActionExecutionContext): Promise<void> {
		if (context.signal.aborted) return;
		switch (action.type) {
			case "QUEUE_NEXT":
				this.next(action.ignoreLoop ?? false);
				return;
			case "QUEUE_SET_CURRENT":
				this.setCurrent(action.track);
				return;
		}
	}
	public add(track: Track): number {
		const size = this.queue.add(track);
		this.publishChanged();
		return size;
	}
	public addMultiple(tracks: Track[]): number {
		const size = this.queue.addMultiple(tracks);
		this.publishChanged();
		return size;
	}
	public insert(track: Track, index = 0): number {
		const size = this.queue.insert(track, index);
		this.publishChanged();
		return size;
	}
	public remove(index: number): Track | null {
		const track = this.queue.remove(index);
		if (track) this.publishChanged();
		return track;
	}
	public next(ignoreLoop = false): Track | null {
		const track = this.queue.next(ignoreLoop);
		this.publishChanged();
		return track;
	}
	public previous(): Track | null {
		const track = this.queue.previous();
		this.publishChanged();
		return track;
	}
	public setLoop(mode: LoopMode): LoopMode {
		const value = this.queue.loop(mode);
		this.publishChanged();
		return value;
	}
	public setAutoPlay(enabled: boolean): boolean {
		const value = this.queue.autoPlay(enabled);
		this.publishChanged();
		return value;
	}
	public clear(): void {
		this.queue.clear();
		this.publishChanged();
	}
	public reset(): void {
		this.queue.reset();
		this.publishChanged();
	}
	public snapshot(): Track[] {
		return this.queue.getTracks();
	}
	public get current(): Track | null {
		return this.queue.currentTrack;
	}
	public setCurrent(track: Track | null): void {
		this.queue.setCurrentTrack(track);
		this.publishChanged();
	}
	public get nextTrack(): Track | null {
		return this.queue.nextTrack;
	}
	public get autoPlay(): boolean {
		return this.queue.autoPlay();
	}
	public get loop(): LoopMode {
		return this.queue.loop();
	}
	public get willNext(): Track | null {
		return this.queue.willNextTrack();
	}
	public setWillNext(track: Track | null): void {
		this.queue.willNextTrack(track ?? undefined);
		this.publishChanged();
	}
	public get relatedTracks(): Track[] | null {
		return this.queue.relatedTracks();
	}
	public setRelated(tracks: Track[]): void {
		this.queue.relatedTracks(tracks);
		this.publishChanged();
	}
	public dispose(): void {
		this.detachAction?.();
		this.queue.reset();
	}
	private publishChanged(): void {
		this.bus?.publish("queueChanged", this.snapshot());
	}
}
