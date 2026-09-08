import type { AudioFilter, StreamInfo, FilterControllerResourcePort, FilterControllerStreamType } from "../types";
import { PREDEFINED_FILTERS } from "../types";
import type { Readable } from "stream";
import { spawn, type ChildProcess } from "child_process";
import ffmpegStaticPath from "ffmpeg-static";
import type { PlayerBus, PlayerAction } from "../structures/PlayerBus";
import { StreamType } from "@discordjs/voice";
import fs from "node:fs";
import { NativePCMFilter, canUseNativePCM } from "./NativePCMFilter";
import { createNativeDecodedPCM } from "./NativeDecodedPCM";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;

export interface FilterControllerOptions {
	/** Explicit FFmpeg executable path used only for encoded/unsupported sources. */
	ffmpegPath?: string | null;
	/** Maximum time to wait for FFmpeg to emit the first seek output bytes. */
	seekStartupTimeoutMs?: number;
	onFilterApplied?: (filter: AudioFilter) => void;
	onFilterRemoved?: (filter: AudioFilter) => void;
	onFiltersCleared?: () => void;
	onProcessingError?: (error: Error) => void;
}

const NATIVE_DECODER_EXTENSIONS = /\.(wav|wave|mp3|flac|ogg|oga)(?:\?.*)?$/i;

function canUseNativeDecoder(streamInfo: StreamInfo): boolean {
	if (streamInfo.type === "mp3" || streamInfo.type === "ogg/vorbis" || streamInfo.type === "vorbis") return true;
	if (streamInfo.inputType === StreamType.Raw) return false;
	return typeof streamInfo.url === "string" && NATIVE_DECODER_EXTENSIONS.test(streamInfo.url);
}

export class FilterController {
	private activeFilters: AudioFilter[] = [];
	private ffmpegOutput: Readable | null = null;
	private currentInputStream: Readable | string | null = null;
	private ffmpegProcess: ChildProcess | null = null;
	private ffmpegAbortController: AbortController | null = null;
	private ffmpegGeneration = 0;
	private seekStartupTimer: ReturnType<typeof setTimeout> | null = null;
	private nativePCM: NativePCMFilter | null = null;
	private lastFilteredStream: StreamInfo | null = null;
	private readonly detachAction?: () => void;
	private readonly detachQueries: Array<() => void> = [];
	public StreamType: FilterControllerStreamType = "arbitrary";

	constructor(
		private readonly resourcePort: FilterControllerResourcePort | undefined,
		private readonly debug: DebugFn = () => {},
		private readonly bus?: PlayerBus,
		private readonly options: FilterControllerOptions = {},
	) {
		if (bus) {
			this.detachAction = bus.onAction((action, context) => this.handleAction(action, context.signal));
			this.detachQueries.push(
				bus.registerQuery("filterString", () => this.getFilterString()),
				bus.registerQuery("filteredStream", () => this.lastFilteredStream),
			);
		}
	}

	private async handleAction(action: PlayerAction, signal: AbortSignal): Promise<void> {
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
		this.detachAction?.();
		for (const detach of this.detachQueries.splice(0)) detach();
		this.activeFilters = [];
		this.teardownNativePCM();
		this.teardownFFmpeg();
		this.currentInputStream = null;
		this.lastFilteredStream = null;
	}

	private teardownNativePCM(): void {
		const native = this.nativePCM;
		this.nativePCM = null;
		if (native) {
			try {
				native.destroy();
			} catch {}
		}
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
			try { if (process.stdin && !process.stdin.destroyed) process.stdin.destroy(); } catch {}
			try { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); } catch {}
		}
	}

	public getFilterString(): string { return this.activeFilters.map((filter) => filter.ffmpegFilter).join(","); }
	public getActiveFilters(): AudioFilter[] { return [...this.activeFilters]; }
	public hasFilter(filterName: string): boolean { return this.activeFilters.some((filter) => filter.name === filterName); }
	public getAvailableFilters(): AudioFilter[] { return Object.values(PREDEFINED_FILTERS); }
	public getFiltersByCategory(category: string): AudioFilter[] { return Object.values(PREDEFINED_FILTERS).filter((filter) => filter.category === category); }
	private resolveFilter(filter: string | AudioFilter): AudioFilter | undefined { return typeof filter === "string" ? PREDEFINED_FILTERS[filter] : filter; }

	private nativeFilterUpdate(): boolean {
		if (!this.nativePCM || !canUseNativePCM(this.activeFilters)) return false;
		try { this.nativePCM.setFilters(this.activeFilters); return true; }
		catch (error) { this.debug(`Native DSP filter update failed: ${(error as Error).message}`); return false; }
	}

	public async applyFilter(filter?: string | AudioFilter): Promise<boolean> {
		if (!filter) return false;
		const audioFilter = this.resolveFilter(filter);
		if (!audioFilter || this.hasFilter(audioFilter.name)) return false;
		this.activeFilters.push(audioFilter);
		this.options.onFilterApplied?.(audioFilter);
		this.debug(`Applied filter: ${audioFilter.name} - ${audioFilter.description}`);
		if (this.nativePCM && this.nativeFilterUpdate()) return true;
		if (this.nativePCM) this.teardownNativePCM();
		return this.refreshPlayerResource();
	}

	public async applyFilters(filters: (string | AudioFilter)[]): Promise<boolean> {
		let changed = false, allApplied = true;
		for (const filter of filters) {
			const audioFilter = this.resolveFilter(filter);
			if (!audioFilter) { allApplied = false; continue; }
			if (this.hasFilter(audioFilter.name)) continue;
			this.activeFilters.push(audioFilter); this.options.onFilterApplied?.(audioFilter); changed = true;
		}
		if (!changed) return allApplied;
		if (this.nativePCM && this.nativeFilterUpdate()) return allApplied;
		if (this.nativePCM) this.teardownNativePCM();
		return allApplied && (await this.refreshPlayerResource());
	}

	public async removeFilter(filterName: string): Promise<boolean> {
		const index = this.activeFilters.findIndex((filter) => filter.name === filterName);
		if (index === -1) return false;
		const removed = this.activeFilters.splice(index, 1)[0];
		this.options.onFilterRemoved?.(removed); this.debug(`Removed filter: ${filterName}`);
		if (this.nativePCM && this.nativeFilterUpdate()) return true;
		if (this.nativePCM) this.teardownNativePCM();
		return this.refreshPlayerResource();
	}

	public async clearAll(): Promise<boolean> {
		const count = this.activeFilters.length; this.activeFilters = [];
		if (count > 0) this.options.onFiltersCleared?.(); this.debug(`Cleared ${count} filters`);
		if (this.nativePCM && this.nativeFilterUpdate()) return true;
		if (this.nativePCM) this.teardownNativePCM();
		return this.refreshPlayerResource();
	}

	private refreshPlayerResource(): Promise<boolean> {
		if (this.bus) return this.bus.requestRpc("playback.refreshResource", { position: 0 }).then(() => true).catch(() => false);
		return this.resourcePort?.refreshPlayerResource() ?? Promise.resolve(false);
	}

	private async applyNativePCM(streamInfo: StreamInfo, source: Readable, hasSeek: boolean, position: number): Promise<StreamInfo & { wasRecreated?: boolean }> {
		if (!canUseNativePCM(this.activeFilters)) throw new Error("active filter set is not supported by native DSP");
		if (hasSeek && !streamInfo.recreate && position > 0) throw new Error("Cannot seek a raw PCM stream without a seek-capable resolver");
		this.teardownNativePCM();
		const native = new NativePCMFilter(this.activeFilters); this.nativePCM = native; this.currentInputStream = source; source.pipe(native);
		native.once("error", (error) => { if (this.nativePCM === native) { this.debug(`Native DSP processing failed: ${error.message}`); this.nativePCM = null; this.options.onProcessingError?.(error); } });
		const result = { ...streamInfo, stream: native, url: undefined, inputType: StreamType.Raw, wasRecreated: hasSeek };
		this.lastFilteredStream = result; return result;
	}

	private async applyNativeDecoded(streamInfo: StreamInfo, source: Readable | string, position: number, wasRecreated: boolean): Promise<StreamInfo & { wasRecreated?: boolean }> {
		if (!canUseNativePCM(this.activeFilters)) throw new Error("active filter set is not supported by native DSP");
		this.teardownNativePCM();
		const native = await createNativeDecodedPCM(source, this.activeFilters, wasRecreated ? 0 : Math.max(0, position));
		this.nativePCM = native as NativePCMFilter; this.currentInputStream = source;
		native.once("error", (error) => { if (this.nativePCM === native) { this.debug(`Native decoder/DSP processing failed: ${error.message}`); this.nativePCM = null; this.options.onProcessingError?.(error); } });
		const result = { ...streamInfo, stream: native, url: undefined, inputType: StreamType.Raw, wasRecreated };
		this.lastFilteredStream = result; return result;
	}

	public async applyFiltersAndSeek(streamInfo: StreamInfo, position = -1): Promise<StreamInfo & { wasRecreated?: boolean }> {
		this.teardownNativePCM(); this.teardownFFmpeg();
		const generation = ++this.ffmpegGeneration; const hasSeek = position >= 0;

		if (hasSeek && streamInfo.recreate) {
			const recreated = await streamInfo.recreate(position);
			if (generation !== this.ffmpegGeneration) { recreated.destroy(); throw new Error("Filter processing generation outdated"); }
			if (!recreated) throw new Error("Stream recreation returned no stream");
			if (streamInfo.inputType === StreamType.Raw && canUseNativePCM(this.activeFilters)) return this.applyNativePCM(streamInfo, recreated, true, position);
			if (canUseNativeDecoder(streamInfo) && canUseNativePCM(this.activeFilters)) return this.applyNativeDecoded(streamInfo, recreated, 0, true);
			const result = { ...streamInfo, stream: recreated, url: undefined, inputType: StreamType.Arbitrary, wasRecreated: true };
			this.currentInputStream = recreated; this.lastFilteredStream = result; return result;
		}

		const source: Readable | string | null = hasSeek ? streamInfo.url || streamInfo.stream || null : streamInfo.stream || streamInfo.url || null;
		if (!source) { if (hasSeek) throw new Error("Cannot seek stream: resolver did not provide a stream, seekable URL, or recreate(position)"); throw new Error("No source stream or URL available"); }
		const sourceStream: Readable | string = source; const wasRecreated = false;
		if (generation !== this.ffmpegGeneration) throw new Error("Filter processing generation outdated");
		this.currentInputStream = sourceStream;
		if (streamInfo.inputType === StreamType.Raw && typeof sourceStream !== "string" && canUseNativePCM(this.activeFilters)) return this.applyNativePCM(streamInfo, sourceStream, hasSeek, position);
		if (canUseNativeDecoder(streamInfo) && canUseNativePCM(this.activeFilters)) return this.applyNativeDecoded(streamInfo, sourceStream, position, false);

		const filterString = this.getFilterString(); const ffmpegSeekSeconds = hasSeek ? (position / 1000).toFixed(3) : null;
		if (!hasSeek && !filterString) { const result = { ...streamInfo, stream: typeof sourceStream === "string" ? undefined : sourceStream, wasRecreated }; this.lastFilteredStream = result; return result; }
		const candidates = [this.options.ffmpegPath, process.env.FFMPEG_PATH, ffmpegStaticPath, "ffmpeg"];
		const executable = candidates.find((path) => { if (!path) return false; if (path === "ffmpeg") return true; return fs.existsSync(path); }) || "ffmpeg";
		this.debug(`Using FFmpeg compatibility path: ${executable}`);
		const args = ["-hide_banner", "-loglevel", "error"];
		if (typeof sourceStream === "string") { if (ffmpegSeekSeconds !== null) args.push("-ss", ffmpegSeekSeconds); args.push("-i", sourceStream); }
		else { args.push("-i", "pipe:0"); if (ffmpegSeekSeconds !== null) args.push("-ss", ffmpegSeekSeconds); }
		if (filterString) args.push("-af", filterString);
		const inputType = hasSeek ? StreamType.Raw : StreamType.OggOpus;
		if (hasSeek) args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"); else args.push("-c:a", "libopus", "-f", "opus", "-ar", "48000", "-ac", "2", "pipe:1");

		const controller = new AbortController(); this.ffmpegAbortController = controller;
		const proc = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); this.ffmpegProcess = proc;
		const output = proc.stdout; if (!output) throw new Error("FFmpeg stdout unavailable"); this.ffmpegOutput = output; (output as Readable & { inputType?: StreamType }).inputType = inputType;
		const cleanup = () => { if (this.seekStartupTimer) clearTimeout(this.seekStartupTimer); this.seekStartupTimer = null; if (this.ffmpegProcess === proc) this.ffmpegProcess = null; if (this.ffmpegOutput === output) this.ffmpegOutput = null; if (this.ffmpegAbortController === controller) this.ffmpegAbortController = null; };
		let processingFailed = false;
		const failProcessing = (error: Error) => { if (processingFailed || generation !== this.ffmpegGeneration) return; processingFailed = true; this.debug(`FFmpeg seek processing failed: ${error.message}`); const hadFilters = this.activeFilters.length > 0; this.activeFilters = []; this.lastFilteredStream = null; this.teardownFFmpeg(); if (hadFilters) this.options.onFiltersCleared?.(); this.options.onProcessingError?.(error); };
		const abort = () => { cleanup(); try { proc.stdin?.destroy(); } catch {} try { proc.kill("SIGKILL"); } catch {} };
		controller.signal.addEventListener("abort", abort, { once: true });
		proc.once("error", (error) => { this.debug(`FFmpeg process error: ${error.message}`); if (hasSeek) failProcessing(error); cleanup(); });
		proc.once("close", (code, signal) => { if (hasSeek && !processingFailed && code !== 0) failProcessing(new Error(`FFmpeg exited before seek completed (code=${code ?? "null"}, signal=${signal ?? "none"})`)); cleanup(); });
		if (hasSeek) { const timeoutMs = Math.max(5000, this.options.seekStartupTimeoutMs ?? 50000); this.seekStartupTimer = setTimeout(() => failProcessing(new Error(`FFmpeg produced no seek output within ${timeoutMs}ms`)), timeoutMs); output.once("data", () => { if (this.seekStartupTimer) clearTimeout(this.seekStartupTimer); this.seekStartupTimer = null; }); }
		output.once("close", () => { if (this.ffmpegProcess === proc) try { proc.kill("SIGKILL"); } catch {} cleanup(); });
		output.once("error", (error: Error) => { this.debug(`FFmpeg stdout error: ${error.message}`); if (hasSeek) failProcessing(error); abort(); });
		if (typeof sourceStream !== "string") sourceStream.pipe(proc.stdin!);
		const result = { ...streamInfo, stream: output, inputType, wasRecreated }; this.lastFilteredStream = result; return result;
	}
}
