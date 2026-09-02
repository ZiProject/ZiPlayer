import type { Player } from "./Player";
import type { StreamInfo, Track } from "../types";
import type { StreamManager } from "./StreamManager";

/** Resolves a Track through the existing extension/plugin chain without owning playback. */
export class TrackResolver {
	public constructor(private readonly streamManager: StreamManager) {}

	public async resolve(player: Player, track: Track): Promise<StreamInfo | null> {
		if (player.destroyed) throw new Error("PLAYER_DESTROYED");
		const trackId = track.id || track.url || track.title;
		const existing = this.streamManager.getStreamByTrack(trackId);
		if (existing && !existing.destroyed) return { stream: existing, type: "arbitrary" };

		let stream = await player.extensionManager.provideStream(track);
		if (player.destroyed) {
			stream?.stream?.destroy?.();
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.remote && stream.handle) return stream;
		if (stream?.stream) return stream;

		stream = await player.pluginManager.getStream(track);
		if (player.destroyed) {
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
		if (!player.pluginManager.hasStreamCandidate(track)) throw new Error(`UNRECOVERABLE_NO_PLUGIN:${track.title}`);
		throw new Error(`No stream available for track: ${track.title}`);
	}
}
