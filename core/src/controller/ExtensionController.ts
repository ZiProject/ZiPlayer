import type { PlayerBus } from "../structures/PlayerBus";
import type { ExtensionManager } from "../extensions";
import type { BaseExtension } from "../extensions/BaseExtension";

export interface ExtensionControllerOptions {
	extensionManager: ExtensionManager;
	bus: PlayerBus;
}

/** Owns extension-related PlayerBus RPC/query registration. */
export class ExtensionController {
	private readonly detachRpcs: Array<() => void> = [];

	constructor(options: ExtensionControllerOptions) {
		const { extensionManager, bus } = options;
		this.detachRpcs.push(
			bus.registerQuery("extensions", () => extensionManager.getAll()),
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
