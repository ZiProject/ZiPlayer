import type { AudioFilter, StreamInfo, FilterControllerResourcePort, FilterControllerStreamType } from "../types";
import { PREDEFINED_FILTERS } from "../types";
import type { Readable } from "stream";
import { spawn, type ChildProcess } from "child_process";
import ffmpegStaticPath from "ffmpeg-static";
import type { Bus, PlayerAction } from "../structures/Bus";
import { StreamType } from "@discordjs/voice";
import { PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";
import fs from "node:fs";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;
import type { FilterControllerOptions } from "../types";

/** Per-player filter engine (ffmpeg pipeline + active filter list). Used both as the
 *  playback filter worker owned by the shared `FilterController` below, and standalone
 *  (bus-less) by SaveController for isolated export filtering. */
export class FilterEngine {
	private activeFilters: AudioFilter[] = [];
	private ffmpegOutput: Readable | null = null;
	private ffmpegProcess: ChildProcess | null = null;
	private ffmpegAbortController: AbortController | null = null;
	private ffmpegGeneration = 0;
	private seekStartupTimer: ReturnType<typeof setTimeout> | null = null;
	private lastFilteredStream: StreamInfo | null = null;
	public StreamType: FilterControllerStreamType = "arbitrary";

	constructor(
		private readonly resourcePort: FilterControllerResourcePort | undefined,
		private readonly debug: DebugFn = () => {},
		private readonly bus?: Bus,
		private readonly options: FilterControllerOptions = {},
		private readonly playerId?: string,
	) {
		if (options.initialFilters?.length) {
			void this.applyFilters(options.initialFilters).catch((error) =>
				this.debug("[FilterController] Initial filter error:", error),
			);
		}
	}

	public async handleAction(action: PlayerAction, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		switch (action.type) {
			case "FILTER_SET_SOURCE_TYPE":
				this.setSourceStreamType(action.streamType);
				return;
			case "FILTER_APPLY_AND_SEEK":
				this.lastFilteredStream = await this.applyFiltersAndSeek(action.streamInfo, action.position ?? -1);
				return;
		}
	}

	public setSourceStreamType(type: string): void {
		this.StreamType = type === "webm/opus" || type === "ogg/opus" || type === "mp3" ? type : "arbitrary";
		this.debug(`Source stream type set to: ${this.StreamType}`);
	}

	public destroy(): void {
		this.activeFilters = [];
		this.teardownFFmpeg();
		this.lastFilteredStream = null;
	}

	private teardownFFmpeg(): void {
		this.ffmpegGeneration++;
		if (this.seekStartupTimer) clearTimeout(this.seekStartupTimer);
		this.seekStartupTimer = null;
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

	public get lastFilteredStreamValue(): StreamInfo | null {
		return this.lastFilteredStream;
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
		if (PREDEFINED_FILTERS[filter]) return PREDEFINED_FILTERS[filter];
		if (!isSafeCustomFilter(filter)) {
			this.debug(`Rejected unsafe custom filter: ${filter.slice(0, 80)}`);
			return undefined;
		}
		return {
			name: filter,
			description: "Custom filter",
			ffmpegFilter: filter,
			category: "custom",
		};
	}

	public async applyFilter(filter?: string | AudioFilter): Promise<boolean> {
		if (!filter) return false;
		const audioFilter = this.resolveFilter(filter);
		if (!audioFilter || this.hasFilter(audioFilter.name)) return false;
		this.activeFilters.push(audioFilter);
		const refreshed = await this.refreshPlayerResource();
		if (!refreshed) {
			const index = this.activeFilters.lastIndexOf(audioFilter);
			if (index !== -1) this.activeFilters.splice(index, 1);
			return false;
		}
		this.options.onFilterApplied?.(audioFilter);
		this.debug(`Applied filter: ${audioFilter.name} - ${audioFilter.description}`);
		return true;
	}

	public async applyFilters(filters: (string | AudioFilter)[]): Promise<boolean> {
		let changed = false,
			allApplied = true;
		const newlyAdded: AudioFilter[] = [];
		for (const filter of filters) {
			const audioFilter = this.resolveFilter(filter);
			if (!audioFilter) {
				allApplied = false;
				continue;
			}
			if (this.hasFilter(audioFilter.name)) continue;
			this.activeFilters.push(audioFilter);
			newlyAdded.push(audioFilter);
			changed = true;
		}
		if (!changed) return allApplied;
		const refreshed = await this.refreshPlayerResource();
		if (!refreshed) {
			for (const added of newlyAdded) {
				const idx = this.activeFilters.lastIndexOf(added);
				if (idx !== -1) this.activeFilters.splice(idx, 1);
			}
			return false;
		}
		for (const added of newlyAdded) {
			this.options.onFilterApplied?.(added);
		}
		return allApplied;
	}

	public async removeFilter(filterName: string): Promise<boolean> {
		const index = this.activeFilters.findIndex((filter) => filter.name === filterName);
		if (index === -1) return false;
		const removed = this.activeFilters.splice(index, 1)[0];
		this.options.onFilterRemoved?.(removed);
		this.debug(`Removed filter: ${filterName}`);
		return this.refreshPlayerResource();
	}

	public async clearAll(): Promise<boolean> {
		const count = this.activeFilters.length;
		this.activeFilters = [];
		if (count > 0) this.options.onFiltersCleared?.();
		this.debug(`Cleared ${count} filters`);
		return this.refreshPlayerResource();
	}
	public clearFilters(): Promise<boolean> {
		return this.clearAll();
	}

	private refreshPlayerResource(): Promise<boolean> {
		if (this.bus && this.playerId)
			return this.bus
				.requestRpc(this.playerId, PLAYER_RPC.playbackRefreshResource, { position: 0 })
				.then(() => true)
				.catch(() => false);
		return this.resourcePort?.refreshPlayerResource() ?? Promise.resolve(false);
	}

	public async applyFiltersAndSeek(streamInfo: StreamInfo, position = -1): Promise<StreamInfo & { wasRecreated?: boolean }> {
		this.teardownFFmpeg();
		const generation = ++this.ffmpegGeneration;
		const hasSeek = position >= 0;

		if (hasSeek && streamInfo.recreate) {
			const recreated = await streamInfo.recreate(position);
			if (!recreated) throw new Error("Stream recreation returned no stream");
			if (generation !== this.ffmpegGeneration) {
				recreated.destroy();
				throw new Error("FFmpeg generation outdated");
			}
			const result = { ...streamInfo, stream: recreated, url: undefined, inputType: StreamType.Arbitrary, wasRecreated: true };
			this.lastFilteredStream = result;
			return result;
		}

		// Prefer a seekable URL when one exists. If the resolver only exposes a
		// Readable, keep the legacy pipe-based seek path for backwards compatibility.
		// A pipe cannot seek at the input level, so FFmpeg must receive the stream
		// from the beginning and seek after input processing, as the old implementation did.
		const source: Readable | string | null =
			hasSeek ? streamInfo.url || streamInfo.stream || null : streamInfo.stream || streamInfo.url || null;
		if (!source) {
			if (hasSeek) throw new Error("Cannot seek stream: resolver did not provide a stream, seekable URL, or recreate(position)");
			throw new Error("No source stream or URL available");
		}

		const sourceStream: Readable | string = source;
		const wasRecreated = false;
		if (generation !== this.ffmpegGeneration) throw new Error("FFmpeg generation outdated");
		const filterString = this.getFilterString();
		const ffmpegSeekSeconds = hasSeek ? (position / 1000).toFixed(3) : null;
		if (!hasSeek && !filterString) {
			const result = { ...streamInfo, stream: typeof sourceStream === "string" ? undefined : sourceStream, wasRecreated };
			this.lastFilteredStream = result;
			return result;
		}

		const candidates = [this.options.ffmpegPath, process.env.FFMPEG_PATH, ffmpegStaticPath, "ffmpeg"];
		const executable =
			candidates.find((path) => {
				if (!path) return false;
				if (path === "ffmpeg") return true;
				return fs.existsSync(path);
			}) || "ffmpeg";

		this.debug(`Using FFmpeg: ${executable}`);
		this.debug(
			`FFmpeg input: ${typeof sourceStream === "string" ? "seekable URL" : "readable stream"}${hasSeek ? `, seek=${ffmpegSeekSeconds}s` : ""}`,
		);

		const args = ["-hide_banner", "-loglevel", "error"];
		if (typeof sourceStream === "string") {
			// Fast input seek for a real seekable source.
			if (ffmpegSeekSeconds !== null) args.push("-ss", ffmpegSeekSeconds);
			args.push("-i", sourceStream);
		} else {
			args.push("-i", "pipe:0");
			// Legacy fallback: the input is a non-seekable pipe, so retain the old
			// output-side seek instead of rejecting the operation.
			if (ffmpegSeekSeconds !== null) args.push("-ss", ffmpegSeekSeconds);
		}
		if (filterString) args.push("-af", filterString);
		const inputType = hasSeek ? StreamType.Raw : StreamType.OggOpus;
		if (hasSeek) args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");
		else args.push("-c:a", "libopus", "-f", "opus", "-ar", "48000", "-ac", "2", "pipe:1");
		const controller = new AbortController();
		this.ffmpegAbortController = controller;
		const proc = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		this.ffmpegProcess = proc;
		const output = proc.stdout;
		if (!output) throw new Error("FFmpeg stdout unavailable");
		this.ffmpegOutput = output;
		(output as Readable & { inputType?: StreamType }).inputType = inputType;
		const cleanup = () => {
			if (this.seekStartupTimer) clearTimeout(this.seekStartupTimer);
			this.seekStartupTimer = null;
			if (this.ffmpegProcess === proc) this.ffmpegProcess = null;
			if (this.ffmpegOutput === output) this.ffmpegOutput = null;
			if (this.ffmpegAbortController === controller) this.ffmpegAbortController = null;
		};
		let processingFailed = false;
		const failProcessing = (error: Error) => {
			if (processingFailed || generation !== this.ffmpegGeneration) return;
			processingFailed = true;
			this.debug(`FFmpeg seek processing failed: ${error.message}`);
			const hadFilters = this.activeFilters.length > 0;
			this.activeFilters = [];
			this.lastFilteredStream = null;
			this.teardownFFmpeg();
			if (hadFilters) this.options.onFiltersCleared?.();
			this.options.onProcessingError?.(error);
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
			if (hasSeek) failProcessing(error);
			cleanup();
		});
		proc.once("close", (code, signal) => {
			if (hasSeek && !processingFailed && code !== 0)
				failProcessing(new Error(`FFmpeg exited before seek completed (code=${code ?? "null"}, signal=${signal ?? "none"})`));
			cleanup();
		});
		if (hasSeek) {
			const timeoutMs = Math.max(5000, this.options.seekStartupTimeoutMs ?? 60000);
			this.seekStartupTimer = setTimeout(() => {
				failProcessing(new Error(`FFmpeg produced no seek output within ${timeoutMs}ms`));
			}, timeoutMs);
			output.once("data", () => {
				if (this.seekStartupTimer) clearTimeout(this.seekStartupTimer);
				this.seekStartupTimer = null;
			});
		}
		output.once("close", () => {
			if (this.ffmpegProcess === proc)
				try {
					proc.kill("SIGKILL");
				} catch {}
			cleanup();
		});
		output.once("error", (error: Error) => {
			this.debug(`FFmpeg stdout error: ${error.message}`);
			if (hasSeek) failProcessing(error);
			abort();
		});
		if (typeof sourceStream !== "string") {
			const stdin = proc.stdin!;
			// ffmpeg may exit early (bad filter, missing codec, killed). Writing to its closed stdin
			// emits EPIPE, which would be an uncaught 'error' event and crash the whole process.
			stdin.on("error", (error: Error) => this.debug(`FFmpeg stdin error: ${error.message}`));
			const onSourceError = (error: Error) => {
				this.debug(`FFmpeg source stream error: ${error.message}`);
				try {
					stdin.end();
				} catch {}
			};
			sourceStream.on("error", onSourceError);
			proc.once("close", () => {
				sourceStream.off("error", onSourceError);
				try {
					sourceStream.unpipe(stdin);
				} catch {}
			});
			sourceStream.pipe(stdin);
		}
		const result = { ...streamInfo, stream: output, inputType, wasRecreated };
		this.lastFilteredStream = result;
		return result;
	}
}

/** Shared, singleton controller: owns the playback filter pipeline for every player
 *  (registered on the bus), keyed by playerId. */
/** FFmpeg filters that read local files / URLs or open sockets. Never accepted from a bare string. */
const UNSAFE_FILTER_NAMES =
	"a?movie|a?sendcmd|a?zmq|ladspa|lv2|sofalizer|arnndn|dnn_processing|drawtext|subtitles|ass|lavfi|frei0r|ocr|geq|hls_playlist";
const UNSAFE_FILTER_PATTERN = new RegExp(`(?<![A-Za-z0-9_])(?:${UNSAFE_FILTER_NAMES})(?![A-Za-z0-9_])`, "i");
const MAX_CUSTOM_FILTER_LENGTH = 1000;

/**
 * Validate a custom filter supplied as a raw string (e.g. from user input). Predefined filters and
 * explicit AudioFilter objects are developer-controlled and are not checked here.
 */
export function isSafeCustomFilter(filter: string): boolean {
	if (!filter || filter.length > MAX_CUSTOM_FILTER_LENGTH) return false;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f]/.test(filter)) return false;
	return !UNSAFE_FILTER_PATTERN.test(filter);
}

export class FilterController {
	private readonly engines = new Map<string, FilterEngine>();

	constructor(private readonly bus: Bus) {
		bus.onAction((action, context) => {
			void this.engines.get(context.playerId)?.handleAction(action, context.signal);
		});
		bus.registerQuery(PLAYER_QUERY.filterState, (playerId) => this.engines.get(playerId) ?? null);
		bus.registerQuery(PLAYER_QUERY.filterString, (playerId) => this.engines.get(playerId)?.getFilterString() ?? "");
		bus.registerQuery(PLAYER_QUERY.filteredStream, (playerId) => this.engines.get(playerId)?.lastFilteredStreamValue ?? null);
		bus.registerQuery(
			PLAYER_QUERY.filterList,
			(playerId) =>
				this.engines
					.get(playerId)
					?.getActiveFilters()
					.map((f) => f.name) ?? [],
		);
		bus.registerQuery(PLAYER_QUERY.filters, (playerId) => this.engines.get(playerId)?.getActiveFilters() ?? []);
		bus.registerRpc(
			PLAYER_RPC.filterList,
			(_req, ctx) =>
				this.engines
					.get(ctx.playerId)
					?.getActiveFilters()
					.map((f) => f.name) ?? [],
		);
		bus.registerRpc<{ filter: string; value: unknown }, any>(PLAYER_RPC.filterSet, async ({ filter, value }, ctx) => {
			const engine = this.engines.get(ctx.playerId);
			if (!engine) return false;
			const enabled =
				typeof value === "string" ? !["", "false", "0", "off", "no"].includes(value.trim().toLowerCase()) : Boolean(value);
			return enabled ? engine.applyFilter(filter) : engine.removeFilter(filter);
		});
	}

	attach(
		playerId: string,
		resourcePort: FilterControllerResourcePort | undefined,
		debug: DebugFn = () => {},
		options: FilterControllerOptions = {},
	): void {
		if (this.engines.has(playerId)) this.detach(playerId);
		this.engines.set(playerId, new FilterEngine(resourcePort, debug, this.bus, options, playerId));
	}
	detach(playerId: string): void {
		this.engines.get(playerId)?.destroy();
		this.engines.delete(playerId);
	}
}
