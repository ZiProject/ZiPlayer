import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";

export { Player } from "./structures/Player";
export { Queue } from "./structures/Queue";
export { PlayerManager } from "./structures/PlayerManager";
export { PlayerBus } from "./structures/PlayerBus";
export { PlayerAction } from "./structures/PlayerAction";
export { PlaybackOrchestrator } from "./structures/PlaybackOrchestrator";
export { PlaybackSession } from "./structures/PlaybackSession";
export { TrackLoader } from "./structures/TrackLoader";
export { PlaybackController } from "./Controller/PlaybackController";
export { StreamController } from "./Controller/StreamController";
export { QueueController } from "./Controller/QueueController";
export { AntiStuckController } from "./Controller/AntiStuckController";
export { TransitionController } from "./Controller/TransitionController";
export { PreloadController } from "./Controller/PreloadController";
export { PlayerControllerRuntime } from "./structures/PlayerControllerRuntime";
export type { PlayerControllerRuntimeHost } from "./structures/PlayerControllerRuntime";
export type {
	PlayerAction as PlayerActionMessage,
	PlayerActionType,
	PlayerEvent,
	PlayerEventType,
	PlayerBusEvents,
	PlayerLifecycleEvents,
	PlayerQuery,
	PlayerQueryMap,
} from "./structures/PlayerBus";
export type { TrackLoadResult, TrackLoaderContext, TrackLoaderOptions, TrackStreamResolver } from "./structures/TrackLoader";
export type { ActiveStream, StreamControllerOptions } from "./Controller/StreamController";
export type { PlaybackOrchestratorOptions } from "./structures/PlaybackOrchestrator";
export type { PlaybackSessionSnapshot, PlaybackSessionStatus } from "./structures/PlaybackSession";
export type { PlaybackControllerOptions } from "./Controller/PlaybackController";
export type { QueueControllerOptions } from "./Controller/QueueController";
export type {
	AntiStuckControllerOptions,
	AntiStuckRetryContext,
	AntiStuckRetryHandlers,
	LegacyAntiStuckRetryContext,
	LegacyAntiStuckRetryHandlers,
} from "./Controller/AntiStuckController";
export type { TransitionControllerOptions, TransitionPlan } from "./Controller/TransitionController";
export type { PreloadControllerOptions } from "./Controller/PreloadController";
export { PreloadManager } from "./structures/PreloadManager";
export * from "./types";
export * from "./plugins";
export * from "./extensions";

export default PlayerManager;
export const getManager = () => getGlobalManager();
export const getPlayer = (guildOrId: string) => getManager()?.get(guildOrId);
