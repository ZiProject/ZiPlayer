import type { Bus } from "../structures/Bus";
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
		bus.registerQuery("extensions", (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerQuery("extension.list", (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerRpc<Record<string, never> | undefined, BaseExtension[]>(
			"extension.list",
			(_req, ctx) => this.manager(ctx.playerId)?.getAll() ?? [],
		);
		bus.registerRpc<{ name: string }, BaseExtension | undefined>("extension.get", ({ name }, ctx) =>
			this.manager(ctx.playerId)?.get(name),
		);
		bus.registerRpc<{ name: string }, boolean>(
			"extension.enable",
			({ name }, ctx) => this.manager(ctx.playerId)?.enable(name) ?? false,
		);
		bus.registerRpc<{ name: string }, boolean>(
			"extension.disable",
			({ name }, ctx) => this.manager(ctx.playerId)?.disable(name) ?? false,
		);
		bus.registerRpc<{ extension: BaseExtension }, void>("extension.add", ({ extension }, ctx) =>
			this.manager(ctx.playerId)?.register(extension),
		);
		bus.registerRpc<{ extension: BaseExtension }, boolean>(
			"extension.remove",
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
