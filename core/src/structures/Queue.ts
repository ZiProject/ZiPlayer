import { Track, LoopMode } from "../types";

export class Queue {
	private tracks: Track[] = [];
	private current: Track | null = null;
	private history: Track[] = [];
	private related: Track[] = [];
	private _autoPlay = false;
	private _loop: LoopMode = "off";
	private willnext: Track | null = null;
	private readonly MAX_HISTORY_SIZE = 200;
	private readonly MAX_QUEUE_SIZE = 1000;

	add(track: Track): number {
		if (this.tracks.length >= this.MAX_QUEUE_SIZE) throw new Error(`Queue size limit reached (${this.MAX_QUEUE_SIZE})`);
		this.tracks.push(track);
		return this.tracks.length;
	}
	addMultiple(tracks: Track[]): number {
		if (this.tracks.length + tracks.length > this.MAX_QUEUE_SIZE)
			throw new Error(`Adding ${tracks.length} tracks would exceed queue size limit (${this.MAX_QUEUE_SIZE})`);
		this.tracks.push(...tracks);
		return this.tracks.length;
	}
	insert(track: Track, index: number): number {
		if (this.tracks.length >= this.MAX_QUEUE_SIZE) throw new Error(`Queue size limit reached (${this.MAX_QUEUE_SIZE})`);
		if (!Number.isFinite(index)) {
			this.tracks.push(track);
			return this.tracks.length;
		}
		const i = Math.max(0, Math.min(Math.floor(index), this.tracks.length));
		this.tracks.splice(i, 0, track);
		return this.tracks.length;
	}
	insertMultiple(tracks: Track[], index: number): number {
		if (!Array.isArray(tracks) || tracks.length === 0) return this.tracks.length;
		if (this.tracks.length + tracks.length > this.MAX_QUEUE_SIZE)
			throw new Error(`Inserting ${tracks.length} tracks would exceed queue size limit (${this.MAX_QUEUE_SIZE})`);
		const i = Number.isFinite(index) ? Math.max(0, Math.min(Math.floor(index), this.tracks.length)) : this.tracks.length;
		this.tracks.splice(i, 0, ...tracks);
		return this.tracks.length;
	}
	remove(index: number): Track | null {
		if (index < 0 || index >= this.tracks.length) return null;
		return this.tracks.splice(index, 1)[0] ?? null;
	}
	removeMultiple(indices: number[]): Track[] {
		const sorted = [...new Set(indices)].sort((a, b) => b - a);
		const removed: Track[] = [];
		for (const index of sorted) if (index >= 0 && index < this.tracks.length) removed.unshift(this.tracks.splice(index, 1)[0]);
		return removed;
	}
	removeWhere(predicate: (track: Track, index: number) => boolean): Track[] {
		const removed: Track[] = [];
		for (let i = this.tracks.length - 1; i >= 0; i--)
			if (predicate(this.tracks[i], i)) removed.unshift(this.tracks.splice(i, 1)[0]);
		return removed;
	}
	next(ignoreLoop = false): Track | null {
		if (this.current && this._loop === "track" && !ignoreLoop) return this.current;
		if (this.current) this.addToHistory(this.current);
		if (ignoreLoop && this.current && this.tracks[0] === this.current) this.tracks.shift();
		this.current = this.tracks.shift() || null;
		if (!this.current && this._loop === "queue" && this.history.length > 0 && !ignoreLoop) {
			this.tracks = [...this.history];
			this.history = [];
			this.current = this.tracks.shift() || null;
		}
		if (!this.current && this._loop === "track" && ignoreLoop && this.history.length > 0) return null;
		return this.current;
	}
	private addToHistory(track: Track): void {
		this.history.push(track);
		if (this.history.length > this.MAX_HISTORY_SIZE) this.history.shift();
	}
	clear(): void {
		this.tracks = [];
	}
	clearHistory(): void {
		this.history = [];
	}
	reset(): void {
		this.tracks = [];
		this.current = null;
		this.history = [];
		this.related = [];
		this.willnext = null;
	}
	autoPlay(value?: boolean): boolean {
		if (typeof value !== "undefined") this._autoPlay = value;
		return this._autoPlay;
	}
	loop(mode?: LoopMode): LoopMode {
		if (mode !== undefined && mode !== this._loop) {
			this._loop = mode;
			this.willnext = null;
		}
		return this._loop;
	}
	isLooping(): boolean {
		return this._loop !== "off";
	}
	getLoopMode(): LoopMode {
		return this._loop;
	}
	shuffle(): void {
		for (let i = this.tracks.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
		}
	}
	move(fromIndex: number, toIndex: number): boolean {
		if (fromIndex < 0 || fromIndex >= this.tracks.length || toIndex < 0 || toIndex >= this.tracks.length) return false;
		if (fromIndex === toIndex) return true;
		const [track] = this.tracks.splice(fromIndex, 1);
		this.tracks.splice(toIndex, 0, track);
		return true;
	}
	swap(indexA: number, indexB: number): boolean {
		if (indexA < 0 || indexA >= this.tracks.length || indexB < 0 || indexB >= this.tracks.length) return false;
		if (indexA === indexB) return true;
		[this.tracks[indexA], this.tracks[indexB]] = [this.tracks[indexB], this.tracks[indexA]];
		return true;
	}
	get size(): number {
		return this.tracks.length;
	}
	get isEmpty(): boolean {
		return this.tracks.length === 0;
	}
	get currentTrack(): Track | null {
		return this.current;
	}
	setCurrentTrack(track: Track | null): void {
		this.current = track;
	}
	get previousTracks(): Track[] {
		return [...this.history];
	}
	get previousTracksCount(): number {
		return this.history.length;
	}
	get nextTrack(): Track | null {
		return this.tracks[0] || null;
	}
	get lastTrack(): Track | null {
		return this.tracks[this.tracks.length - 1] || null;
	}
	getTracks(): Track[] {
		return [...this.tracks];
	}
	getTrack(index: number): Track | null {
		return this.tracks[index] || null;
	}
	findTracks(predicate: (track: Track) => boolean): Track[] {
		return this.tracks.filter(predicate);
	}
	indexOf(identifier: string | Track): number {
		return typeof identifier === "string" ?
				this.tracks.findIndex((t) => t.id === identifier || t.url === identifier)
			:	this.tracks.findIndex(
					(t) =>
						(t.id !== undefined && identifier.id !== undefined && t.id === identifier.id) ||
						(t.url !== undefined && identifier.url !== undefined && t.url === identifier.url),
				);
	}
	has(identifier: string | Track): boolean {
		return this.indexOf(identifier) !== -1;
	}
	previous(): Track | null {
		if (this.history.length === 0) return null;
		if (this.current) this.tracks.unshift(this.current);
		this.current = this.history.pop() || null;
		return this.current;
	}
	jumpToHistory(stepsBack: number): Track | null {
		if (stepsBack <= 0 || stepsBack > this.history.length) return null;
		const targetIndex = this.history.length - stepsBack;
		if (targetIndex < 0) return null;
		if (this.current) this.tracks.unshift(this.current);
		const tracksAfterTarget = this.history.splice(targetIndex + 1);
		this.current = this.history.pop() || null;
		for (let i = tracksAfterTarget.length - 1; i >= 0; i--) this.tracks.unshift(tracksAfterTarget[i]);
		return this.current;
	}
	willNextTrack(track?: Track): Track | null {
		if (track) this.willnext = track;
		return this.willnext;
	}
	clearWillNext(): void {
		this.willnext = null;
	}
	relatedTracks(track?: Track[]): Track[] {
		if (track) this.related = track;
		return this.related;
	}
	toJSON(): object {
		return {
			tracks: this.tracks,
			current: this.current,
			history: this.history,
			size: this.size,
			loopMode: this._loop,
			autoPlay: this._autoPlay,
		};
	}
	fromJSON(data: { tracks: Track[]; current: Track | null; history: Track[]; loopMode: LoopMode; autoPlay: boolean }): void {
		if (!data || typeof data !== "object") throw new TypeError("Invalid queue state");
		const tracks = Array.isArray(data.tracks) ? data.tracks.filter((track) => track && typeof track === "object") : [];
		const history = Array.isArray(data.history) ? data.history.filter((track) => track && typeof track === "object") : [];
		this.tracks = tracks.slice(0, this.MAX_QUEUE_SIZE);
		this.current = data.current && typeof data.current === "object" ? data.current : null;
		this.history = history.slice(-this.MAX_HISTORY_SIZE);
		this._loop = data.loopMode === "off" || data.loopMode === "track" || data.loopMode === "queue" ? data.loopMode : "off";
		this._autoPlay = data.autoPlay === true;
	}
}
