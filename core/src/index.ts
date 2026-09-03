import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";
import "./controller/SavePlayerFacade";

export { Player } from "./structures/Player";
export { Queue } from "./structures/Queue";
export { PlayerManager } from "./structures/PlayerManager";
export { PlayerBus } from "./structures/PlayerBus";
export { PlayerAction } from "./structures/PlayerAction";
export { PlaybackOrchestrator } from "./structures/PlaybackOrchestrator";
export { PlaybackSession } from "./structures/PlaybackSession";
export { TrackLoader } from "./structures/TrackLoader";
export { PlaybackController } from "./controller/PlaybackController";
export { StreamController } from "./controller/StreamController";
export { QueueController } from "./controller/QueueController";
export { AntiStuckController } from "./controller/AntiStuckController";
export { TransitionController } from "./controller/TransitionController";
export { PreloadController } from "./controller/PreloadController";
export { SaveController } from "./controller/SaveController";
export { installSaveFacade } from "./controller/SavePlayerFacade";

export type {
	PlayerAction as PlayerActionMessage,
	PlayerEvent,
	PlayerEventType,
	PlayerBusEvents,
	PlayerQuery,
	PlayerQueryMap,
} from "./structures/PlayerBus";

export type { PlaybackOrchestratorOptions } from "./structures/PlaybackOrchestrator";
export type { QueueControllerOptions } from "./controller/QueueController";
export type {
	AntiStuckControllerOptions,
	AntiStuckRetryContext,
	AntiStuckRetryHandlers,
	LegacyAntiStuckRetryContext,
	LegacyAntiStuckRetryHandlers,
} from "./controller/AntiStuckController";
export type { TransitionControllerOptions, TransitionPlan } from "./controller/TransitionController";
export type { PreloadControllerOptions } from "./controller/PreloadController";
export { PreloadManager } from "./structures/PreloadManager";
export * from "./types";
export * from "./plugins";
export * from "./extensions";

export default PlayerManager;
export const getManager = () => getGlobalManager();
export const getPlayer = (guildOrId: string) => getManager()?.get(guildOrId);
