import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type {
	ExtensionSearchRequest,
	SearchResult,
	StreamInfo,
	Track,
	ExtensionContext,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionAfterPlayPayload,
	ExtensionStreamRequest,
} from "../types";

import { BaseExtension } from "./BaseExtension";

export { BaseExtension } from "./BaseExtension";

type DebugFn = (message?: any, ...optionalParams: any[]) => void;

// Extension factory
export class ExtensionManager {
	private debug: DebugFn;
	private extensions: Map<string, BaseExtension>;
	private player: Player;
	private manager: PlayerManager;
	private extensionContext: ExtensionContext;

	constructor(player: Player, manager: PlayerManager) {
		this.player = player;
		this.manager = manager;
		this.extensions = new Map();
		this.extensionContext = Object.freeze({ player, manager });

		this.debug = (message?: any, ...optionalParams: any[]) => {
			if (manager.debugEnabled) {
				manager.emit("debug", `[ExtensionManager] ${message}`, ...optionalParams);
			}
		};
	}

	register(extension: BaseExtension): void {
		if (this.extensions.has(extension.name)) {
			return;
		}
		if (!extension.player) {
			extension.player = this.player;
		}
		this.extensions.set(extension.name, extension);
	}

	unregister(extension: BaseExtension): boolean {
		const name = extension.name;
		const result = this.extensions.delete(name);
		if (result) {
			this.invokeExtensionLifecycle(extension, "onDestroy");
		}
		return result;
	}

	destroy(): void {
		this.debug(`[ExtensionManager] destroying all extensions`);
		for (const extension of this.extensions.values()) {
			this.unregister(extension);
		}
		this.extensions.clear();
	}

	get(name: string): BaseExtension | undefined {
		return this.extensions.get(name);
	}

	getAll(): BaseExtension[] {
		return Array.from(this.extensions.values());
	}

	findExtension(alas: any): BaseExtension | undefined {
		return this.getAll().find((extension) => extension.active(alas));
	}

	clear(): void {
		this.extensions.clear();
	}

	private invokeExtensionLifecycle(extension: BaseExtension | undefined, hook: "onRegister" | "onDestroy"): void {
		if (!extension) return;
		const fn = (extension as any)[hook];
		if (typeof fn !== "function") return;
		try {
			const result = fn.call(extension, this.extensionContext);
			if (result && typeof (result as Promise<unknown>).then === "function") {
				(result as Promise<unknown>).catch((err) => this.debug(`[Player] Extension ${extension.name} ${hook} error:`, err));
			}
		} catch (err) {
			this.debug(`[Player] Extension ${extension.name} ${hook} error:`, err);
		}
	}

	async provideSearch(query: string, requestedBy: string): Promise<SearchResult | null> {
		const request: ExtensionSearchRequest = { query, requestedBy };
		for (const extension of this.getAll()) {
			const hook = (extension as any).provideSearch;
			if (typeof hook !== "function") continue;
			try {
				const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
				if (result && Array.isArray(result.tracks) && result.tracks.length > 0) {
					this.debug(`[Player] Extension ${extension.name} handled search for query: ${query}`);
					return result as SearchResult;
				}
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} provideSearch error:`, err);
			}
		}
		return null;
	}

	async provideStream(track: Track): Promise<StreamInfo | null> {
		const request: ExtensionStreamRequest = { track };
		for (const extension of this.getAll()) {
			const hook = (extension as any).provideStream;
			if (typeof hook !== "function") continue;
			try {
				const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
				if (result && (result as StreamInfo).stream) {
					this.debug(`[Player] Extension ${extension.name} provided stream for track: ${track.title}`);
					return result as StreamInfo;
				}
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} provideStream error:`, err);
			}
		}
		return null;
	}

	async BeforePlayHooks(
		initial: ExtensionPlayRequest,
	): Promise<{ request: ExtensionPlayRequest; response: ExtensionPlayResponse }> {
		const request: ExtensionPlayRequest = { ...initial };
		const response: ExtensionPlayResponse = {};
		for (const extension of this.getAll()) {
			const hook = (extension as any).beforePlay;
			if (typeof hook !== "function") continue;
			try {
				const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
				if (!result) continue;
				if (result.query !== undefined) {
					request.query = result.query;
					response.query = result.query;
				}
				if (result.requestedBy !== undefined) {
					request.requestedBy = result.requestedBy;
					response.requestedBy = result.requestedBy;
				}
				if (Array.isArray(result.tracks)) {
					response.tracks = result.tracks;
				}
				if (typeof result.isPlaylist === "boolean") {
					response.isPlaylist = result.isPlaylist;
				}
				if (typeof result.success === "boolean") {
					response.success = result.success;
				}
				if (result.error instanceof Error) {
					response.error = result.error;
				}
				if (typeof result.handled === "boolean") {
					response.handled = result.handled;
					if (result.handled) break;
				}
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} beforePlay error:`, err);
			}
		}
		return { request, response };
	}

	async AfterPlayHooks(payload: ExtensionAfterPlayPayload): Promise<void> {
		if (this.getAll().length === 0) return;
		const safeTracks = payload.tracks ? [...payload.tracks] : undefined;
		if (safeTracks) {
			Object.freeze(safeTracks);
		}
		const immutablePayload = Object.freeze({ ...payload, tracks: safeTracks });
		for (const extension of this.getAll()) {
			const hook = (extension as any).afterPlay;
			if (typeof hook !== "function") continue;
			try {
				await Promise.resolve(hook.call(extension, this.extensionContext, immutablePayload));
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} afterPlay error:`, err);
			}
		}
	}
}
