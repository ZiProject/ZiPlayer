import type { StreamInfo, Track, TrackMiddleware, TrackMiddlewareContext } from "../types";
import type { PlaybackSession } from "./PlaybackSession";
import type { PreloadManager } from "./PreloadManager";

export interface TrackLoaderContext extends TrackMiddlewareContext {}
export type TrackStreamResolver = (
	track: Track,
	session: PlaybackSession,
) => Promise<StreamInfo | null | undefined> | StreamInfo | null | undefined;
export interface TrackLoadResult {
	track: Track;
	stream: StreamInfo;
	sessionId: number;
	retry: number;
	usedFallback: boolean;
}
export interface TrackLoadAttemptContext {
	track: Track;
	session: PlaybackSession;
	retry: number;
	qualityReduced: boolean;
	usedPreload: boolean;
	reason?: unknown;
}
export interface TrackRecoveryPolicy {
	enabled?: boolean;
	maxRetries?: number;
	retryDelayMs?: number;
	reusePreloadFirst?: boolean;
	reduceQualityOnRetry?: boolean;
	controlledSkipThreshold?: number;
}
export interface TrackLoaderOptions {
	middleware?: TrackMiddleware[];
	context: TrackLoaderContext;
	resolvers?: TrackStreamResolver[];
	preloadManager?: PreloadManager;
	recovery?: TrackRecoveryPolicy;
	debug?: (message?: any, ...optionalParams: any[]) => void;
}
export class TrackLoader {
	private readonly middleware: TrackMiddleware[];
	private readonly context: TrackLoaderContext;
	private readonly resolvers: TrackStreamResolver[];
	private readonly preloadManager?: PreloadManager;
	private readonly recovery: Required<TrackRecoveryPolicy>;
	private readonly debugLog: (message?: any, ...optionalParams: any[]) => void;
	private readonly failures = new Map<string, number>();
	constructor(options: TrackLoaderOptions) {
		this.middleware = [...(options.middleware ?? [])];
		this.context = options.context;
		this.resolvers = [...(options.resolvers ?? [])];
		this.preloadManager = options.preloadManager;
		this.recovery = {
			enabled: options.recovery?.enabled ?? true,
			maxRetries: Math.max(0, options.recovery?.maxRetries ?? 2),
			retryDelayMs: Math.max(0, options.recovery?.retryDelayMs ?? 900),
			reusePreloadFirst: options.recovery?.reusePreloadFirst ?? true,
			reduceQualityOnRetry: options.recovery?.reduceQualityOnRetry ?? true,
			controlledSkipThreshold: Math.max(1, options.recovery?.controlledSkipThreshold ?? 3),
		};
		this.debugLog = options.debug ?? (() => undefined);
	}
	addResolver(resolver: TrackStreamResolver): () => void {
		this.resolvers.push(resolver);
		return () => {
			const i = this.resolvers.indexOf(resolver);
			if (i >= 0) this.resolvers.splice(i, 1);
		};
	}
	async load(track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		const stream = await this.resolve(track, session);
		return { track, stream, sessionId: session.id, retry: 0, usedFallback: false };
	}
	async loadWithRecovery(track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		this.assertActive(session);
		const key = this.key(track);
		let retry = this.failures.get(key) ?? 0;
		let lastError: unknown;
		if (this.recovery.reusePreloadFirst) {
			const preload = this.preloadManager?.takePreloaded(track);
			if (preload) {
				this.debugLog(`[TrackLoader] Using preloaded stream for: ${track.title}`);
				return {
					track,
					stream: { stream: preload.stream as any, type: "arbitrary" },
					sessionId: session.id,
					retry: 0,
					usedFallback: false,
				};
			}
		}
		const attempts = this.recovery.enabled ? this.recovery.maxRetries + 1 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			this.assertActive(session);
			try {
				const stream = await this.resolve(track, session);
				this.failures.delete(key);
				return { track, stream, sessionId: session.id, retry, usedFallback: retry > 0 };
			} catch (error) {
				lastError = error;
				if (this.isAbort(error) || !this.recovery.enabled || attempt >= this.recovery.maxRetries) break;
				retry++;
				this.failures.set(key, retry);
				this.debugLog(`[TrackLoader] Recovery attempt ${retry}/${this.recovery.maxRetries} for ${track.title}`, error);
				if (this.recovery.retryDelayMs > 0) await this.delay(this.recovery.retryDelayMs, session.signal);
			}
		}
		if (retry >= this.recovery.controlledSkipThreshold)
			this.debugLog(`[TrackLoader] Controlled skip threshold reached for ${track.title}`);
		throw lastError instanceof Error ? lastError : new Error(String(lastError ?? `Unable to load track: ${track.title}`));
	}
	async preloadNext(): Promise<void> {
		if (this.preloadManager) await this.preloadManager.preloadNextTrack();
	}
	hasPreload(track: Track): boolean {
		return this.preloadManager?.hasValidPreload(track) ?? false;
	}
	cancelPreload(): void {
		this.preloadManager?.cancelPreload();
	}
	async cancelPreloadSafely(): Promise<void> {
		await this.preloadManager?.safeCancelPreload();
	}
	resetRecovery(track?: Track): void {
		if (track) this.failures.delete(this.key(track));
		else this.failures.clear();
	}
	getRecoveryCount(track: Track): number {
		return this.failures.get(this.key(track)) ?? 0;
	}
	get recoveryPolicy(): Readonly<Required<TrackRecoveryPolicy>> {
		return this.recovery;
	}
	private async resolve(track: Track, session: PlaybackSession): Promise<StreamInfo> {
		this.assertActive(session);
		for (const middleware of this.middleware) {
			this.assertActive(session);
			const result = await middleware(track, this.context);
			if (result && result !== track) Object.assign(track, result);
		}
		this.assertActive(session);
		for (const resolver of this.resolvers) {
			this.assertActive(session);
			const stream = await resolver(track, session);
			if (!stream) continue;
			this.assertActive(session);
			return stream;
		}
		throw new Error(`No stream resolver could load track: ${track.title}`);
	}
	private assertActive(session: PlaybackSession): void {
		if (!session.isActive()) throw new DOMException("Playback session is no longer active", "AbortError");
	}
	private delay(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
			const timer = setTimeout(resolve, ms);
			const abort = () => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			};
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	private isAbort(error: unknown): boolean {
		return (
			(error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError")
		);
	}
	private key(track: Track): string {
		return track.id ?? track.url ?? `${track.source}:${track.title}`;
	}
}
