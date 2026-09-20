import type { StreamInfo, Track, TrackResolveContext, TrackResolverOptions } from "../types";
import type { StreamManager } from "./StreamManager";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { Bus } from "./Bus";

// "stream.resolve" must be registered exactly once on the shared Bus;
// each per-player TrackResolver instance registers itself here so the shared handler
// can route by playerId.
const streamResolveRpcRegistered = new WeakSet<Bus>();
const trackResolvers = new Map<string, TrackResolver>();
function ensureStreamResolveRpcBridge(bus: Bus): void {
	if (streamResolveRpcRegistered.has(bus)) return;
	streamResolveRpcRegistered.add(bus);
	bus.registerRpc<{ track: Track; fresh?: boolean }, StreamInfo | null>("stream.resolve", ({ track, fresh }, ctx) => {
		const resolver = trackResolvers.get(ctx.playerId);
		if (!resolver) throw new Error("No TrackResolver registered for this player");
		return resolver.resolve(track, resolver.isDestroyed, { fresh });
	});
}

/** Resolves a Track through the existing extension/plugin chain without owning playback.
 *  One instance per player (holds that player's StreamManager/PluginManager/ExtensionManager). */
export class TrackResolver {
	private readonly streamManager: StreamManager;
	private readonly pluginManager: PluginManager;
	private readonly extensionManager: ExtensionManager;
	public readonly isDestroyed: () => boolean;
	private readonly playerId?: string;

	public constructor(options: TrackResolverOptions) {
		this.streamManager = options.streamManager;
		this.pluginManager = options.pluginManager;
		this.extensionManager = options.extensionManager;
		this.isDestroyed = options.isDestroyed ?? (() => false);
		this.playerId = options.playerId;
		if (options.bus && this.playerId) {
			ensureStreamResolveRpcBridge(options.bus);
			trackResolvers.set(this.playerId, this);
		}
	}

	dispose(): void {
		if (this.playerId && trackResolvers.get(this.playerId) === this) trackResolvers.delete(this.playerId);
	}

	public async resolve(
		track: Track,
		isDestroyed: () => boolean,
		options?: { fresh?: boolean; context?: TrackResolveContext },
	): Promise<StreamInfo | null> {
		if (isDestroyed()) throw new Error("PLAYER_DESTROYED");
		const trackId = track.id || track.url || track.title;
		const existing = options?.fresh ? null : this.streamManager.getStreamByTrack(trackId);
		if (existing && !existing.destroyed) return { stream: existing, type: "arbitrary" };

		let stream = await this.extensionManager.provideStream(track);
		if (isDestroyed()) {
			stream?.stream?.destroy?.();
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.remote && stream.handle) return stream;
		if (stream?.stream || stream?.url || stream?.recreate) return stream;

		stream = await this.pluginManager.getStream(track, options);
		if (isDestroyed()) {
			stream?.stream?.destroy?.();
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.stream || stream?.url || stream?.recreate) {
			if (stream.stream) {
				const existingAgain = options?.fresh ? null : this.streamManager.getStreamByTrack(trackId);
				if (existingAgain && !existingAgain.destroyed) {
					stream.stream.destroy?.();
					return { stream: existingAgain, type: "arbitrary" };
				}
			}
			return stream;
		}
		if (!this.pluginManager.hasStreamCandidate(track)) throw new Error(`UNRECOVERABLE_NO_PLUGIN:${track.title}`);
		throw new Error(`No stream available for track: ${track.title}`);
	}
}
