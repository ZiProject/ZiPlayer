import type { Readable } from "stream";
import type { SaveOptions, Track } from "../types";
import { Player } from "../structures/Player";
import { SaveController } from "./SaveController";

const controllers = new WeakMap<Player, SaveController>();

function getSaveController(player: Player): SaveController {
	let controller = controllers.get(player);
	if (controller) return controller;

	controller = new SaveController({
		middleware: [async (track) => player.applyTrackMiddleware(track)],
		middlewareContext: { player, manager: player.manager },
		resolveStream: (track) => player.pluginManager.getStream(track),
		debug: player.debug.bind(player),
	});
	controllers.set(player, controller);
	return controller;
}

/**
 * Installs the public Player.save facade without coupling SaveController to
 * playback state. The package entry point imports this module for its side
 * effect, while Player keeps the public API surface.
 */
export function installSaveFacade(): void {
	const prototype = Player.prototype as Player & {
		save: (track: Track, options?: SaveOptions | string) => Promise<Readable>;
	};

	prototype.save = async function save(track: Track, options?: SaveOptions | string): Promise<Readable> {
		try {
			return await getSaveController(this).save(track, options);
		} catch (error) {
			this.debug("[Player] save error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	};
}

installSaveFacade();
