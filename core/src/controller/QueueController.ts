import type { LoopMode, SearchResult, Track } from "../types";
import type { Bus, PlayerAction, PlayerActionExecutionContext } from "../structures/Bus";
import type { QueueControllerOptions } from "../types";
import { PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

type QueueInsertRequest = { query: string | Track | Track[]; index?: number; requestedBy?: string };

/** Per-player queue state and operations, owned by the shared `QueueController`
 *  below. Talks to the bus only to publish "queueChanged" and to loop back through
 *  its own registered RPCs (setCurrent/serialize/restore) for API symmetry with the
 *  bus-less constructor used in a few standalone tests. */
export class QueueState {
	private readonly bus?: Bus;
	private readonly playerId?: string;
	private readonly MAX_HISTORY_SIZE = 200;
	private readonly MAX_QUEUE_SIZE = 1000;

	public tracks: Track[] = [];
	public history: Track[] = [];
	public currentTrack: Track | null = null;
	public willNext: Track | null = null;
	public related: Track[] = [];
	public loopMode: LoopMode = "off";
	private autoPlayEnabled = false;

	public constructor(bus?: Bus, playerId?: string) {
		this.bus = bus;
		this.playerId = playerId;
	}

	public get nextTrack(): Track | null {
		if (this.loopMode === "track" && this.currentTrack) return this.currentTrack;
		return this.tracks[0] ?? null;
	}
	public get current(): Track | null {
		return this.currentTrack;
	}
	public get previousTracks(): Track[] {
		return this.history.slice();
	}
	public get previousTracksCount(): number {
		return this.history.length;
	}
	public get tracksList(): Track[] {
		return this.tracks.slice();
	}
	public get relatedTracks(): Track[] {
		return this.related.slice();
	}
	public get size(): number {
		return this.tracks.length;
	}
	public get isEmpty(): boolean {
		return this.tracks.length === 0;
	}
	public get lastTrack(): Track | null {
		return this.tracks.at(-1) ?? null;
	}

	public add(track: Track): number {
		if (this.tracks.length >= this.MAX_QUEUE_SIZE) throw new Error(`Queue size limit reached (${this.MAX_QUEUE_SIZE})`);
		this.tracks.push(track);
		this.publishChanged();
		return this.tracks.length;
	}
	public addMultiple(tracks: Track[]): number {
		if (this.tracks.length + tracks.length > this.MAX_QUEUE_SIZE)
			throw new Error(`Adding ${tracks.length} tracks would exceed queue size limit (${this.MAX_QUEUE_SIZE})`);
		this.tracks.push(...tracks);
		this.publishChanged();
		return this.tracks.length;
	}
	public insert(track: Track, index = this.tracks.length): number {
		if (this.tracks.length >= this.MAX_QUEUE_SIZE) throw new Error(`Queue size limit reached (${this.MAX_QUEUE_SIZE})`);
		const position = Number.isFinite(index) ? Math.max(0, Math.min(Math.floor(index), this.tracks.length)) : this.tracks.length;
		this.tracks.splice(position, 0, track);
		this.publishChanged();
		return this.tracks.length;
	}
	public insertMultiple(tracks: Track[], index = this.tracks.length): number {
		if (!Array.isArray(tracks) || tracks.length === 0) return this.tracks.length;
		if (this.tracks.length + tracks.length > this.MAX_QUEUE_SIZE)
			throw new Error(`Inserting ${tracks.length} tracks would exceed queue size limit (${this.MAX_QUEUE_SIZE})`);
		const position = Number.isFinite(index) ? Math.max(0, Math.min(Math.floor(index), this.tracks.length)) : this.tracks.length;
		this.tracks.splice(position, 0, ...tracks);
		this.publishChanged();
		return this.tracks.length;
	}
	public remove(index: number): Track | null {
		if (index < 0 || index >= this.tracks.length) return null;
		const [track] = this.tracks.splice(index, 1);
		this.publishChanged();
		return track ?? null;
	}
	public removeMultiple(indices: number[]): Track[] {
		const sorted = [...new Set(indices)].sort((a, b) => b - a);
		const removed: Track[] = [];
		for (const index of sorted) {
			if (index >= 0 && index < this.tracks.length) {
				const [track] = this.tracks.splice(index, 1);
				if (track) removed.unshift(track);
			}
		}
		if (removed.length) this.publishChanged();
		return removed;
	}
	public removeWhere(predicate: (track: Track, index: number) => boolean): Track[] {
		const removed: Track[] = [];
		for (let i = this.tracks.length - 1; i >= 0; i--) {
			if (predicate(this.tracks[i], i)) {
				const [track] = this.tracks.splice(i, 1);
				if (track) removed.unshift(track);
			}
		}
		if (removed.length) this.publishChanged();
		return removed;
	}
	public next(ignoreLoop = false): Track | null {
		if (this.currentTrack && this.loopMode === "track" && !ignoreLoop) {
			this.publishChanged();
			return this.currentTrack;
		}
		const current = this.currentTrack;
		if (current) {
			this.history.push(current);
			if (this.history.length > this.MAX_HISTORY_SIZE) {
				this.history.shift();
			}
		}
		let next = this.tracks.shift() ?? null;
		if (!next && this.loopMode === "queue" && !ignoreLoop) {
			next = this.history.shift() ?? null;
		}
		if (!next && this.loopMode === "track" && ignoreLoop) {
			this.currentTrack = null;
			this.publishChanged();
			return null;
		}
		this.currentTrack = next;
		this.publishChanged();
		return next;
	}
	public restoreNext(previousCurrent: Track | null, nextTrack: Track | null): void {
		if (this.currentTrack === previousCurrent) return;
		if (this.currentTrack !== nextTrack) return;
		if (nextTrack) this.tracks.unshift(nextTrack);
		this.currentTrack = previousCurrent;
		if (previousCurrent && this.history.at(-1) === previousCurrent) this.history.pop();
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
	public jumpToHistory(stepsBack: number): Track | null {
		if (stepsBack <= 0 || stepsBack > this.history.length) return null;
		const targetIndex = this.history.length - stepsBack;
		if (this.currentTrack) this.tracks.unshift(this.currentTrack);
		const tracksAfterTarget = this.history.splice(targetIndex + 1);
		this.currentTrack = this.history.pop() ?? null;
		for (let i = tracksAfterTarget.length - 1; i >= 0; i--) this.tracks.unshift(tracksAfterTarget[i]);
		this.publishChanged();
		return this.currentTrack;
	}
	public setLoop(mode: LoopMode): LoopMode {
		if (mode !== this.loopMode) {
			this.loopMode = mode;
			this.willNext = null;
			this.publishChanged();
		}
		return this.loopMode;
	}
	public loop(mode?: LoopMode): LoopMode {
		return mode === undefined ? this.loopMode : this.setLoop(mode);
	}
	public isLooping(): boolean {
		return this.loopMode !== "off";
	}
	public getLoopMode(): LoopMode {
		return this.loopMode;
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
	public move(fromIndex: number, toIndex: number): boolean {
		if (fromIndex < 0 || fromIndex >= this.tracks.length || toIndex < 0 || toIndex >= this.tracks.length) return false;
		if (fromIndex === toIndex) return true;
		const [track] = this.tracks.splice(fromIndex, 1);
		this.tracks.splice(toIndex, 0, track);
		this.publishChanged();
		return true;
	}
	public swap(indexA: number, indexB: number): boolean {
		if (indexA < 0 || indexA >= this.tracks.length || indexB < 0 || indexB >= this.tracks.length) return false;
		if (indexA === indexB) return true;
		[this.tracks[indexA], this.tracks[indexB]] = [this.tracks[indexB], this.tracks[indexA]];
		this.publishChanged();
		return true;
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
		this.clearState();
		this.publishChanged();
	}
	private clearState(): void {
		this.tracks.length = 0;
		this.history.length = 0;
		this.currentTrack = null;
		this.willNext = null;
		this.related.length = 0;
		this.loopMode = "off";
		this.autoPlayEnabled = false;
	}
	public snapshot(): Track[] {
		return this.tracks.slice();
	}
	public getTracks(): Track[] {
		return this.snapshot();
	}
	public getTrack(index: number): Track | null {
		return this.tracks[index] ?? null;
	}
	public findTracks(predicate: (track: Track) => boolean): Track[] {
		return this.tracks.filter(predicate);
	}
	public indexOf(identifier: string | Track): number {
		if (typeof identifier === "string")
			return this.tracks.findIndex((track) => track.id === identifier || track.url === identifier);
		return this.tracks.findIndex(
			(track) =>
				(track.id !== undefined && identifier.id !== undefined && track.id === identifier.id) ||
				(track.url !== undefined && identifier.url !== undefined && track.url === identifier.url),
		);
	}
	public has(identifier: string | Track): boolean {
		return this.indexOf(identifier) !== -1;
	}
	public setCurrent(track: Track | null): void {
		if (this.bus) {
			this.bus.requestRpcSync(this.playerId!, PLAYER_RPC.queueSetCurrent, { track });
			return;
		}
		this.setCurrentInternal(track);
	}
	public setCurrentTrack(track: Track | null): void {
		this.setCurrent(track);
	}
	public setWillNext(track: Track | null): void {
		this.willNext = track;
		this.publishChanged();
	}
	public clearWillNext(): void {
		this.willNext = null;
		this.publishChanged();
	}
	public willNextTrack(track?: Track): Track | null {
		if (track !== undefined) {
			this.willNext = track;
			this.publishChanged();
		}
		return this.willNext;
	}
	public setRelated(tracks: Track[]): void {
		this.related = tracks.slice();
		this.publishChanged();
	}
	public relatedTracksState(tracks?: Track[]): Track[] {
		if (tracks !== undefined) this.setRelated(tracks);
		return this.relatedTracks;
	}
	public toJSON(): object {
		return this.bus ? this.bus.requestRpcSync(this.playerId!, PLAYER_RPC.queueSerialize, undefined) : this.serializeInternal();
	}
	public fromJSON(state: any): void {
		if (this.bus) {
			this.bus.requestRpcSync(this.playerId!, PLAYER_RPC.queueRestore, { state });
			return;
		}
		this.restoreInternal(state);
	}

	public setCurrentInternal(track: Track | null): void {
		this.currentTrack = track;
		this.publishChanged();
	}
	public serializeInternal(): object {
		return {
			tracks: this.tracks,
			current: this.currentTrack,
			history: this.history,
			size: this.size,
			loopMode: this.loopMode,
			autoPlay: this.autoPlayEnabled,
			willNext: this.willNext,
			relatedTracks: this.related,
		};
	}
	public restoreInternal(state: any): void {
		if (!state || typeof state !== "object") throw new TypeError("Invalid queue state");
		const tracks =
			Array.isArray(state.tracks) ?
				state.tracks.filter((track: unknown): track is Track => !!track && typeof track === "object")
			:	[];
		const history =
			Array.isArray(state.history) ?
				state.history.filter((track: unknown): track is Track => !!track && typeof track === "object")
			:	[];
		this.tracks = tracks.slice(0, this.MAX_QUEUE_SIZE);
		this.history = history.slice(-this.MAX_HISTORY_SIZE);
		this.currentTrack =
			state.current && typeof state.current === "object" ? state.current
			: state.currentTrack && typeof state.currentTrack === "object" ? state.currentTrack
			: null;
		this.willNext = state.willNext && typeof state.willNext === "object" ? state.willNext : null;
		this.related =
			Array.isArray(state.relatedTracks) ?
				state.relatedTracks
					.filter((track: unknown): track is Track => !!track && typeof track === "object")
					.slice(0, this.MAX_QUEUE_SIZE)
			:	[];
		this.loopMode = state.loopMode === "off" || state.loopMode === "track" || state.loopMode === "queue" ? state.loopMode : "off";
		this.autoPlayEnabled = state.autoPlay === true;
		this.publishChanged();
	}

	public async insertRequest(request: QueueInsertRequest, signal: AbortSignal): Promise<boolean> {
		try {
			if (signal.aborted || !this.bus) return false;
			const tracks =
				typeof request.query === "string" ?
					(
						await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>(this.playerId!, PLAYER_RPC.search, {
							query: request.query,
							requestedBy: request.requestedBy || "Unknown",
						})
					).tracks
				: Array.isArray(request.query) ? request.query
				: [request.query];
			if (!tracks.length) return false;
			tracks.forEach((track, index) => this.insert(track, (request.index ?? this.tracks.length) + index));
			return true;
		} catch {
			return false;
		}
	}
	public async handleAction(action: PlayerAction, context: PlayerActionExecutionContext): Promise<void> {
		if (context.signal.aborted) return;
		switch (action.type) {
			case "QUEUE_NEXT":
				this.next(action.ignoreLoop ?? false);
				return;
			case "QUEUE_SET_CURRENT":
				this.setCurrentInternal(action.track);
				return;
		}
	}
	private publishChanged(): void {
		if (this.bus && this.playerId) this.bus.publish(this.playerId, "queueChanged", this.snapshot());
	}
	/** Releases the state without publishing: subscribers of a player that is being torn down must not see a final "queueChanged". */
	public dispose(): void {
		this.clearState();
	}
}

/**
 * What `Player.queue` exposes: the queue operations of `QueueState` without the members that only
 * `QueueController` (bus actions/RPCs, lifecycle) should call.
 */
export type PlayerQueue = Omit<
	QueueState,
	"dispose" | "handleAction" | "insertRequest" | "setCurrentInternal" | "serializeInternal" | "restoreInternal"
>;

/** Shared, singleton controller: owns queue state for every player, keyed by playerId. */
export class QueueController {
	private readonly states = new Map<string, QueueState>();

	public constructor(private readonly bus: Bus) {
		bus.onAction((action, context) => {
			void this.states.get(context.playerId)?.handleAction(action, context);
		});
		bus.registerQuery(PLAYER_QUERY.currentTrack, (playerId) => this.states.get(playerId)?.current ?? null);
		bus.registerQuery(PLAYER_QUERY.queueCurrent, (playerId) => this.states.get(playerId)?.current ?? null);
		bus.registerQuery(PLAYER_QUERY.queue, (playerId) => this.states.get(playerId)?.snapshot() ?? []);
		bus.registerQuery(PLAYER_QUERY.queueState, (playerId) => this.states.get(playerId) ?? null);
		bus.registerQuery(PLAYER_QUERY.queueSerialized, (playerId) => this.states.get(playerId)?.serializeInternal() ?? {});
		bus.registerQuery(PLAYER_QUERY.previousTracks, (playerId) => this.states.get(playerId)?.previousTracks ?? []);
		bus.registerQuery(PLAYER_QUERY.previousTrack, (playerId) => this.states.get(playerId)?.previousTracks.at(-1) ?? null);
		bus.registerQuery(PLAYER_QUERY.willNext, (playerId) => this.states.get(playerId)?.willNext ?? null);
		bus.registerQuery(PLAYER_QUERY.queueLoop, (playerId) => this.states.get(playerId)?.loopMode ?? "off");
		bus.registerQuery(PLAYER_QUERY.queueAutoPlay, (playerId) => this.states.get(playerId)?.autoPlay() ?? false);
		bus.registerQuery(PLAYER_QUERY.relatedTracks, (playerId) => this.states.get(playerId)?.relatedTracks ?? []);
		bus.registerQuery(PLAYER_QUERY.queueNextTrack, (playerId) => this.states.get(playerId)?.nextTrack ?? null);

		const state = (playerId: string): QueueState => {
			const found = this.states.get(playerId);
			if (!found) throw new Error("QueueController is disposed");
			return found;
		};
		bus.registerRpc<{ track: Track }, number>(PLAYER_RPC.queueAdd, ({ track }, ctx) => state(ctx.playerId).add(track));
		bus.registerRpc<void, Track | null>(PLAYER_RPC.queuePrevious, (_req, ctx) => state(ctx.playerId).previous());
		bus.registerRpc<void, void>(PLAYER_RPC.queueShuffle, (_req, ctx) => state(ctx.playerId).shuffle());
		bus.registerRpc<void, void>(PLAYER_RPC.queueClear, (_req, ctx) => state(ctx.playerId).clear());
		bus.registerRpc<{ tracks: Track[] }, number>(PLAYER_RPC.queueAddMultiple, ({ tracks }, ctx) =>
			state(ctx.playerId).addMultiple(tracks),
		);
		bus.registerRpc<QueueInsertRequest, boolean>(PLAYER_RPC.queueInsert, (request, ctx) =>
			state(ctx.playerId).insertRequest(request, ctx.signal),
		);
		bus.registerRpc<{ index: number }, Track | null>(PLAYER_RPC.queueRemove, ({ index }, ctx) =>
			state(ctx.playerId).remove(index),
		);
		bus.registerRpc<{ mode: LoopMode }, LoopMode>(PLAYER_RPC.queueLoop, ({ mode }, ctx) => state(ctx.playerId).setLoop(mode));
		bus.registerRpc<{ enabled: boolean }, boolean>(PLAYER_RPC.queueAutoPlay, ({ enabled }, ctx) =>
			state(ctx.playerId).setAutoPlay(enabled),
		);
		bus.registerRpc<{ track: Track | null }, void>(PLAYER_RPC.queueSetCurrent, ({ track }, ctx) =>
			state(ctx.playerId).setCurrentInternal(track),
		);
		bus.registerRpc<void, object>(PLAYER_RPC.queueSerialize, (_req, ctx) => state(ctx.playerId).serializeInternal());
		bus.registerRpc<{ state: object }, void>(PLAYER_RPC.queueRestore, ({ state: value }, ctx) =>
			state(ctx.playerId).restoreInternal(value),
		);
		bus.registerRpc<{ previousCurrent: Track | null; nextTrack: Track | null }, void>(
			PLAYER_RPC.queueRestoreNext,
			({ previousCurrent, nextTrack }, ctx) => state(ctx.playerId).restoreNext(previousCurrent, nextTrack),
		);
		bus.registerRpc<{ track: Track | null }, Track | null>(PLAYER_RPC.queueWillNext, ({ track }, ctx) => {
			const target = state(ctx.playerId);
			if (track) target.setWillNext(track);
			else target.clearWillNext();
			return target.willNext;
		});
	}

	attach(playerId: string): QueueState {
		const queueState = new QueueState(this.bus, playerId);
		this.states.set(playerId, queueState);
		return queueState;
	}
	detach(playerId: string): void {
		this.states.get(playerId)?.dispose();
		this.states.delete(playerId);
	}
}
