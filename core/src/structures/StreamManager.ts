// src/managers/StreamManager.ts
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { Track } from "../types";

export interface ManagedStream {
	id: string;
	stream: Readable;
	track: Track;
	createdAt: number;
	lastAccessed: number;
	metadata: {
		source: string;
		isPreload: boolean;
		isRemote: boolean;
		priority: number;
	};
	listeners: {
		error: (err: Error) => void;
		close: () => void;
		end: () => void;
		drain?: () => void;
		pause?: () => void;
		resume?: () => void;
	};
	status: "active" | "paused" | "ended" | "error" | "destroyed";
	byteCount: number;
}

export interface StreamManagerOptions {
	maxConcurrentStreams?: number;
	streamTimeout?: number;
	maxListenersPerStream?: number;
	cleanupInterval?: number;
	enableMetrics?: boolean;
	autoDestroy?: boolean;
}

export class StreamManager extends EventEmitter {
	private streams = new Map<string, ManagedStream>();
	private suppressPrematureCloseErrors = new Set<string>();
	private options: Required<StreamManagerOptions>;
	private cleanupTimer: NodeJS.Timeout | null = null;
	private metrics = {
		totalStreamsCreated: 0,
		totalStreamsDestroyed: 0,
		activeStreams: 0,
		totalErrors: 0,
		totalBytesProcessed: 0,
	};

	constructor(options: StreamManagerOptions = {}) {
		super();
		this.setMaxListeners(50);

		this.options = {
			maxConcurrentStreams: 20,
			streamTimeout: 5 * 60 * 1000, // 5 minutes
			maxListenersPerStream: 15,
			cleanupInterval: 60000, // 1 minute
			enableMetrics: true,
			autoDestroy: true,
			...options,
		};

		if (this.options.cleanupInterval > 0) {
			this.startCleanupInterval();
		}

		this.debug("StreamManager initialized");
	}

	/**
	 * Register a new stream
	 */
	registerStream(stream: Readable, track: Track, metadata: Partial<ManagedStream["metadata"]> = {}): string {
		for (const existing of this.streams.values()) {
			if (existing.stream === stream) {
				existing.lastAccessed = Date.now();
				existing.track = track;
				existing.metadata = {
					...existing.metadata,
					source: track.source || existing.metadata.source || "unknown",
					...metadata,
				};
				this.debug(`Stream already managed, reusing ID: ${existing.id}`);
				return existing.id;
			}
		}

		const streamId = this.generateStreamId(track);

		// Check if stream already exists
		if (this.streams.has(streamId)) {
			this.debug(`Stream already exists for track: ${track.title}, destroying old one`);
			this.unregisterStream(streamId, true);
		}

		// Check concurrent limit
		while (this.streams.size >= this.options.maxConcurrentStreams) {
			const evicted = this.evictOldestStream();
			if (!evicted) break;
		}

		// Configure stream
		if (stream.setMaxListeners) {
			stream.setMaxListeners(this.options.maxListenersPerStream);
		}

		// Create listeners
		const listeners = this.createStreamListeners(streamId);

		// Apply listeners
		stream.on("error", listeners.error);
		stream.on("close", listeners.close);
		stream.on("end", listeners.end);
		stream.on("pause", listeners.pause!);
		stream.on("resume", listeners.resume!);
		stream.on("drain", listeners.drain!);

		// Create managed stream
		const managedStream: ManagedStream = {
			id: streamId,
			stream,
			track,
			createdAt: Date.now(),
			lastAccessed: Date.now(),
			metadata: {
				source: track.source || "unknown",
				isPreload: metadata.isPreload || false,
				priority: metadata.priority || 0,
				isRemote: metadata.isRemote || false,
				...metadata,
			},
			listeners,
			status: "active",
			byteCount: 0,
		};

		this.streams.set(streamId, managedStream);

		if (this.options.enableMetrics) {
			this.metrics.totalStreamsCreated++;
			this.metrics.activeStreams = this.streams.size;
		}

		// Setup data counter
		this.setupDataCounter(managedStream);

		this.debug(`Stream registered: ${track.title} (ID: ${streamId}), Total: ${this.streams.size}`);
		this.emit("streamRegistered", { streamId, track, metadata: managedStream.metadata });

		return streamId;
	}

	/**
	 * Create stream listeners
	 */
	private createStreamListeners(streamId: string): ManagedStream["listeners"] {
		return {
			error: (err: Error) => {
				const isPrematureClose = err?.message?.toLowerCase().includes("premature close");
				if (isPrematureClose && this.suppressPrematureCloseErrors.has(streamId)) {
					this.debug(`Ignored expected premature close [${streamId}] during controlled destroy`);
					this.suppressPrematureCloseErrors.delete(streamId);
					this.unregisterStream(streamId, false);
					return;
				}

				this.debug(`Stream error [${streamId}]:`, err);
				if (this.options.enableMetrics) {
					this.metrics.totalErrors++;
				}
				this.emit("streamError", { streamId, error: err });
				this.unregisterStream(streamId, true);
			},

			close: () => {
				this.debug(`Stream closed [${streamId}]`);
				const managed = this.streams.get(streamId);
				if (managed) {
					managed.status = "ended";
				}
				this.emit("streamClose", { streamId });
				this.unregisterStream(streamId, false);
			},

			end: () => {
				this.debug(`Stream ended [${streamId}]`);
				const managed = this.streams.get(streamId);
				if (managed) {
					managed.status = "ended";
				}
				this.emit("streamEnd", { streamId });
				this.unregisterStream(streamId, false);
			},

			pause: () => {
				const managed = this.streams.get(streamId);
				if (managed) {
					managed.status = "paused";
					this.emit("streamPaused", { streamId, track: managed.track });
				}
			},

			resume: () => {
				const managed = this.streams.get(streamId);
				if (managed) {
					managed.status = "active";
					managed.lastAccessed = Date.now();
					this.emit("streamResumed", { streamId, track: managed.track });
				}
			},

			drain: () => {
				const managed = this.streams.get(streamId);
				if (managed) {
					this.emit("streamDrained", { streamId, track: managed.track });
				}
			},
		};
	}

	/**
	 * Setup data counter for stream
	 */
	private setupDataCounter(managed: ManagedStream): void {
		let dataListener: (chunk: Buffer) => void;

		if (managed.stream.readable) {
			dataListener = (chunk: Buffer) => {
				managed.byteCount += chunk.length;
				if (this.options.enableMetrics) {
					this.metrics.totalBytesProcessed += chunk.length;
				}

				// Emit progress every ~1MB
				if (managed.byteCount % (1024 * 1024) < chunk.length) {
					this.emit("streamProgress", {
						streamId: managed.id,
						track: managed.track,
						bytes: managed.byteCount,
						megabytes: Math.floor(managed.byteCount / (1024 * 1024)),
					});
				}
			};

			managed.stream.on("data", dataListener);

			// Store data listener for cleanup
			(managed as any).dataListener = dataListener;
		}
	}

	/**
	 * Unregister a stream
	 */
	unregisterStream(streamId: string, forceDestroy: boolean = true): boolean {
		const managed = this.streams.get(streamId);
		if (!managed) {
			this.suppressPrematureCloseErrors.delete(streamId);
			return false;
		}

		this.debug(`Unregistering stream: ${managed.track.title} (${streamId})`);

		// Remove data listener
		const dataListener = (managed as any).dataListener;
		if (dataListener && managed.stream) {
			managed.stream.removeListener("data", dataListener);
		}

		// Remove all listeners
		const { listeners } = managed;
		const stream = managed.stream;

		if (stream) {
			stream.removeListener("error", listeners.error);
			stream.removeListener("close", listeners.close);
			stream.removeListener("end", listeners.end);
			stream.removeListener("pause", listeners.pause!);
			stream.removeListener("resume", listeners.resume!);
			stream.removeListener("drain", listeners.drain!);

			// Force destroy if needed
			if (forceDestroy && !stream.destroyed && typeof stream.destroy === "function") {
				try {
					this.suppressPrematureCloseErrors.add(streamId);
					stream.destroy();
					managed.status = "destroyed";
				} catch (err) {
					this.suppressPrematureCloseErrors.delete(streamId);
					this.debug(`Error destroying stream:`, err);
				}
			}
		}

		this.streams.delete(streamId);

		if (this.options.enableMetrics) {
			this.metrics.totalStreamsDestroyed++;
			this.metrics.activeStreams = this.streams.size;
		}

		this.emit("streamUnregistered", { streamId, track: managed.track, reason: forceDestroy ? "destroyed" : "natural" });
		this.suppressPrematureCloseErrors.delete(streamId);

		return true;
	}

	/**
	 * Get a stream by ID
	 */
	getStream(streamId: string): Readable | null {
		const managed = this.streams.get(streamId);
		if (managed && managed.status === "active") {
			managed.lastAccessed = Date.now();
			return managed.stream;
		}
		return null;
	}

	/**
	 * Like getStream() but accepts "paused" streams too.
	 * Used by refreshPlayerResource to reuse a source stream during seek.
	 * discordjs/voice pauses source streams on NoSubscriberBehavior which would
	 * make getStream() return null and force an unnecessary network fetch.
	 */
	getRawStream(streamId: string): Readable | null {
		const managed = this.streams.get(streamId);
		if (!managed) return null;
		// Only reject truly terminal states.
		if (managed.status === "destroyed" || managed.status === "ended" || managed.status === "error") return null;
		if (managed.stream.destroyed) return null;
		managed.lastAccessed = Date.now();
		return managed.stream;
	}
	
	/**
	 * Update stream metadata
	 */
	updateMetadata(streamId: string, metadata: Partial<ManagedStream["metadata"]>): boolean {
		const managed = this.streams.get(streamId);
		if (managed) {
			managed.metadata = { ...managed.metadata, ...metadata };
			managed.lastAccessed = Date.now();
			this.emit("streamMetadataUpdated", { streamId, metadata });
			return true;
		}
		return false;
	}

	/**
	 * Pause a stream
	 */
	pauseStream(streamId: string): boolean {
		const managed = this.streams.get(streamId);
		if (managed && managed.status === "active" && !managed.stream.isPaused()) {
			managed.stream.pause();
			managed.status = "paused";
			this.emit("streamPaused", { streamId, track: managed.track });
			return true;
		}
		return false;
	}

	/**
	 * Resume a stream
	 */
	resumeStream(streamId: string): boolean {
		const managed = this.streams.get(streamId);
		if (managed && managed.status === "paused") {
			managed.stream.resume();
			managed.status = "active";
			managed.lastAccessed = Date.now();
			this.emit("streamResumed", { streamId, track: managed.track });
			return true;
		}
		return false;
	}

	/**
	 * Evict oldest stream when limit reached
	 */
	private evictOldestStream(): boolean {
		// Evict lowest priority streams first
		const sorted = Array.from(this.streams.values()).sort((a, b) => a.metadata.priority - b.metadata.priority);

		for (const managed of sorted) {
			if (managed.metadata.isPreload && managed.metadata.priority < 5) {
				this.debug(`Evicting low priority preload stream: ${managed.track.title}`);
				this.unregisterStream(managed.id, true);
				return true;
			}
		}

		if (sorted.length > 0) {
			const fallback = sorted[0];
			this.debug(`Evicting fallback stream to enforce limit: ${fallback.track.title}`);
			this.unregisterStream(fallback.id, true);
			return true;
		}

		return false;
	}

	/**
	 * Cleanup expired streams
	 */
	private cleanupExpiredStreams(): void {
		const now = Date.now();
		let cleaned = 0;

		for (const [streamId, managed] of this.streams) {
			const age = now - managed.lastAccessed;

			if (age > this.options.streamTimeout) {
				this.debug(`Cleaning up expired stream: ${managed.track.title} (age: ${age}ms)`);
				this.unregisterStream(streamId, this.options.autoDestroy);
				cleaned++;
			}
		}

		if (cleaned > 0) {
			this.emit("cleanupCompleted", { cleaned, remaining: this.streams.size });
		}
	}

	/**
	 * Start automatic cleanup interval
	 */
	private startCleanupInterval(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}

		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredStreams();
		}, this.options.cleanupInterval);

		this.cleanupTimer.unref(); // Don't keep process alive
	}

	/**
	 * Stop cleanup interval
	 */
	stopCleanupInterval(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	/**
	 * Get all active streams
	 */
	getAllStreams(): ManagedStream[] {
		return Array.from(this.streams.values());
	}

	/**
	 * Get streams by status
	 */
	getStreamsByStatus(status: ManagedStream["status"]): ManagedStream[] {
		return Array.from(this.streams.values()).filter((s) => s.status === status);
	}

	/**
	 * Get stream by track ID (using track.id, track.url, or track.title as identifier)
	 */
	getStreamByTrack(trackId: string): Readable | null {
		for (const managed of this.streams.values()) {
			const managedTrackId = managed.track.id || managed.track.url || managed.track.title;
			if (managedTrackId === trackId && managed.status === "active") {
				managed.lastAccessed = Date.now();
				return managed.stream;
			}
		}
		return null;
	}

	/**
	 * Check if a stream exists for a given track ID
	 */
	hasStream(trackId: string): boolean {
		for (const managed of this.streams.values()) {
			const managedTrackId = managed.track.id || managed.track.url || managed.track.title;
			if (managedTrackId === trackId && managed.status === "active") {
				return true;
			}
		}
		return false;
	}
	/**
	 * Get stream count
	 */
	getStreamCount(): number {
		return this.streams.size;
	}

	/**
	 * Get metrics
	 */
	getMetrics(): typeof this.metrics {
		if (!this.options.enableMetrics) {
			return {
				totalStreamsCreated: 0,
				totalStreamsDestroyed: 0,
				activeStreams: 0,
				totalErrors: 0,
				totalBytesProcessed: 0,
			};
		}
		return { ...this.metrics };
	}

	/**
	 * Get statistics
	 */
	getStats(): {
		active: number;
		paused: number;
		ended: number;
		error: number;
		destroyed: number;
		total: number;
		bySource: Record<string, number>;
	} {
		const stats = {
			active: 0,
			paused: 0,
			ended: 0,
			error: 0,
			destroyed: 0,
			total: 0,
			bySource: {} as Record<string, number>,
		};

		for (const managed of this.streams.values()) {
			stats[managed.status]++;
			stats.total++;

			const source = managed.metadata.source;
			stats.bySource[source] = (stats.bySource[source] || 0) + 1;
		}

		return stats;
	}

	/**
	 * Destroy all streams
	 */
	destroyAll(force: boolean = true): void {
		this.debug(`Destroying all streams (${this.streams.size})`);

		for (const streamId of Array.from(this.streams.keys())) {
			this.unregisterStream(streamId, force);
		}

		this.stopCleanupInterval();
		this.emit("destroyed", { totalDestroyed: this.metrics.totalStreamsDestroyed });
	}

	/**
	 * Generate unique stream ID
	 */
	private generateStreamId(track: Track): string {
		return `${track.source || "unknown"}:${track.id || track.url || track.title}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
	}

	/**
	 * Debug logging
	 */
	private debug(message: string, ...args: any[]): void {
		if (this.listenerCount("debug") > 0) {
			this.emit("debug", `[StreamManager] ${message}`, ...args);
		}
	}
}
