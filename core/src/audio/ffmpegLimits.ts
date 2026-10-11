import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ALLOWED_SAMPLE_RATES = [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000] as const;
export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 20;
export const GAIN_LINEAR_MIN = 0;
export const GAIN_LINEAR_MAX = 10;
export const CHANNELS_MIN = 1;
export const CHANNELS_MAX = 8;
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024;
export const MAX_BUFFER_BYTES_CAP = 8 * 1024 * 1024;
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_FFMPEG_THREADS = 1;
export const KILL_GRACE_MS = 2_000;

export function defaultFfmpegConcurrency(): number {
	const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 2;
	return Math.max(2, cpus);
}

type Waiter = {
	limit: number;
	signal?: AbortSignal;
	resolve: () => void;
	reject: (error: Error) => void;
	onAbort?: () => void;
};

class FfmpegProcessGate {
	public running = 0;
	public queued = 0;
	public max = defaultFfmpegConcurrency();
	private readonly waiters: Waiter[] = [];

	public configure(max: number | null | undefined): void {
		if (max == null) {
			this.max = defaultFfmpegConcurrency();
		} else {
			if (!Number.isInteger(max) || max <= 0) throw new TypeError("maxConcurrentProcesses must be a positive integer");
			this.max = max;
		}
		this.pump();
	}

	public stats(): { running: number; queued: number; max: number } {
		return { running: this.running, queued: this.queued, max: this.max };
	}

	public acquire(signal?: AbortSignal, limit?: number): Promise<() => void> {
		const effectiveLimit = limit ?? this.max;
		if (signal?.aborted) return Promise.reject(abortError());
		if (this.running < effectiveLimit && this.waiters.length === 0) {
			this.running++;
			return Promise.resolve(() => this.release());
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = {
				limit: effectiveLimit,
				signal,
				resolve: () => {
					this.queued--;
					this.running++;
					resolve(() => this.release());
				},
				reject: (error) => {
					this.queued--;
					reject(error);
				},
			};
			waiter.onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index === -1) return;
				this.waiters.splice(index, 1);
				waiter.reject(abortError());
			};
			if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
			this.queued++;
			if (this.queued >= this.max) {
				// Intentionally noisy: a long queue means Discord crossfade plus extra players are piling up.
				console.warn(`[ziplayer] FFmpeg process queue length is ${this.queued} (running ${this.running}/${this.max})`);
			}
		});
	}

	private release(): void {
		this.running = Math.max(0, this.running - 1);
		this.pump();
	}

	private pump(): void {
		while (this.waiters.length > 0) {
			const next = this.waiters[0];
			const limit = Math.min(next.limit, this.max);
			if (this.running >= limit) break;
			this.waiters.shift();
			next.signal?.removeEventListener("abort", next.onAbort!);
			next.resolve();
		}
	}
}

const gate = new FfmpegProcessGate();

export function configureFfmpegConcurrency(max: number | null | undefined): void {
	gate.configure(max);
}

export function getFfmpegProcessStats(): { running: number; queued: number; max: number } {
	return gate.stats();
}

export function acquireFfmpegSlot(signal?: AbortSignal, limit?: number): Promise<() => void> {
	return gate.acquire(signal, limit);
}

export function resolveFfmpegExecutable(explicit?: string | null): string {
	const executableNames = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
	const searchRoots = [
		process.cwd(),
		__dirname,
		path.resolve(__dirname, ".."),
		path.resolve(__dirname, "..", ".."),
		path.resolve(process.cwd(), "core"),
		path.resolve(process.cwd(), ".."),
		process.env.HOME,
		process.env.USERPROFILE,
	].filter((value): value is string => Boolean(value));
	const seen = new Set<string>();
	for (const root of searchRoots) {
		if (!root || seen.has(root)) continue;
		seen.add(root);
		for (const name of executableNames) {
			const direct = path.join(root, name);
			if (fs.existsSync(direct)) return direct;
		}
		for (const subpath of [
			path.join("node_modules", "ffmpeg-static"),
			path.join("core", "node_modules", "ffmpeg-static"),
			path.join("node_modules", ".bin"),
			path.join("core", "node_modules", ".bin"),
		]) {
			const base = path.join(root, subpath);
			if (!fs.existsSync(base)) continue;
			for (const name of executableNames) {
				const candidate = path.join(base, name);
				if (fs.existsSync(candidate)) return candidate;
			}
		}
	}
	const candidates = [explicit, process.env.FFMPEG_PATH, process.env.ffmpegPath, "ffmpeg"];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		if (trimmed === "ffmpeg" || trimmed === "ffmpeg.exe") return trimmed;
		if (fs.existsSync(trimmed)) return trimmed;
	}
	return "ffmpeg";
}

export function sanitizeFfmpegLog(text: string): string {
	return text
		.replace(/[A-Za-z]:\\[^\s]+/g, "[redacted]")
		.replace(/file:\/\/[^\s]+/gi, "[redacted]")
		.replace(/https?:\/\/[^\s]+/gi, "[redacted]")
		.replace(/(^|[\s"'])(\/?(?:home|Users|tmp|var|etc|root|opt)\/[^\s"']+)/g, "$1[redacted]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

function abortError(): Error {
	const error = new Error("FFmpeg process slot wait was aborted");
	error.name = "AbortError";
	return error;
}

export { gate as ffmpegProcessGate };
