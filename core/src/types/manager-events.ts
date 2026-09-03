import type { Player } from "../structures/Player";
import type { Track } from "./core";

declare module "./core" {
	interface ManagerEvents {
		seek: [player: Player, payload: { track: Track; position: number }];
		trackStuck: [player: Player, track: Track | null];
	}
}

export {};