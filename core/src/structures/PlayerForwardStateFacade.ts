import { Player } from "./Player";
import { PlaybackMode } from "../types";

/**
 * Forward-mode state is owned by the leader because followers subscribe to
 * the leader's AudioPlayer rather than driving their own playback state.
 *
 * This is intentionally isolated while PlayerFacadeMethods is being
 * decomposed; the final facade should expose these as real Player getters.
 */
Object.defineProperties(Player.prototype, {
	isLive: {
		configurable: true,
		get(this: Player) {
			if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isLive ?? true;
			return Boolean(this.currentTrack?.isLive);
		},
	},
	isIdle: {
		configurable: true,
		get(this: Player) {
			if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isIdle ?? false;
			return this.playbackController?.status === "idle";
		},
	},
	isBuffering: {
		configurable: true,
		get(this: Player) {
			if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isBuffering ?? false;
			return this.playbackController?.status === "buffering";
		},
	},
});
