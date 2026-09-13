import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";

export { Player } from "./structures/Player";
export { PlayerManager } from "./structures/PlayerManager";
export { PlayerBus } from "./structures/PlayerBus";
export { PlayerAction } from "./structures/PlayerAction";
export { PlaybackOrchestrator } from "./structures/PlaybackOrchestrator";
export { PlaybackSession } from "./structures/PlaybackSession";
export { TrackLoader } from "./structures/TrackLoader";
export { PlaybackController } from "./controller/PlaybackController";
export { ConnectionController } from "./controller/ConnectionController";
export { VolumeController } from "./controller/VolumeController";
export { StreamController } from "./controller/StreamController";
export { QueueController, QueueController as Queue } from "./controller/QueueController";
export { AntiStuckController } from "./controller/AntiStuckController";
export { TransitionController } from "./controller/TransitionController";
export { PreloadController } from "./controller/PreloadController";
export { SaveController } from "./controller/SaveController";
export { PlayerBusLatencyTrace } from "./controller/PlayerBusLatencyTrace";
export { StreamManager } from "./structures/StreamManager";

export type {
	PlayerAction as PlayerActionMessage,
	PlayerEvent,
	PlayerEventType,
	PlayerBusEvents,
	PlayerQuery,
	PlayerQueryMap,
} from "./structures/PlayerBus";

export type {
	PlaybackOrchestratorOptions,
	QueueControllerOptions,
	TransitionControllerOptions,
	TransitionPlan,
	PreloadControllerOptions,
} from "./types";
export { PreloadManager } from "./structures/PreloadManager";
export * from "./types";
export * from "./plugins";
export * from "./extensions";

export default PlayerManager;
export const getManager = () => getGlobalManager();
export const getPlayer = (guildOrId: string) => getManager()?.get(guildOrId);
