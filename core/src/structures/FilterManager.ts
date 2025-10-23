import type { AudioFilter } from "../types";
import { PREDEFINED_FILTERS } from "../types";
import type { Player } from "./Player";
import type { PlayerManager } from "./PlayerManager";
import prism, { FFmpeg } from "prism-media";
import type { Readable } from "stream";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;

export class FilterManager {
	private activeFilters: AudioFilter[] = [];
	private debug: DebugFn;
	private player: Player;
	private ffmpeg: FFmpeg | null = null;
	public StreamType: "webm/opus" | "ogg/opus" | "mp3" | "arbitrary" = "mp3";

	constructor(player: Player, manager: PlayerManager) {
		this.player = player as Player;

		this.debug = (message?: any, ...optionalParams: any[]) => {
			if (manager.debugEnabled) {
				manager.emit("debug", `[FilterManager] ${message}`, ...optionalParams);
			}
		};
	}

	/**
	 * Destroy the filter manager
	 *
	 * @returns {void}
	 * @example
	 * player.filter.destroy();
	 */
	destroy(): void {
		this.activeFilters = [];
		if (this.ffmpeg) {
			try {
				this.ffmpeg.destroy();
			} catch {}
			this.ffmpeg = null;
		}
	}

	/**
	 * Get the combined FFmpeg filter string for all active filters
	 *
	 * @returns {string} Combined FFmpeg filter string
	 * @example
	 * const filterString = player.getFilterString();
	 * console.log(`Filter string: ${filterString}`);
	 */
	public getFilterString(): string {
		if (this.activeFilters.length === 0) return "";
		return this.activeFilters.map((f) => f.ffmpegFilter).join(",");
	}

	/**
	 * Get all currently applied filters
	 *
	 * @returns {AudioFilter[]} Array of active filters
	 * @example
	 * const filters = player.getActiveFilters();
	 * console.log(`Active filters: ${filters.map(f => f.name).join(', ')}`);
	 */
	public getActiveFilters(): AudioFilter[] {
		return [...this.activeFilters];
	}

	/**
	 * Check if a specific filter is currently applied
	 *
	 * @param {string} filterName - Name of the filter to check
	 * @returns {boolean} True if filter is applied
	 * @example
	 * const hasBassBoost = player.hasFilter("bassboost");
	 * console.log(`Has bass boost: ${hasBassBoost}`);
	 */
	public hasFilter(filterName: string): boolean {
		return this.activeFilters.some((f) => f.name === filterName);
	}

	/**
	 * Get available predefined filters
	 *
	 * @returns {AudioFilter[]} Array of all predefined filters
	 * @example
	 * const availableFilters = player.getAvailableFilters();
	 * console.log(`Available filters: ${availableFilters.length}`);
	 */
	public getAvailableFilters(): AudioFilter[] {
		return Object.values(PREDEFINED_FILTERS);
	}

	/**
	 * Get filters by category
	 *
	 * @param {string} category - Category to filter by
	 * @returns {AudioFilter[]} Array of filters in the category
	 * @example
	 * const eqFilters = player.getFiltersByCategory("eq");
	 * console.log(`EQ filters: ${eqFilters.map(f => f.name).join(', ')}`);
	 */
	public getFiltersByCategory(category: string): AudioFilter[] {
		return Object.values(PREDEFINED_FILTERS).filter((f) => f.category === category);
	}

	/**
	 * Apply an audio filter to the player
	 *
	 * @param {string | AudioFilter} filter - Filter name or AudioFilter object
	 * @returns {Promise<boolean>} True if filter was applied successfully
	 * @example
	 * // Apply predefined filter to current track
	 * await player.applyFilter("bassboost");
	 *
	 * // Apply custom filter to current track
	 * await player.applyFilter({
	 *   name: "custom",
	 *   ffmpegFilter: "volume=1.5,treble=g=5",
	 *   description: "Tăng âm lượng và âm cao"
	 * });
	 *
	 * // Apply filter without affecting current track
	 * await player.applyFilter("bassboost", false);
	 */
	public async applyFilter(filter?: string | AudioFilter): Promise<boolean> {
		if (!filter) return false;

		let audioFilter: AudioFilter | undefined;
		if (typeof filter === "string") {
			const predefined = PREDEFINED_FILTERS[filter];
			if (!predefined) {
				this.debug(`[FilterManager] Predefined filter not found: ${filter}`);
				return false;
			}
			audioFilter = predefined;
		} else {
			audioFilter = filter;
		}

		if (this.activeFilters.some((f) => f.name === audioFilter.name)) {
			this.debug(`[FilterManager] Filter already applied: ${audioFilter.name}`);
			return false;
		}

		this.activeFilters.push(audioFilter);
		this.debug(`[FilterManager] Applied filter: ${audioFilter.name} - ${audioFilter.description}`);
		return await this.player.refeshPlayerResource();
	}

	/**
	 * Apply multiple filters at once
	 *
	 * @param {(string | AudioFilter)[]} filters - Array of filter names or AudioFilter objects
	 * @returns {Promise<boolean>} True if all filters were applied successfully
	 * @example
	 * // Apply multiple filters to current track
	 * await player.applyFilters(["bassboost", "trebleboost"]);
	 *
	 * // Apply filters without affecting current track
	 * await player.applyFilters(["bassboost", "trebleboost"], false);
	 */
	public async applyFilters(filters: (string | AudioFilter)[]): Promise<boolean> {
		let allApplied = true;
		for (const f of filters) {
			const ok = await this.applyFilter(f);
			if (!ok) allApplied = false;
		}
		return allApplied;
	}
	/**
	 * Remove an audio filter from the player
	 *
	 * @param {string} filterName - Name of the filter to remove
	 * @returns {boolean} True if filter was removed successfully
	 * @example
	 * player.removeFilter("bassboost");
	 */
	public async removeFilter(filterName: string): Promise<boolean> {
		const index = this.activeFilters.findIndex((f) => f.name === filterName);
		if (index === -1) {
			this.debug(`[FilterManager] Filter not found: ${filterName}`);
			return false;
		}
		const removed = this.activeFilters.splice(index, 1)[0];
		this.debug(`[FilterManager] Removed filter: ${removed.name}`);
		return await this.player.refeshPlayerResource();
	}

	/**
	 * Clear all audio filters from the player
	 *
	 * @returns {boolean} True if filters were cleared successfully
	 * @example
	 * player.clearFilters();
	 */
	public async clearAll(): Promise<boolean> {
		const count = this.activeFilters.length;
		this.activeFilters = [];
		this.debug(`[FilterManager] Cleared ${count} filters`);
		return await this.player.refeshPlayerResource();
	}

	/**
	 * Apply filters and seek to a stream
	 *
	 * @param {Readable} stream - The stream to apply filters and seek to
	 * @param {number} position - The position to seek to in milliseconds (default: 0)
	 * @returns {Promise<Readable>} The stream with filters and seek applied
	 */
	public async applyFiltersAndSeek(stream: Readable, position: number = -1): Promise<Readable> {
		const filterString = this.getFilterString();
		this.debug(`[FilterManager] Applying filters and seek to stream: ${filterString || "none"}, seek: ${position}ms`);
		try {
			const args = ["-analyzeduration", "0", "-loglevel", "0"];

			if (position > 0) {
				const seekSeconds = Math.floor(position / 1000);
				args.push("-ss", seekSeconds.toString());
			}

			// Add filter if any are active
			if (filterString) {
				args.push("-af", filterString);
			}
			args.push("-f", this.StreamType === "webm/opus" ? "webm/opus" : this.StreamType === "ogg/opus" ? "ogg/opus" : "mp3");
			args.push("-ar", "48000", "-ac", "2");

			try {
				if (this.ffmpeg) {
					this.ffmpeg.destroy();
				}
				this.ffmpeg = null;
			} catch {}

			this.ffmpeg = stream.pipe(new prism.FFmpeg({ args }));

			this.ffmpeg.on("close", () => {
				this.debug(`[FilterManager] FFmpeg filter+seek processing completed`);
				if (this.ffmpeg) {
					this.ffmpeg.destroy();
					this.ffmpeg = null;
				}
			});

			this.ffmpeg.on("error", (err: Error) => {
				this.debug(`[FilterManager] FFmpeg filter+seek error:`, err);
				if (this.ffmpeg) {
					this.ffmpeg.destroy();
				}
				if (this.ffmpeg) {
					this.ffmpeg = null;
				}
			});
			return this.ffmpeg;
		} catch (error) {
			this.debug(`[FilterManager] Error creating FFmpeg instance:`, error);
			// Fallback to original stream if FFmpeg fails
			throw error;
		}
	}
}
