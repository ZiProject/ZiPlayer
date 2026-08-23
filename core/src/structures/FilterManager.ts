import type { AudioFilter, StreamInfo } from "../types";
import { PREDEFINED_FILTERS } from "../types";
import type { Player } from "./Player";
import type { PlayerManager } from "./PlayerManager";
import type { Readable } from "stream";
import { spawn, type ChildProcess } from "child_process";
import ffmpegPath from "ffmpeg-static";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;

export type FilterManagerStreamType = "webm/opus" | "ogg/opus" | "arbitrary" | "mp3";

/**
 * Owns the FFmpeg process used for player filters and seek operations.
 *
 * A Node/Web Readable is not seekable. For a stream input, `-ss` therefore
 * has to be used after `-i`, which makes FFmpeg decode and discard samples
 * until the requested position. The Player supplies a fresh source stream
 * when an actual seek is requested.
 */
export class FilterManager {
	private activeFilters: AudioFilter[] = [];
	private debug: DebugFn;
	private player: Player;
	private ffmpegOutput: Readable | null = null;
	private currentInputStream: Readable | string | null = null;
	public StreamType: FilterManagerStreamType = "arbitrary";
	private ffmpegProcess: ChildProcess | null = null;
	private ffmpegAbortController: AbortController | null = null;
	private ffmpegGeneration = 0;

	constructor(player: Player, manager: PlayerManager) {
		this.player = player;
		this.debug = (message?: any, ...optionalParams: any[]) => {
			if (manager.debugEnabled) {
				manager.emit("debug", `[FilterManager] ${message}`, ...optionalParams);
			}
		};
	}

	public setSourceStreamType(type: string): void {
		if (type === "webm/opus" || type === "ogg/opus" || type === "mp3") {
			this.StreamType = type;
		} else {
			this.StreamType = "arbitrary";
		}
		this.debug(`Source stream type set to: ${this.StreamType}`);
	}

	destroy(): void {
		this.activeFilters = [];
		this.teardownFFmpeg();
		this.currentInputStream = null;
	}

	private teardownFFmpeg(): void {
		this.ffmpegAbortController?.abort();
		this.ffmpegAbortController = null;

		const output = this.ffmpegOutput;
		this.ffmpegOutput = null;
		if (output && !output.destroyed) {
			try {
				output.destroy();
			} catch {}
		}

		const process = this.ffmpegProcess;
		this.ffmpegProcess = null;
		if (process) {
			try {
				if (process.stdin && !process.stdin.destroyed) process.stdin.destroy();
			} catch {}
			try {
				if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
			} catch {}
		}
	}

	public getFilterString(): string {
		return this.activeFilters.map((filter) => filter.ffmpegFilter).join(",");
	}

	public getActiveFilters(): AudioFilter[] {
		return [...this.activeFilters];
	}

	public hasFilter(filterName: string): boolean {
		return this.activeFilters.some((filter) => filter.name === filterName);
	}

	public getAvailableFilters(): AudioFilter[] {
		return Object.values(PREDEFINED_FILTERS);
	}

	public getFiltersByCategory(category: string): AudioFilter[] {
		return Object.values(PREDEFINED_FILTERS).filter((filter) => filter.category === category);
	}

	private resolveFilter(filter: string | AudioFilter): AudioFilter | undefined {
		if (typeof filter !== "string") return filter;
		return PREDEFINED_FILTERS[filter];
	}

	public async applyFilter(filter?: string | AudioFilter): Promise<boolean> {
		if (!filter) return false;

		const audioFilter = this.resolveFilter(filter);
		if (!audioFilter) {
			this.debug(`Predefined filter not found: ${String(filter)}`);
			return false;
		}

		if (this.activeFilters.some((current) => current.name === audioFilter.name)) return false;

		this.activeFilters.push(audioFilter);
		this.debug(`Applied filter: ${audioFilter.name} - ${audioFilter.description}`);
		return this.player.refreshPlayerResource();
	}

	public async applyFilters(filters: (string | AudioFilter)[]): Promise<boolean> {
		let changed = false;
		let allApplied = true;

		for (const filter of filters) {
			const audioFilter = this.resolveFilter(filter);
			if (!audioFilter) {
				allApplied = false;
				continue;
			}
			if (this.activeFilters.some((current) => current.name === audioFilter.name)) continue;
			this.activeFilters.push(audioFilter);
			changed = true;
		}

		if (!changed) return allApplied;
		return allApplied && (await this.player.refreshPlayerResource());
	}

	public async removeFilter(filterName: string): Promise<boolean> {
		const index = this.activeFilters.findIndex((filter) => filter.name === filterName);
		if (index === -1) return false;

		this.activeFilters.splice(index, 1);
		this.debug(`Removed filter: ${filterName}`);
		return this.player.refreshPlayerResource();
	}

	public async clearAll(): Promise<boolean> {
		const count = this.activeFilters.length;
		this.activeFilters = [];
		this.debug(`Cleared ${count} filters`);
		return this.player.refreshPlayerResource();
	}

	public async applyFiltersAndSeek(
		streamInfo: StreamInfo,
		position: number = -1,
	): Promise<StreamInfo & { wasRecreated?: boolean }> {
		const generation = ++this.ffmpegGeneration;
		this.teardownFFmpeg();

		let sourceStream: Readable | string | undefined = streamInfo.stream || streamInfo.url;
		if (!sourceStream) throw new Error("No source stream or URL available");

		let wasRecreated = false;
		if (position >= 0 && streamInfo.recreate) {
			sourceStream = await streamInfo.recreate(position);
			wasRecreated = true;
			if (!sourceStream) throw new Error("Stream recreation returned no stream");
		}

		if (generation !== this.ffmpegGeneration) throw new Error("FFmpeg generation outdated");

		this.currentInputStream = sourceStream;
		const filterString = this.getFilterString();
		const hasSeek = position >= 0;

		this.debug(
			`Applying filters and seek — filters: ${filterString || "none"}, seek: ${hasSeek ? `${position}ms` : "none"}, source: ${typeof sourceStream === "string" ? "url" : "stream"}`,
		);

		if (!hasSeek && !filterString) {
			return { ...streamInfo, stream: sourceStream, wasRecreated };
		}

		if (!ffmpegPath) throw new Error("FFmpeg binary not found");

		const args: string[] = ["-hide_banner", "-loglevel", "error"];
		const seekSeconds = hasSeek ? (position / 1000).toFixed(3) : null;

		if (typeof sourceStream === "string") {
			if (seekSeconds !== null) args.push("-ss", seekSeconds);
			args.push("-i", sourceStream);
		} else {
			// pipe:0 is non-seekable, so input-side -ss cannot work here.
			// Put -ss after -i to decode/discard until the requested timestamp.
			args.push("-i", "pipe:0");
			if (seekSeconds !== null) args.push("-ss", seekSeconds);
		}

		if (filterString) args.push("-af", filterString);

		if (hasSeek) {
			// Seek output is raw PCM and Player.createResource marks it as Raw.
			args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");
		} else {
			// Keep filter-only output as Opus so existing AudioResource input-type
			// handling remains compatible with filtered playback.
			args.push("-c:a", "libopus", "-f", "opus", "-ar", "48000", "-ac", "2", "pipe:1");
		}

		const controller = new AbortController();
		this.ffmpegAbortController = controller;

		const proc = spawn(ffmpegPath, args, {
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		});
		this.ffmpegProcess = proc;

		if (generation !== this.ffmpegGeneration) {
			try { proc.kill("SIGKILL"); } catch {}
			throw new Error("FFmpeg process superseded");
		}

		const output = proc.stdout;
		if (!output) {
			try { proc.kill("SIGKILL"); } catch {}
			throw new Error("FFmpeg stdout unavailable");
		}
		this.ffmpegOutput = output;

		const cleanup = () => {
			if (this.ffmpegProcess === proc) this.ffmpegProcess = null;
			if (this.ffmpegOutput === output) this.ffmpegOutput = null;
			if (this.ffmpegAbortController === controller) this.ffmpegAbortController = null;
			if (typeof sourceStream !== "string") {
				try { sourceStream.unpipe(proc.stdin!); } catch {}
			}
		};

		const abort = () => {
			cleanup();
			try {
				if (proc.stdin && !proc.stdin.destroyed) proc.stdin.destroy();
			} catch {}
			try {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			} catch {}
		};

		controller.signal.addEventListener("abort", abort, { once: true });
		proc.once("error", (error) => {
			this.debug(`FFmpeg process error: ${error.message}`);
			cleanup();
		});
		proc.once("close", () => cleanup());
		proc.stdin?.on("error", (error: Error) => {
			if ((error as any).code !== "EPIPE") this.debug(`FFmpeg stdin error: ${error.message}`);
		});
		output.once("close", () => {
			if (this.ffmpegProcess === proc) {
				try {
					if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				} catch {}
			}
			cleanup();
		});
		output.once("error", (error: Error) => {
			this.debug(`FFmpeg stdout error: ${error.message}`);
			abort();
		});

		if (typeof sourceStream !== "string") sourceStream.pipe(proc.stdin!);

		return {
			...streamInfo,
			stream: output,
			wasRecreated,
		};
	}
}
