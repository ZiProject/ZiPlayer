import type { StreamInfo, Track } from "../types";
import { PluginManager } from "../plugins";
import { withTimeout } from "../utils/timeout";

export type VideoResolveOptions = {
	signal?: AbortSignal;
};

declare module "../plugins" {
	interface PluginManager {
		getVideo(track: Track, options?: VideoResolveOptions): Promise<StreamInfo | null>;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted");
	error.name = "AbortError";
	throw error;
}

function getPrimary(manager: PluginManager, track: Track) {
	return manager.get(track.source) ?? manager.findPlugin(track.url ?? track.title ?? "");
}

/**
 * Adds a fresh video resolver to PluginManager without coupling it to the
 * audio stream cache. Video streams are consumable, so they must never reuse
 * getStream() cache entries.
 */
export function installVideoPluginFacade(): void {
	const prototype = PluginManager.prototype as PluginManager & {
		getVideo?: (track: Track, options?: VideoResolveOptions) => Promise<StreamInfo | null>;
	};

	if (prototype.getVideo) return;

	prototype.getVideo = async function getVideo(track: Track, options: VideoResolveOptions = {}): Promise<StreamInfo | null> {
		if (!track) return null;

		throwIfAborted(options.signal);

		const primary = getPrimary(this, track);
		if (!primary) {
			this.debug(`[Video] No plugin found for: ${track.title}`);
			return null;
		}

		const candidates = [
			primary,
			...this
				.getAll()
				.filter((plugin) => plugin !== primary && typeof plugin.getVideo === "function")
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
		].filter((plugin, index, list) => list.indexOf(plugin) === index && typeof plugin.getVideo === "function");

		for (const plugin of candidates) {
			throwIfAborted(options.signal);

			const controller = new AbortController();
			const onAbort = () => controller.abort(options.signal?.reason);
			options.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				if (plugin.validate && !plugin.validate(track.url ?? "")) continue;

				this.debug(`[Video] ${plugin.name} resolving video: ${track.title}`);
				const result = await withTimeout(
					plugin.getVideo!(track, controller.signal),
					50000,
					`${plugin.name} getVideo timeout`,
				);

				if (result?.stream) {
					this.debug(`[Video] ${plugin.name} video stream ready: ${track.title}`);
					return result;
				}
			} catch (error) {
				this.debug(`[Video] ${plugin.name} getVideo failed:`, error instanceof Error ? error.message : error);
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
		}

		throwIfAborted(options.signal);
		this.debug(`[Video] All plugins failed for: ${track.title}`);
		return null;
	};
}

installVideoPluginFacade();
