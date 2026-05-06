import { Track, LoopMode } from "../types";

/**
 * Manages the track queue for a player.
 *
 * @example
 * // Basic queue operations
 * const queue = player.queue;
 *
 * // Add single track
 * queue.add(track);
 *
 * // Add multiple tracks
 * queue.add([track1, track2, track3]);
 *
 * // Queue controls
 * queue.shuffle(); // Randomize order
 * queue.clear(); // Remove all tracks
 * queue.autoPlay(true); // Enable auto-play
 *
 * // Get queue information
 * console.log(`Queue length: ${queue.length}`);
 * console.log(`Current track: ${queue.current?.title}`);
 * console.log(`Is empty: ${queue.isEmpty}`);
 * console.log(`Is playing: ${queue.isPlaying}`);
 *
 * // Loop modes
 * queue.setLoopMode("track"); // Loop current track
 * queue.setLoopMode("queue"); // Loop entire queue
 * queue.setLoopMode("off"); // No loop
 *
 * // Remove specific track
 * const removed = queue.remove(0); // Remove first track
 * if (removed) {
 *   console.log(`Removed: ${removed.title}`);
 * }
 */
export class Queue {
	private tracks: Track[] = [];
	private current: Track | null = null;
	private history: Track[] = [];
	private related: Track[] = [];
	private _autoPlay = false;
	private _loop: LoopMode = "off";
	private willnext: Track | null = null;

	// Configuration
	private readonly MAX_HISTORY_SIZE = 200;
	private readonly MAX_QUEUE_SIZE = 1000; // Prevent memory issues

	/**
	 * Add track(s) to the queue
	 *
	 * @param {Track | Track[]} track - Track or array of tracks to add
	 * @returns {number} New queue size
	 * @example
	 * queue.add(track);
	 * queue.add([track1, track2, track3]);
	 */
	add(track: Track): number {
		if (this.tracks.length >= this.MAX_QUEUE_SIZE) {
			throw new Error(`Queue size limit reached (${this.MAX_QUEUE_SIZE})`);
		}
		this.tracks.push(track);
		return this.tracks.length;
	}

	/**
	 * Add multiple tracks to the queue
	 *
	 * @param {Track[]} tracks - Tracks to add
	 * @returns {number} New queue size
	 * @example
	 * queue.addMultiple([track1, track2, track3]);
	 */
	addMultiple(tracks: Track[]): number {
		if (this.tracks.length + tracks.length > this.MAX_QUEUE_SIZE) {
			throw new Error(`Adding ${tracks.length} tracks would exceed queue size limit (${this.MAX_QUEUE_SIZE})`);
		}
		this.tracks.push(...tracks);
		return this.tracks.length;
	}

	/**
	 * Insert a track at a specific upcoming position (0 = next)
	 *
	 * @param {Track} track - Track to insert
	 * @param {number} index - Index to insert the track at
	 * @returns {number} New queue size
	 * @example
	 * queue.insert(track, 0);
	 */
	insert(track: Track, index: number): number {
		if (this.tracks.length >= this.MAX_QUEUE_SIZE) {
			throw new Error(`Queue size limit reached (${this.MAX_QUEUE_SIZE})`);
		}

		if (!Number.isFinite(index)) {
			this.tracks.push(track);
			return this.tracks.length;
		}

		const i = Math.max(0, Math.min(Math.floor(index), this.tracks.length));

		if (i === this.tracks.length) {
			this.tracks.push(track);
		} else if (i <= 0) {
			this.tracks.unshift(track);
		} else {
			this.tracks.splice(i, 0, track);
		}

		return this.tracks.length;
	}

	/**
	 * Insert multiple tracks at a specific upcoming position, preserving order
	 *
	 * @param {Track[]} tracks - Tracks to insert
	 * @param {number} index - Index to insert the tracks at
	 * @returns {number} New queue size
	 * @example
	 * queue.insertMultiple([track1, track2, track3], 0);
	 */
	insertMultiple(tracks: Track[], index: number): number {
		if (!Array.isArray(tracks) || tracks.length === 0) return this.tracks.length;

		if (this.tracks.length + tracks.length > this.MAX_QUEUE_SIZE) {
			throw new Error(`Inserting ${tracks.length} tracks would exceed queue size limit (${this.MAX_QUEUE_SIZE})`);
		}

		if (!Number.isFinite(index)) {
			this.tracks.push(...tracks);
			return this.tracks.length;
		}

		const i = Math.max(0, Math.min(Math.floor(index), this.tracks.length));

		if (i === 0) {
			this.tracks = [...tracks, ...this.tracks];
		} else if (i === this.tracks.length) {
			this.tracks.push(...tracks);
		} else {
			this.tracks.splice(i, 0, ...tracks);
		}

		return this.tracks.length;
	}

	/**
	 * Remove a track from the queue
	 *
	 * @param {number} index - Index of track to remove
	 * @returns {Track | null} Removed track or null
	 * @example
	 * const removed = queue.remove(0);
	 * console.log(`Removed: ${removed?.title}`);
	 */
	remove(index: number): Track | null {
		if (index < 0 || index >= this.tracks.length) return null;
		const removed = this.tracks.splice(index, 1)[0];
		return removed;
	}

	/**
	 * Remove multiple tracks by indices
	 *
	 * @param {number[]} indices - Array of indices to remove
	 * @returns {Track[]} Removed tracks
	 * @example
	 * const removed = queue.removeMultiple([0, 2, 5]);
	 */
	removeMultiple(indices: number[]): Track[] {
		const sorted = [...new Set(indices)].sort((a, b) => b - a);
		const removed: Track[] = [];

		for (const index of sorted) {
			if (index >= 0 && index < this.tracks.length) {
				removed.unshift(this.tracks.splice(index, 1)[0]);
			}
		}

		return removed;
	}

	/**
	 * Remove tracks by predicate
	 *
	 * @param {(track: Track, index: number) => boolean} predicate - Filter function
	 * @returns {Track[]} Removed tracks
	 * @example
	 * const removed = queue.removeWhere(track => track.source === "youtube");
	 */
	removeWhere(predicate: (track: Track, index: number) => boolean): Track[] {
		const removed: Track[] = [];
		for (let i = this.tracks.length - 1; i >= 0; i--) {
			if (predicate(this.tracks[i], i)) {
				removed.unshift(this.tracks.splice(i, 1)[0]);
			}
		}
		return removed;
	}

	/**
	 * Get the next track in the queue
	 *
	 * @param {boolean} ignoreLoop - Ignore the loop mode
	 * @returns {Track | null} The next track or null
	 * @example
	 * const nextTrack = queue.next();
	 * console.log(`Next track: ${nextTrack?.title}`);
	 */
	next(ignoreLoop = false): Track | null {
		// Handle track loop
		if (this.current && this._loop === "track" && !ignoreLoop) {
			return this.current;
		}

		// Save current to history before moving to next
		if (this.current) {
			this.addToHistory(this.current);
		}

		// Get next track
		this.current = this.tracks.shift() || null;

		// Handle queue loop
		if (!this.current && this._loop === "queue" && this.history.length > 0 && !ignoreLoop) {
			this.tracks = [...this.history];
			this.history = [];
			this.current = this.tracks.shift() || null;
		}

		return this.current;
	}

	/**
	 * Add track to history with size limit
	 */
	private addToHistory(track: Track): void {
		this.history.push(track);
		if (this.history.length > this.MAX_HISTORY_SIZE) {
			this.history.shift();
		}
	}

	/**
	 * Clear all tracks from the queue
	 *
	 * @example
	 * queue.clear();
	 */
	clear(): void {
		this.tracks = [];
		// Optionally reset current track? Usually not, but provide option
	}

	/**
	 * Clear history
	 *
	 * @example
	 * queue.clearHistory();
	 */
	clearHistory(): void {
		this.history = [];
	}

	/**
	 * Reset entire queue (current, history, tracks)
	 *
	 * @example
	 * queue.reset();
	 */
	reset(): void {
		this.tracks = [];
		this.current = null;
		this.history = [];
		this.related = [];
		this.willnext = null;
	}

	/**
	 * Enable or disable auto-play
	 *
	 * @param {boolean} value - Enable/disable auto-play
	 * @returns {boolean} Current auto-play state
	 * @example
	 * queue.autoPlay(true);
	 * queue.autoPlay(); // Get current auto-play state
	 */
	autoPlay(value?: boolean): boolean {
		if (typeof value !== "undefined") {
			this._autoPlay = value;
		}
		return this._autoPlay;
	}

	/**
	 * Set the loop mode
	 *
	 * @param {LoopMode} mode - Loop mode to set
	 * @returns {LoopMode} The loop mode
	 * @example
	 * queue.loop("track");
	 */
	loop(mode?: LoopMode): LoopMode {
		if (mode) {
			this._loop = mode;
		}
		return this._loop;
	}

	/**
	 * Check if queue is currently looping
	 *
	 * @returns {boolean} True if looping
	 */
	isLooping(): boolean {
		return this._loop !== "off";
	}

	/**
	 * Get current loop mode
	 *
	 * @returns {LoopMode} Current loop mode
	 */
	getLoopMode(): LoopMode {
		return this._loop;
	}

	/**
	 * Shuffle the queue
	 *
	 * @example
	 * queue.shuffle();
	 */
	shuffle(): void {
		// Fisher-Yates shuffle
		for (let i = this.tracks.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
		}
	}

	/**
	 * Move a track from one position to another
	 *
	 * @param {number} fromIndex - Current index
	 * @param {number} toIndex - Target index
	 * @returns {boolean} True if move was successful
	 * @example
	 * queue.move(3, 0); // Move track at index 3 to position 0
	 */
	move(fromIndex: number, toIndex: number): boolean {
		if (fromIndex < 0 || fromIndex >= this.tracks.length) return false;
		if (toIndex < 0 || toIndex >= this.tracks.length) return false;
		if (fromIndex === toIndex) return true;

		const [track] = this.tracks.splice(fromIndex, 1);
		this.tracks.splice(toIndex, 0, track);
		return true;
	}

	/**
	 * Swap two tracks in the queue
	 *
	 * @param {number} indexA - First track index
	 * @param {number} indexB - Second track index
	 * @returns {boolean} True if swap was successful
	 * @example
	 * queue.swap(0, 3);
	 */
	swap(indexA: number, indexB: number): boolean {
		if (indexA < 0 || indexA >= this.tracks.length) return false;
		if (indexB < 0 || indexB >= this.tracks.length) return false;
		if (indexA === indexB) return true;

		[this.tracks[indexA], this.tracks[indexB]] = [this.tracks[indexB], this.tracks[indexA]];
		return true;
	}

	/**
	 * Get the size of the queue
	 */
	get size(): number {
		return this.tracks.length;
	}

	/**
	 * Check if the queue is empty
	 */
	get isEmpty(): boolean {
		return this.tracks.length === 0;
	}

	/**
	 * Get the current track
	 */
	get currentTrack(): Track | null {
		return this.current;
	}

	/**
	 * Get the previous tracks
	 */
	get previousTracks(): Track[] {
		return [...this.history];
	}

	/**
	 * Get the number of previous tracks
	 */
	get previousTracksCount(): number {
		return this.history.length;
	}

	/**
	 * Get the next track
	 */
	get nextTrack(): Track | null {
		return this.tracks[0] || null;
	}

	/**
	 * Get the last track in the queue
	 */
	get lastTrack(): Track | null {
		return this.tracks[this.tracks.length - 1] || null;
	}

	/**
	 * Move back to the previously played track.
	 * Makes the current track the next upcoming track, then sets previous as current.
	 *
	 * @returns {Track | null} The previous track or null
	 * @example
	 * const previousTrack = queue.previous();
	 * console.log(`Previous track: ${previousTrack?.title}`);
	 */
	previous(): Track | null {
		if (this.history.length === 0) return null;

		if (this.current) {
			this.tracks.unshift(this.current);
		}

		this.current = this.history.pop() || null;
		return this.current;
	}

	/**
	 * Jump to a specific track in history
	 *
	 * @param {number} stepsBack - Number of steps back in history (1 = previous)
	 * @returns {Track | null} The jumped-to track or null
	 * @example
	 * queue.jumpToHistory(2); // Go back 2 tracks
	 */
	jumpToHistory(stepsBack: number): Track | null {
		if (stepsBack <= 0 || stepsBack > this.history.length) return null;

		const targetIndex = this.history.length - stepsBack;
		if (targetIndex < 0) return null;

		// Save current track to queue if exists
		if (this.current) {
			this.tracks.unshift(this.current);
		}

		// Get tracks after target to push back to queue
		const tracksAfterTarget = this.history.splice(targetIndex + 1);
		this.current = this.history.pop() || null;

		// Push tracks after target back to queue (in reverse order to maintain sequence)
		for (let i = tracksAfterTarget.length - 1; i >= 0; i--) {
			this.tracks.unshift(tracksAfterTarget[i]);
		}

		return this.current;
	}

	/**
	 * Get the next track (for auto-play)
	 *
	 * @param {Track} track - The next track
	 * @returns {Track | null} The next track or null
	 * @example
	 * const nextTrack = queue.willNextTrack();
	 * console.log(`Next track: ${nextTrack?.title}`);
	 */
	willNextTrack(track?: Track): Track | null {
		if (track) {
			this.willnext = track;
		}
		return this.willnext;
	}

	/**
	 * Get the related tracks
	 *
	 * @param {Track[]} track - The related tracks
	 * @returns {Track[] | null} The related tracks or null
	 * @example
	 * const relatedTracks = queue.relatedTracks();
	 * console.log(`Related tracks: ${relatedTracks?.length}`);
	 */
	relatedTracks(track?: Track[]): Track[] | null {
		if (track) {
			this.related = track;
		}
		return this.related;
	}

	/**
	 * Get all tracks in the queue
	 *
	 * @returns {Track[]} Copy of tracks array
	 * @example
	 * const tracks = queue.getTracks();
	 * console.log(`Tracks: ${tracks.length}`);
	 */
	getTracks(): Track[] {
		return [...this.tracks];
	}
	
	/**
	 * Get serializable queue data
	 */
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

	/**
	 * Restore queue from serialized data
	 */
	fromJSON(data: { tracks: Track[]; current: Track | null; history: Track[]; loopMode: LoopMode; autoPlay: boolean }): void {
		this.tracks = [...data.tracks];
		this.current = data.current;
		this.history = [...data.history];
		this._loop = data.loopMode;
		this._autoPlay = data.autoPlay;
	}
	/**
	 * Get a track at a specific index
	 *
	 * @param {number} index - The index of the track
	 * @returns {Track | null} The track or null
	 * @example
	 * const track = queue.getTrack(0);
	 * console.log(`Track: ${track?.title}`);
	 */
	getTrack(index: number): Track | null {
		return this.tracks[index] || null;
	}

	/**
	 * Find tracks by predicate
	 *
	 * @param {(track: Track) => boolean} predicate - Search function
	 * @returns {Track[]} Matching tracks
	 * @example
	 * const youtubeTracks = queue.findTracks(track => track.source === "youtube");
	 */
	findTracks(predicate: (track: Track) => boolean): Track[] {
		return this.tracks.filter(predicate);
	}

	/**
	 * Get the index of a track in the queue
	 *
	 * @param {string | Track} identifier - Track ID, URL, or Track object
	 * @returns {number} Index of the track, -1 if not found
	 * @example
	 * const index = queue.indexOf(track);
	 */
	indexOf(identifier: string | Track): number {
		if (typeof identifier === "string") {
			return this.tracks.findIndex((t) => t.id === identifier || t.url === identifier);
		}
		return this.tracks.findIndex((t) => t.id === identifier.id);
	}

	/**
	 * Check if a track exists in the queue
	 *
	 * @param {string | Track} identifier - Track ID, URL, or Track object
	 * @returns {boolean} True if track exists
	 */
	has(identifier: string | Track): boolean {
		return this.indexOf(identifier) !== -1;
	}
}
