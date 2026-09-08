import type { LoopMode, SearchResult, Track } from "../types";
import type { PlayerAction, PlayerActionExecutionContext, PlayerBus } from "../structures/PlayerBus";

export interface QueueControllerOptions {
	bus?: PlayerBus;
}

type QueueInsertRequest = { query: string | Track | Track[]; index?: number; requestedBy?: string };

/** Owns all queue state and queue behavior. There is intentionally no Queue structure behind this controller. */
export class QueueController {
	private readonly bus?: PlayerBus;
	private readonly detachAction?: () => void;
	private readonly detachQueries: Array<() => void> = [];
	private readonly detachRpcs: Array<() => void> = [];

	private tracks: Track[] = [];
	private history: Track[] = [];
	private currentTrack: Track | null = null;
	private willNext: Track | null = null;
	private related: Track[] = [];
	private loopMode: LoopMode = "off";
	private autoPlayEnabled = false;

	public constructor(options: QueueControllerOptions = {}) {
		this.bus = options.bus;
		if (this.bus) {
			this.detachAction = this.bus.onAction((action, context) => this.handleAction(action, context));
			this.detachQueries.push(
				this.bus.registerQuery("currentTrack", () => this.current),
				this.bus.registerQuery("queueCurrent", () => this.current),
				this.bus.registerQuery("queue", () => this.snapshot()),
				this.bus.registerQuery("previousTracks", () => this.previousTracks),
				this.bus.registerQuery("previousTrack", () => this.previousTracks.at(-1) ?? null),
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
				this.bus.registerRpc<QueueInsertRequest, boolean>("queue.insert", (request, context) => this.insertRequest(request, context.signal)),
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
		if (this.loopMode === "track" && this.currentTrack) return this.currentTrack;
		return this.tracks[0] ?? null;
	}
	public get autoPlay(): boolean { return this.autoPlayEnabled; }
	public get loop(): LoopMode { return this.loopMode; }
	public get current(): Track | null { return this.currentTrack; }
	public get previousTracks(): Track[] { return this.history.slice(); }
	public get tracksList(): Track[] { return this.tracks.slice(); }
	public get relatedTracks(): Track[] { return this.related.slice(); }
	public get size(): number { return this.tracks.length; }
	public get isEmpty(): boolean { return this.tracks.length === 0; }

	public add(track: Track): number {
		this.tracks.push(track);
		this.publishChanged();
		return this.tracks.length;
	}
	public addMultiple(tracks: Track[]): number {
		this.tracks.push(...tracks);
		this.publishChanged();
		return this.tracks.length;
	}
	public insert(track: Track, index = 0): number {
		const position = Math.max(0, Math.min(index, this.tracks.length));
		this.tracks.splice(position, 0, track);
		this.publishChanged();
		return this.tracks.length;
	}
	public remove(index: number): Track | null {
		if (index < 0 || index >= this.tracks.length) return null;
		const [track] = this.tracks.splice(index, 1);
		this.publishChanged();
		return track ?? null;
	}
	public next(ignoreLoop = false): Track | null {
		if (!ignoreLoop && this.loopMode === "track" && this.currentTrack) {
			this.publishChanged();
			return this.currentTrack;
		}
		const track = this.tracks.shift() ?? null;
		if (track) {
			if (this.currentTrack) this.history.push(this.currentTrack);
			this.currentTrack = track;
		}
		this.publishChanged();
		return track;
	}
	public restoreNext(previousCurrent: Track | null, nextTrack: Track | null): void {
		if (previousCurrent) {
			const index = this.history.lastIndexOf(previousCurrent);
			if (index >= 0) this.history.splice(index, 1);
		}
		if (nextTrack) this.tracks.unshift(nextTrack);
		this.currentTrack = previousCurrent;
		this.publishChanged();
	}
	public previous(): Track | null {
		const previous = this.history.pop() ?? null;
		if (!previous) return null;
		if (this.currentTrack) this.tracks.unshift(this.currentTrack);
		this.currentTrack = previous;
		this.publishChanged();
		return previous;
	}
	public setLoop(mode: LoopMode): LoopMode {
		this.loopMode = mode;
		this.publishChanged();
		return mode;
	}
	public loop(mode?: LoopMode): LoopMode {
		return mode === undefined ? this.loopMode : this.setLoop(mode);
	}
	public setAutoPlay(enabled: boolean): boolean {
		this.autoPlayEnabled = enabled;
		this.publishChanged();
		return enabled;
	}
	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ? this.autoPlayEnabled : this.setAutoPlay(enabled);
	}
	public shuffle(): void {
		for (let i = this.tracks.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
		}
		this.publishChanged();
	}
	public clear(): void {
		this.tracks.length = 0;
		this.publishChanged();
	}
	public clearHistory(): void {
		this.history.length = 0;
		this.publishChanged();
	}
	public reset(): void {
		this.tracks.length = 0;
		this.history.length = 0;
		this.currentTrack = null;
		this.willNext = null;
		this.related.length = 0;
		this.loopMode = "off";
		this.autoPlayEnabled = false;
		this.publishChanged();
	}
	public snapshot(): Track[] { return this.tracks.slice(); }
	public getTracks(): Track[] { return this.snapshot(); }
	public getTrack(index: number): Track | null { return this.tracks[index] ?? null; }
	public indexOf(track: Track): number { return this.tracks.indexOf(track); }
	public has(track: Track): boolean { return this.tracks.includes(track); }
	public setCurrent(track: Track | null): void { this.currentTrack = track; this.publishChanged(); }
	public setCurrentTrack(track: Track | null): void { this.setCurrent(track); }
	public setWillNext(track: Track | null): void { this.willNext = track; this.publishChanged(); }
	public clearWillNext(): void { this.willNext = null; this.publishChanged(); }
	public willNextTrack(track?: Track): Track | null {
		if (track !== undefined) { this.willNext = track; this.publishChanged(); }
		return this.willNext;
	}
	public setRelated(tracks: Track[]): void { this.related = tracks.slice(); this.publishChanged(); }
	public relatedTracksState(tracks?: Track[]): Track[] {
		if (tracks !== undefined) this.setRelated(tracks);
		return this.relatedTracks;
	}
	public toJSON(): object {
		return {
			tracks: this.tracks,
			history: this.history,
			currentTrack: this.currentTrack,
			willNext: this.willNext,
			relatedTracks: this.related,
			loopMode: this.loopMode,
			autoPlay: this.autoPlayEnabled,
		};
	}
	public fromJSON(state: any): void {
		this.tracks = Array.isArray(state?.tracks) ? state.tracks.slice() : [];
		this.history = Array.isArray(state?.history) ? state.history.slice() : [];
		this.currentTrack = state?.currentTrack ?? null;
		this.willNext = state?.willNext ?? null;
		this.related = Array.isArray(state?.relatedTracks) ? state.relatedTracks.slice() : [];
		this.loopMode = state?.loopMode ?? "off";
		this.autoPlayEnabled = Boolean(state?.autoPlay);
		this.publishChanged();
	}

	private async insertRequest(request: QueueInsertRequest, signal: AbortSignal): Promise<boolean> {
		try {
			if (signal.aborted || !this.bus) return false;
			const tracks = typeof request.query === "string"
				? (await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>("search", {
					query: request.query, requestedBy: request.requestedBy || "Unknown",
				}, { signal })).tracks
				: Array.isArray(request.query) ? request.query : [request.query];
			if (!tracks.length) return false;
			tracks.forEach((track, index) => this.insert(track, (request.index ?? 0) + index));
			return true;
		} catch { return false; }
	}
	private async handleAction(action: PlayerAction, context: PlayerActionExecutionContext): Promise<void> {
		if (context.signal.aborted) return;
		switch (action.type) {
			case "QUEUE_NEXT": this.next(action.ignoreLoop ?? false); return;
			case "QUEUE_SET_CURRENT": this.setCurrent(action.track); return;
		}
	}
	private publishChanged(): void { this.bus?.publish("queueChanged", this.snapshot()); }
	public dispose(): void {
		this.detachAction?.();
		for (const detach of this.detachQueries.splice(0)) detach();
		for (const detach of this.detachRpcs.splice(0)) detach();
		this.reset();
	}
}
