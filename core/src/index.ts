import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";
import { PlayerBus } from "./structures/PlayerBus";
import type { PlayerManagerOptions } from "./types";

export { Player } from "./structures/Player";
export { Queue } from "./structures/Queue";
export { PlayerManager } from "./structures/PlayerManager";
export { PlayerBus } from "./structures/PlayerBus";
export type {
	PlayerAction,
	PlayerActionType,
	PlayerBusEvents,
	PlayerLifecycleEvents,
	PlayerQuery,
	PlayerQueryMap,
} from "./structures/PlayerBus";
export { PreloadManager } from "./structures/PreloadManager";
export * from "./types";
export * from "./plugins";
export * from "./extensions";

// Default export
export default PlayerManager;

// Simple shared-instance accessor
export const getManager = () => getGlobalManager();
export const getPlayer = (guildOrId: string) => getManager()?.get(guildOrId);
