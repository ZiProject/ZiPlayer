import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";

export { Player } from "./structures/Player";
export { Queue } from "./structures/Queue";
export { PlayerManager } from "./structures/PlayerManager";
export { PlayerBus } from "./structures/PlayerBus";
export { PlaybackOrchestrator } from "./structures/PlaybackOrchestrator";
export { PlaybackSession } from "./structures/PlaybackSession";
export { TrackLoader } from "./structures/TrackLoader";
export { StreamController } from "./structures/StreamController";
export { PlaybackController } from "./structures/PlaybackController";
export type {
	PlayerAction,
	PlayerActionType,
	PlayerEvent,
	PlayerEventType,
	PlayerBusEvents,
	PlayerLifecycleEvents,
	PlayerQuery,
	PlayerQueryMap,
} from "./structures/PlayerBus";
export type { TrackLoadResult, TrackLoaderContext, TrackLoaderOptions, TrackStreamResolver } from "./structures/TrackLoader";
export type { ActiveStream, StreamControllerOptions } from "./structures/StreamController";
export type { PlaybackOrchestratorOptions } from "./structures/PlaybackOrchestrator";
export type { PlaybackSessionSnapshot, PlaybackSessionStatus } from "./structures/PlaybackSession";
export type { PlaybackControllerOptions } from "./structures/PlaybackController";
export { PreloadManager } from "./structures/PreloadManager";
export * from "./types";
export * from "./plugins";
export * from "./extensions";

export default PlayerManager;

export const getManager = () => getGlobalManager();
export const getPlayer = (guildOrId: string) => getManager()?.get(guildOrId);
