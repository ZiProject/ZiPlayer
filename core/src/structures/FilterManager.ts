import type { AudioFilter, StreamInfo } from "../types";
import { PREDEFINED_FILTERS } from "../types";
import type { Player } from "./Player";
import type { PlayerManager } from "./PlayerManager";
import prism, { FFmpeg } from "prism-media";
import type { Readable } from "stream";
import { spawn, type ChildProcess } from "child_process";
import ffmpegPath from "ffmpeg-static";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;

export type FilterManagerStreamType = "webm/opus" | "ogg/opus" | "arbitrary" | "mp3";

export class FilterManager {
	private activeFilters: AudioFilter[] = [];
	private debug: DebugFn;
	private player: Player;
	private ffmpeg: FFmpeg | null = null;
	private currentInputStream: Readable | null = null;
	public StreamType: FilterManagerStreamType = "arbitrary";
	private ffmpegProcess: ChildProcess | null = null;
	private ffmpegAbortController: AbortController | null = null;
	private ffmpegGeneration = 0;
	private pendingFFmpegProcess: ChildProcess | null = null;

	constructor(player: Player, manager: PlayerManager) {
		this.player = player as Player;
		this.debug = (message?: any, ...optionalParams: any[]) => {
			if (manager.debugEnabled) {
				manager.emit("debug", `[FilterManager] ${message}`, ...optionalParams);
			}
		};
	}

	public setSourceStreamType(type: string): void {
		if (type === "webm/opus" || type === "ogg/opus" || type === "mp3") {
			this.StreamType = type as FilterManagerStreamType;
		} else {
			this.StreamType = "arbitrary";
		}
		this.debug(`[FilterManager] Source stream type set to: ${this.StreamType}`);
	}

	destroy(): void {
		this.activeFilters = [];
		this.teardownFFmpeg();
		this.currentInputStream = null;
	}

	private teardownFFmpeg(): void {
		// Abort any pending spawn first
		if (this.ffmpegAbortController) {
			this.ffmpegAbortController.abort();
			this.ffmpegAbortController = null;
		}

		if (this.ffmpeg) {
			try {
				this.ffmpeg.destroy();
			} catch {
				/* ignore */
			}
			this.ffmpeg = null;
		}

		if (this.ffmpegProcess) {
			try {
				// Detach stdin so source stream doesn't get EPIPE when we kill
				if (this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
					this.ffmpegProcess.stdin.destroy();
				}
				this.ffmpegProcess.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			this.ffmpegProcess = null;
		}
	}

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

		if (this.activeFilters.some((f) => f.name === audioFilter!.name)) {
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
	public async applyFiltersAndSeek(
		streamInfo: StreamInfo,
		position: number = -1,
	): Promise<StreamInfo & { wasRecreated?: boolean }> {
		const generation = ++this.ffmpegGeneration;
		const filterString = this.getFilterString();

		let sourceStream = streamInfo.stream;
		let wasRecreated = false;

		if (position >= 0 && streamInfo.recreate) {
			sourceStream = await streamInfo.recreate(position);
			wasRecreated = true;

			position = -1;
			streamInfo.type = "arbitrary";
			if (!filterString) return { ...streamInfo, stream: sourceStream, wasRecreated };
		}

		this.debug(`Applying filters and seek — filters: ${filterString || "none"}, seek: ${position}ms`);

		if (generation !== this.ffmpegGeneration) {
			throw new Error("FFmpeg generation outdated");
		}

		this.currentInputStream = sourceStream;
		const abortController = new AbortController();
		this.ffmpegAbortController = abortController;

		// Nếu có vị trí seek, ưu tiên dùng spawnFFmpegInputSeek
		if (position >= 0 && ffmpegPath) {
			const stream = await this.spawnFFmpegInputSeek(sourceStream, position, filterString, abortController.signal, generation);
			return { ...streamInfo, stream };
		}

		// Trường hợp chỉ apply filter mà không seek (position < 0)
		const args = [
			"-analyzeduration",
			"0",
			"-loglevel",
			"0",
			"-i",
			"pipe:0",
			"-acodec",
			"libopus", // Chuyển sang opus ngay để nhẹ pipe
			"-f",
			"opus", // Format chuẩn cho Discord
			"-ar",
			"48000",
			"-ac",
			"2",
		];

		if (filterString) {
			args.splice(4, 0, "-af", filterString);
		}

		try {
			// Sử dụng prism.FFmpeg cho trường hợp không seek
			this.ffmpeg = sourceStream.pipe(new prism.FFmpeg({ args }));
			return { ...streamInfo, stream: this.ffmpeg };
		} catch (spawnError) {
			this.debug(`FFmpeg spawn error:`, spawnError);
			throw spawnError;
		}
	}

	private spawnFFmpegInputSeek(
		stream: Readable,
		position: number,
		filterString: string,
		signal: AbortSignal,
		generation: number,
	): Readable {
		// Convert milliseconds to seconds for FFmpeg (position is integer ms, convert to string for CLI)
		const seekSeconds = String((position / 1000).toFixed(3));

		// Chuyển sang dùng s16le (Raw PCM) để Discord.js dễ xử lý nhất khi có filter
		// NOTE: -ss MUST come BEFORE -i for proper seeking and timing
		const args: string[] = ["-ss", seekSeconds, "-i", "pipe:0", "-analyzeduration", "0", "-loglevel", "0"];

		if (filterString) {
			args.push("-af", filterString);
		}

		// Xuất ra dạng s16le là dạng "an toàn" nhất cho mọi loại filter
		args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");

		const proc = spawn(ffmpegPath!, args, {
			stdio: ["pipe", "pipe", "ignore"],
		});

		const oldProcess = this.ffmpegProcess;

		this.pendingFFmpegProcess = proc;

		if (generation !== this.ffmpegGeneration) {
			try {
				proc.kill("SIGKILL");
			} catch {}

			throw new Error("FFmpeg process superseded");
		}

		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);

			try {
				stream.unpipe(proc.stdin!);
			} catch {}

			try {
				if (proc.stdin && !proc.stdin.destroyed) {
					proc.stdin.destroy();
				}
			} catch {}

			try {
				proc.kill("SIGKILL");
			} catch {}

			this.debug(`[FilterManager] FFmpeg process aborted (seek pos: ${position}ms)`);
		};

		if (signal.aborted) {
			// Already aborted before we even spawned
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort);
		}

		// Pipe source → ffmpeg stdin
		stream.pipe(proc.stdin!);

		// Suppress EPIPE on stdin when the process exits early
		proc.stdin!.on("error", (err: Error) => {
			if ((err as any).code !== "EPIPE") {
				this.debug(`FFmpeg stdin error: ${err.message}`);
			}
			// EPIPE is expected when proc is killed — silence it
		});

		proc.stdout!.on("error", (err: Error) => {
			this.debug(`FFmpeg stdout error: ${err.message}`);
		});

		proc.on("close", (code) => {
			signal.removeEventListener("abort", onAbort);
			this.debug(`FFmpeg process exited (code: ${code})`);
			if (this.ffmpegProcess === proc) {
				this.ffmpegProcess = null;
			}
		});

		proc.on("error", (err: Error) => {
			signal.removeEventListener("abort", onAbort);
			this.debug(`FFmpeg process error: ${err.message}`);
			if (this.ffmpegProcess === proc) {
				this.ffmpegProcess = null;
			}
		});

		this.ffmpegProcess = proc;
		this.pendingFFmpegProcess = null;

		// kill old AFTER new ready
		if (oldProcess && oldProcess !== proc) {
			try {
				if (oldProcess.stdin && !oldProcess.stdin.destroyed) {
					oldProcess.stdin.destroy();
				}
			} catch {}

			try {
				oldProcess.kill("SIGKILL");
			} catch {}
		}

		return proc.stdout as Readable;
	}
}
