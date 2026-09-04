import type { PlaybackSessionSnapshot } from "./core";

declare module "../structures/PlayerBus" {
	interface PlayerBus {
		event(event: { type: "TRACK_STARTED"; session: PlaybackSessionSnapshot }): void;
		event(event: { type: "playbackStateChanged"; session: PlaybackSessionSnapshot | null }): void;
	}
}
