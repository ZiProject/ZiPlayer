import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";
import type { PlayerManagerOptions } from "./types";

export { Player } from "./structures/Player";
export { Queue } from "./structures/Queue";
export { PlayerManager } from "./structures/PlayerManager";
export { PreloadManager } from "./structures/PreloadManager";
export * from "./types";
export * from "./plugins";
export * from "./extensions";

// Default export
export default PlayerManager;

// Simple shared-instance accessor
export const getManager = () => getGlobalManager();
export const getPlayer = (guildOrId: string) => getManager()?.get(guildOrId);
