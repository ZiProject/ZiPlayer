import type { StreamInfo, Track } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";

export interface TTSControllerOptions {
	pluginManager: PluginManager;
	extensionManager?: ExtensionManager;
	debug?: (...args: any[]) => void;
}

/** Owns TTS stream resolution. TTS generation remains implemented by the TTS plugin. */
export class TTSController {
	private readonly pluginManager: PluginManager;
	private readonly extensionManager?: ExtensionManager;
	private readonly debug: (...args: any[]) => void;

	constructor(options: TTSControllerOptions) {
		this.pluginManager = options.pluginManager;
		this.extensionManager = options.extensionManager;
		this.debug = options.debug ?? (() => undefined);
	}

	isTTS(track: Track): boolean {
		return track.source?.toLowerCase() === "tts" || track.id?.toLowerCase().startsWith("tts-") || !!track.metadata?.tts;
	}

	async resolve(track: Track): Promise<StreamInfo> {
		if (!this.isTTS(track)) throw new Error("Track is not a TTS track");
		try {
			const extensionStream = this.extensionManager ? await this.extensionManager.provideStream(track) : null;
			if (extensionStream?.stream || extensionStream?.remote) return extensionStream;
			const stream = await this.pluginManager.getStream(track);
			if (!stream) throw new Error(`No TTS stream available for track: ${track.title}`);
			return stream;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.debug("[TTSController] resolve failed:", err);
			throw err;
		}
	}

	dispose(): void {}
}
