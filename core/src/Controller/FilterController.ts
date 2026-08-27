import type { AudioFilter, StreamInfo } from "../types";
import { PREDEFINED_FILTERS } from "../types";
import type { Readable } from "stream";
import { spawn, type ChildProcess } from "child_process";
import ffmpegPath from "ffmpeg-static";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;
export type FilterControllerStreamType = "webm/opus" | "ogg/opus" | "arbitrary" | "mp3";

export interface FilterControllerResourcePort {
	refreshPlayerResource(position?: number): Promise<boolean>;
}

/** Owns filter state and the FFmpeg lifecycle without owning Player. */
export class FilterController {
	private activeFilters: AudioFilter[] = [];
	private ffmpegOutput: Readable | null = null;
	private currentInputStream: Readable | string | null = null;
	private ffmpegProcess: ChildProcess | null = null;
	private ffmpegAbortController: AbortController | null = null;
	private ffmpegGeneration = 0;
	public StreamType: FilterControllerStreamType = "arbitrary";

	constructor(
		private readonly resourcePort: FilterControllerResourcePort,
		private readonly debug: DebugFn = () => {},
	) {}

	public setSourceStreamType(type: string): void {
		this.StreamType = type === "webm/opus" || type === "ogg/opus" || type === "mp3" ? type : "arbitrary";
		this.debug(`Source stream type set to: ${this.StreamType}`);
	}

	public destroy(): void {
		this.activeFilters = [];
		this.teardownFFmpeg();
		this.currentInputStream = null;
	}

	private teardownFFmpeg(): void {
		this.ffmpegGeneration++;
		this.ffmpegAbortController?.abort();
		this.ffmpegAbortController = null;
		const output = this.ffmpegOutput;
		this.ffmpegOutput = null;
		if (output && !output.destroyed)
			try {
				output.destroy();
			} catch {}
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
		return typeof filter === "string" ? PREDEFINED_FILTERS[filter] : filter;
	}

	public async applyFilter(filter?: string | AudioFilter): Promise<boolean> {
		if (!filter) return false;
		const audioFilter = this.resolveFilter(filter);
		if (!audioFilter || this.hasFilter(audioFilter.name)) return false;
		this.activeFilters.push(audioFilter);
		this.debug(`Applied filter: ${audioFilter.name} - ${audioFilter.description}`);
		return this.resourcePort.refreshPlayerResource();
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
			if (this.hasFilter(audioFilter.name)) continue;
			this.activeFilters.push(audioFilter);
			changed = true;
		}
		if (!changed) return allApplied;
		return allApplied && (await this.resourcePort.refreshPlayerResource());
	}

	public async removeFilter(filterName: string): Promise<boolean> {
		const index = this.activeFilters.findIndex((filter) => filter.name === filterName);
		if (index === -1) return false;
		this.activeFilters.splice(index, 1);
		this.debug(`Removed filter: ${filterName}`);
		return this.resourcePort.refreshPlayerResource();
	}

	public async clearAll(): Promise<boolean> {
		const count = this.activeFilters.length;
		this.activeFilters = [];
		this.debug(`Cleared ${count} filters`);
		return this.resourcePort.refreshPlayerResource();
	}

	public async applyFiltersAndSeek(streamInfo: StreamInfo, position = -1): Promise<StreamInfo & { wasRecreated?: boolean }> {
		const generation = ++this.ffmpegGeneration;
		this.teardownFFmpeg();
		const source = streamInfo.stream || streamInfo.url;
		if (!source) throw new Error("No source stream or URL available");
		let sourceStream: Readable | string = source;
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
		if (!hasSeek && !filterString)
			return { ...streamInfo, stream: typeof sourceStream === "string" ? undefined : sourceStream, wasRecreated };
		if (!ffmpegPath) throw new Error("FFmpeg binary not found");
		const args = ["-hide_banner", "-loglevel", "error"];
		const seekSeconds = hasSeek ? (position / 1000).toFixed(3) : null;
		if (typeof sourceStream === "string") {
			if (seekSeconds !== null) args.push("-ss", seekSeconds);
			args.push("-i", sourceStream);
		} else {
			args.push("-i", "pipe:0");
			if (seekSeconds !== null) args.push("-ss", seekSeconds);
		}
		if (filterString) args.push("-af", filterString);
		if (hasSeek) args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");
		else args.push("-c:a", "libopus", "-f", "opus", "-ar", "48000", "-ac", "2", "pipe:1");
		const controller = new AbortController();
		this.ffmpegAbortController = controller;
		const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		this.ffmpegProcess = proc;
		const output = proc.stdout;
		if (!output) throw new Error("FFmpeg stdout unavailable");
		this.ffmpegOutput = output;
		const cleanup = () => {
			if (this.ffmpegProcess === proc) this.ffmpegProcess = null;
			if (this.ffmpegOutput === output) this.ffmpegOutput = null;
			if (this.ffmpegAbortController === controller) this.ffmpegAbortController = null;
		};
		const abort = () => {
			cleanup();
			try {
				proc.stdin?.destroy();
			} catch {}
			try {
				proc.kill("SIGKILL");
			} catch {}
		};
		controller.signal.addEventListener("abort", abort, { once: true });
		proc.once("error", (error) => {
			this.debug(`FFmpeg process error: ${error.message}`);
			cleanup();
		});
		proc.once("close", cleanup);
		output.once("close", () => {
			if (this.ffmpegProcess === proc)
				try {
					proc.kill("SIGKILL");
				} catch {}
			cleanup();
		});
		output.once("error", (error: Error) => {
			this.debug(`FFmpeg stdout error: ${error.message}`);
			abort();
		});
		if (typeof sourceStream !== "string") sourceStream.pipe(proc.stdin!);
		return { ...streamInfo, stream: output, wasRecreated };
	}
}
