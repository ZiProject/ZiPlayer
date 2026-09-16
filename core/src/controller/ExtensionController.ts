import type { PlayerBus } from "../structures/PlayerBus";
import type { ExtensionManager } from "../extensions";
import type { BaseExtension } from "../extensions/BaseExtension";
import type { ExtensionControllerOptions } from "../types";

/** Owns extension-related PlayerBus RPC/query registration. */
export class ExtensionController {
	private readonly detachRpcs: Array<() => void> = [];

	constructor(options: ExtensionControllerOptions) {
		const { extensionManager, bus } = options;
		this.detachRpcs.push(
			bus.registerQuery("extensions", () => extensionManager.getAll()),
			bus.registerQuery("extension.list", () => extensionManager.getAll()),
			bus.registerRpc<Record<string, never> | undefined, BaseExtension[]>("extension.list", () => extensionManager.getAll()),
			bus.registerRpc<{ name: string }, BaseExtension | undefined>("extension.get", ({ name }) => extensionManager.get(name)),
			bus.registerRpc<{ name: string }, boolean>("extension.enable", ({ name }) => extensionManager.enable(name)),
			bus.registerRpc<{ name: string }, boolean>("extension.disable", ({ name }) => extensionManager.disable(name)),
			bus.registerRpc<{ extension: BaseExtension }, void>("extension.add", ({ extension }) =>
				extensionManager.register(extension),
			),
			bus.registerRpc<{ extension: BaseExtension }, boolean>("extension.remove", ({ extension }) =>
				extensionManager.unregister(extension),
			),
		);
	}

	dispose(): void {
		for (const detach of this.detachRpcs.splice(0)) detach();
	}
}
