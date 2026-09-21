import type { Bus } from "../structures/Bus";
import { PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";
import type { ExtensionManager } from "../extensions";
import type { BaseExtension } from "../extensions/BaseExtension";

/**
 * Shared, singleton controller: owns extension-related Bus RPC/query
 * registration for every player. Registered once; routed per player via
 * `attach`/`detach`.
 */
export class ExtensionController {
	private readonly managers = new Map<string, ExtensionManager>();

	constructor(bus: Bus) {
		bus.registerQuery(PLAYER_QUERY.extensions, (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerQuery(PLAYER_QUERY.extensionList, (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerRpc<Record<string, never> | undefined, BaseExtension[]>(
			PLAYER_RPC.extensionList,
			(_req, ctx) => this.manager(ctx.playerId)?.getAll() ?? [],
		);
		bus.registerRpc<{ name: string }, BaseExtension | undefined>(PLAYER_RPC.extensionGet, ({ name }, ctx) =>
			this.manager(ctx.playerId)?.get(name),
		);
		bus.registerRpc<{ name: string }, boolean>(
			PLAYER_RPC.extensionEnable,
			({ name }, ctx) => this.manager(ctx.playerId)?.enable(name) ?? false,
		);
		bus.registerRpc<{ name: string }, boolean>(
			PLAYER_RPC.extensionDisable,
			({ name }, ctx) => this.manager(ctx.playerId)?.disable(name) ?? false,
		);
		bus.registerRpc<{ extension: BaseExtension }, void>(PLAYER_RPC.extensionAdd, ({ extension }, ctx) =>
			this.manager(ctx.playerId)?.register(extension),
		);
		bus.registerRpc<{ extension: BaseExtension }, boolean>(
			PLAYER_RPC.extensionRemove,
			({ extension }, ctx) => this.manager(ctx.playerId)?.unregister(extension) ?? false,
		);
	}

	attach(playerId: string, extensionManager: ExtensionManager): void {
		this.managers.set(playerId, extensionManager);
	}
	detach(playerId: string): void {
		this.managers.delete(playerId);
	}
	private manager(playerId: string): ExtensionManager | undefined {
		return this.managers.get(playerId);
	}
}
