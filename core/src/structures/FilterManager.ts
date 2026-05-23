import type { AudioFilter } from "../types";
import { PREDEFINED_FILTERS } from "../types";
import type { Player } from "./Player";
import type { PlayerManager } from "./PlayerManager";
import prism, { FFmpeg } from "prism-media";
import type { Readable } from "stream";
import { spawn, type ChildProcess } from "child_process";
import ffmpegPath from "ffmpeg-static";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;

export class FilterManager {
	private activeFilters: AudioFilter[] = [];
	private debug: DebugFn;
	private player: Player;
	private ffmpeg: FFmpeg | null = null;
	private currentInputStream: Readable | null = null;
	public StreamType: "webm/opus" | "ogg/opus" | "mp3" | "arbitrary" = "mp3";
	private ffmpegProcess: ChildProcess | null = null;

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
		if (this.ffmpegProcess) {
			try {
				this.ffmpegProcess.kill("SIGKILL");
			} catch {}
			this.ffmpegProcess = null;
		}
		if (this.currentInputStream && typeof (this.currentInputStream as any).destroy === "function") {
			try {
				(this.currentInputStream as any).destroy();
			} catch {}
		}
		this.currentInputStream = null;
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
		return await this.player.refreshPlayerResource();
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
		return await this.player.refreshPlayerResource();
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
		return await this.player.refreshPlayerResource();
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
		this.debug(`Applying filters and seek — filters: ${filterString || "none"}, seek: ${position}ms`);

		// Tear down any previous FFmpeg instances.
		try {
			if (this.ffmpeg) {
				this.ffmpeg.destroy();
				this.ffmpeg = null;
			}
			if (this.ffmpegProcess) {
				this.ffmpegProcess.kill("SIGKILL");
				this.ffmpegProcess = null;
			}
			if (
				this.currentInputStream &&
				typeof (this.currentInputStream as any).destroy === "function" &&
				!(this.currentInputStream as any).destroyed
			) {
				try {
					(this.currentInputStream as any).destroy();
				} catch {}
			}
			this.currentInputStream = null;
		} catch {}

		this.currentInputStream = stream;

		// ── INPUT-SIDE SEEKING ─────────────────────────────────────────────────────
		// When a seek position is requested, place -ss BEFORE -i so FFmpeg seeks
		// in the compressed domain (keyframe-level) rather than decoding every
		// frame up to the target. This is dramatically faster for large positions.
		//
		// Output-side (slow): ffmpeg -i pipe:0 -ss 109 ...
		//   → reads and decodes all 109 s before outputting anything
		//
		// Input-side (fast):  ffmpeg -ss 109 -i pipe:0 ...
		//   → seeks to nearest keyframe < 109 s, outputs from there
		//
		// prism.FFmpeg always places user args after -i, so we spawn directly.
		if (position >= 0 && ffmpegPath) {
			return this.spawnFFmpegInputSeek(stream, position, filterString);
		}

		// ── FILTER-ONLY (no seek) — use prism.FFmpeg as before ────────────────────
		const args = ["-analyzeduration", "0", "-loglevel", "0"];
		if (filterString) {
			args.push("-af", filterString);
		}
		args.push(
			"-f",
			this.StreamType === "webm/opus" ? "webm/opus"
			: this.StreamType === "ogg/opus" ? "ogg/opus"
			: "mp3",
		);
		args.push("-ar", "48000", "-ac", "2");

		try {
			this.ffmpeg = stream.pipe(new prism.FFmpeg({ args }));
		} catch (spawnError) {
			this.debug(`FFmpeg spawn error:`, spawnError);
			this.currentInputStream = null;
			throw spawnError;
		}

		this.ffmpeg.on("close", () => {
			this.debug(`FFmpeg processing completed`);
			try {
				if (this.ffmpeg) {
					this.ffmpeg.destroy();
					this.ffmpeg = null;
				}
			} catch {}
		});
		this.ffmpeg.on("error", (err: Error) => {
			this.debug(`FFmpeg error:`, err);
			try {
				if (this.ffmpeg) {
					this.ffmpeg.destroy();
					this.ffmpeg = null;
				}
				if (this.currentInputStream && !(this.currentInputStream as any).destroyed) {
					try {
						(this.currentInputStream as any).destroy();
					} catch {}
				}
			} catch {}
			this.currentInputStream = null;
		});

		return this.ffmpeg;
	}

	private spawnFFmpegInputSeek(stream: Readable, position: number, filterString: string): Readable {
		const seekSeconds = (position / 1000).toFixed(3);

		const args: string[] = [
			// INPUT-SIDE SEEK: placed before -i
			"-ss",
			seekSeconds,
			"-i",
			"pipe:0",
			// Output options
			"-analyzeduration",
			"0",
			"-loglevel",
			"0",
		];

		if (filterString) {
			args.push("-af", filterString);
		}

		const outFormat =
			this.StreamType === "webm/opus" ? "webm"
			: this.StreamType === "ogg/opus" ? "ogg"
			: "mp3";

		args.push("-f", outFormat, "-ar", "48000", "-ac", "2", "pipe:1");

		const proc = spawn(ffmpegPath!, args, {
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.ffmpegProcess = proc;

		// Pipe source → ffmpeg stdin
		stream.pipe(proc.stdin!);

		// Suppress EPIPE on stdin when the process exits early
		proc.stdin!.on("error", (err: Error) => {
			if ((err as any).code !== "EPIPE") {
				this.debug(`FFmpeg stdin error: ${err.message}`);
			}
		});

		proc.stdout!.on("error", (err: Error) => {
			this.debug(`FFmpeg stdout error: ${err.message}`);
		});

		proc.on("close", (code) => {
			this.debug(`FFmpeg process exited (code: ${code})`);
			this.ffmpegProcess = null;
		});

		proc.on("error", (err: Error) => {
			this.debug(`FFmpeg process error: ${err.message}`);
			this.ffmpegProcess = null;
			throw err;
		});

		return proc.stdout as Readable;
	}
}
