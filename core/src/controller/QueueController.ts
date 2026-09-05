import type { LoopMode, SearchResult, Track } from "../types";
import type { PlayerAction, PlayerActionExecutionContext, PlayerBus } from "../structures/PlayerBus";
import { Queue } from "../structures/Queue";

export interface QueueControllerOptions {
	queue?: Queue;
	bus?: PlayerBus;
}

type QueueInsertRequest = { query: string | Track | Track[]; index?: number; requestedBy?: string };

export class QueueController {
	public readonly queue: Queue;
	private readonly bus?: PlayerBus;
	private readonly detachAction?: () => void;
	private readonly detachQueries: Array<() => void> = [];
	private readonly detachRpcs: Array<() => void> = [];

	public constructor(options: QueueControllerOptions = {}) {
		this.queue = options.queue ?? new Queue();
		this.bus = options.bus;
		if (this.bus) {
			this.detachAction = this.bus.onAction((action, context) => this.handleAction(action, context));
			this.detachQueries.push(
				this.bus.registerQuery("currentTrack", () => this.current),
				this.bus.registerQuery("queueCurrent", () => this.current),
				this.bus.registerQuery("queue", () => this.snapshot()),
				this.bus.registerQuery("previousTracks", () => this.queue.previousTracks ?? []),
				this.bus.registerQuery("previousTrack", () => this.queue.previousTracks?.at?.(-1) ?? null),
				this.bus.registerQuery("willNext", () => this.willNext),
				this.bus.registerQuery("queueLoop", () => this.loop),
				this.bus.registerQuery("queueAutoPlay", () => this.autoPlay),
				this.bus.registerQuery("relatedTracks", () => this.relatedTracks),
			);
			this.detachRpcs.push(
				this.bus.registerRpc<void, Track | null>("queue.previous", () => this.previous()),
				this.bus.registerRpc<void, void>("queue.shuffle", () => this.shuffle()),
				this.bus.registerRpc<void, void>("queue.clear", () => this.clear()),
				this.bus.registerRpc<{ tracks: Track[] }, number>("queue.addMultiple", ({ tracks }) => this.addMultiple(tracks)),
				this.bus.registerRpc<QueueInsertRequest, boolean>("queue.insert", (request, context) =>
					this.insertRequest(request, context.signal),
				),
				this.bus.registerRpc<{ index: number }, Track | null>("queue.remove", ({ index }) => this.remove(index)),
				this.bus.registerRpc<{ mode: LoopMode }, LoopMode>("queue.loop", ({ mode }) => this.setLoop(mode)),
				this.bus.registerRpc<{ enabled: boolean }, boolean>("queue.autoPlay", ({ enabled }) => this.setAutoPlay(enabled)),
				this.bus.registerRpc<{ track: Track | null }, Track | null>("queue.willNext", ({ track }) => {
					if (track) this.setWillNext(track);
					else this.clearWillNext();
					return this.willNext;
				}),
			);
		}
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
	public get tracks(): Track[] {
		return this.queue.getTracks();
	}
	public get relatedTracks(): Track[] {
		return this.queue.relatedTracks();
	}

	private async insertRequest(request: QueueInsertRequest, signal: AbortSignal): Promise<boolean> {
		try {
			if (signal.aborted || !this.bus) return false;
			const tracks =
				typeof request.query === "string" ?
					(
						await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>(
							"search",
							{
								query: request.query,
								requestedBy: request.requestedBy || "Unknown",
							},
							{ signal },
						)
					).tracks
				: Array.isArray(request.query) ? request.query
				: [request.query];
			if (tracks.length === 0) return false;
			for (let index = 0; index < tracks.length; index++) this.insert(tracks[index], (request.index ?? 0) + index);
			return true;
		} catch {
			return false;
		}
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

	public restoreNext(previousCurrent: Track | null, nextTrack: Track | null): void {
		this.queue.restoreNext(previousCurrent, nextTrack);
		this.publishChanged();
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

	public shuffle(): void {
		this.queue.shuffle();
		this.publishChanged();
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

	public setCurrent(track: Track | null): void {
		this.queue.setCurrentTrack(track);
		this.publishChanged();
	}

	public get current(): Track | null {
		return this.queue.currentTrack;
	}

	public setWillNext(track: Track | null): void {
		if (track) this.queue.willNextTrack(track);
		this.publishChanged();
	}

	public clearWillNext(): void {
		this.queue.clearWillNext();
		this.publishChanged();
	}

	public setRelated(tracks: Track[]): void {
		this.queue.relatedTracks(tracks);
		this.publishChanged();
	}

	public dispose(): void {
		this.detachAction?.();
		for (const detach of this.detachQueries.splice(0)) detach();
		for (const detach of this.detachRpcs.splice(0)) detach();
		this.queue.reset();
	}

	private publishChanged(): void {
		this.bus?.publish("queueChanged", this.snapshot());
	}
}