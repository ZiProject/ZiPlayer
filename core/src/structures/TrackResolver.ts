import type { StreamInfo, Track, TrackResolveContext, TrackResolverOptions } from "../types";
import type { Bus } from "./Bus";

/**
 * Resolves a Track to a playable stream through the extension/plugin chain, without owning playback.
 *
 * Shared, singleton — created once in `ensureSharedControllers()`. Each player's
 * StreamManager / PluginManager / ExtensionManager live in an internal
 * `Map<playerId, TrackResolverOptions>` (opened by `attach(playerId, ...)`, released by
 * `detach(playerId)`). `"stream.resolve"` is registered exactly once, in the constructor,
 * and routes by `ctx.playerId`.
 */
export class TrackResolver {
	private readonly slots = new Map<string, TrackResolverOptions>();

	public constructor(bus: Bus) {
		bus.registerRpc<{ track: Track; fresh?: boolean }, StreamInfo | null>("stream.resolve", ({ track, fresh }, ctx) =>
			this.resolve(ctx.playerId, track, { fresh }),
		);
	}

	/** Opens a slot for `playerId`. Re-attaching replaces the previous slot. */
	public attach(playerId: string, options: TrackResolverOptions): void {
		this.slots.set(playerId, options);
	}

	public detach(playerId: string): void {
		this.slots.delete(playerId);
	}

	/** Global shutdown: releases every player's slot. */
	public dispose(): void {
		this.slots.clear();
	}

	public has(playerId: string): boolean {
		return this.slots.has(playerId);
	}

	/** True once `playerId` has been detached (or was never attached) or its own `isDestroyed()` says so. */
	public isDestroyed(playerId: string): boolean {
		const slot = this.slots.get(playerId);
		return !slot || (slot.isDestroyed?.() ?? false);
	}

	public async resolve(
		playerId: string,
		track: Track,
		options?: { fresh?: boolean; context?: TrackResolveContext },
	): Promise<StreamInfo | null> {
		const slot = this.slots.get(playerId);
		if (!slot) throw new Error("No TrackResolver registered for this player");
		const { streamManager, pluginManager, extensionManager } = slot;
		const isDestroyed = () => this.isDestroyed(playerId);
		if (isDestroyed()) throw new Error("PLAYER_DESTROYED");
		const trackId = track.id || track.url || track.title;
		const existing = options?.fresh ? null : streamManager.getStreamByTrack(trackId);
		if (existing && !existing.destroyed) return { stream: existing, type: "arbitrary" };

		let stream = await extensionManager.provideStream(track);
		if (isDestroyed()) {
			stream?.stream?.destroy?.();
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.remote && stream.handle) return stream;
		if (stream?.stream || stream?.url || stream?.recreate) return stream;

		stream = await pluginManager.getStream(track, options);
		if (isDestroyed()) {
			stream?.stream?.destroy?.();
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.stream || stream?.url || stream?.recreate) {
			if (stream.stream) {
				const existingAgain = options?.fresh ? null : streamManager.getStreamByTrack(trackId);
				if (existingAgain && !existingAgain.destroyed) {
					stream.stream.destroy?.();
					return { stream: existingAgain, type: "arbitrary" };
				}
			}
			return stream;
		}
		if (!pluginManager.hasStreamCandidate(track)) throw new Error(`UNRECOVERABLE_NO_PLUGIN:${track.title}`);
		throw new Error(`No stream available for track: ${track.title}`);
	}
}
