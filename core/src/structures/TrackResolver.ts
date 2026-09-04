import type { StreamInfo, Track } from "../types";
import type { StreamManager } from "./StreamManager";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";

export interface TrackResolverOptions {
	streamManager: StreamManager;
	pluginManager: PluginManager;
	extensionManager: ExtensionManager;
}

/** Resolves a Track through the existing extension/plugin chain without owning playback. */
export class TrackResolver {
	private readonly streamManager: StreamManager;
	private readonly pluginManager: PluginManager;
	private readonly extensionManager: ExtensionManager;
	public constructor(options: TrackResolverOptions) {
		this.streamManager = options.streamManager;
		this.pluginManager = options.pluginManager;
		this.extensionManager = options.extensionManager;
	}

	public async resolve(track: Track, isDestroyed: () => boolean): Promise<StreamInfo | null> {
		if (isDestroyed()) throw new Error("PLAYER_DESTROYED");
		const trackId = track.id || track.url || track.title;
		const existing = this.streamManager.getStreamByTrack(trackId);
		if (existing && !existing.destroyed) return { stream: existing, type: "arbitrary" };

		let stream = await this.extensionManager.provideStream(track);
		if (isDestroyed()) {
			stream?.stream?.destroy?.();
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.remote && stream.handle) return stream;
		if (stream?.stream) return stream;

		stream = await this.pluginManager.getStream(track);
		if (isDestroyed()) {
			stream?.stream?.destroy?.();
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.stream) {
			const existingAgain = this.streamManager.getStreamByTrack(trackId);
			if (existingAgain && !existingAgain.destroyed) {
				stream.stream.destroy?.();
				return { stream: existingAgain, type: "arbitrary" };
			}
			return stream;
		}
		if (!this.pluginManager.hasStreamCandidate(track)) throw new Error(`UNRECOVERABLE_NO_PLUGIN:${track.title}`);
		throw new Error(`No stream available for track: ${track.title}`);
	}
}
