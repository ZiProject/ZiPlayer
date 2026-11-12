import type { Track } from "../types";
import type { Bus } from "../structures/Bus";
import { BUS_EVENT } from "../structures/BusContract";
import { toError } from "../utils/errors";

/**
 * Publishes a `streamError` event for `playerId`. Never throws: a failure to
 * publish is logged so it cannot mask the original playback error.
 */
export function reportStreamError(bus: Bus, playerId: string, track: Track | null, error: unknown): void {
	try {
		bus.event(playerId, {
			type: BUS_EVENT.streamError,
			error: toError(error),
			track,
		});
	} catch (reportError) {
		console.error("Failed to report playback stream error", reportError);
	}
}
