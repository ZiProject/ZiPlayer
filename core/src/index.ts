import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";

export { Player } from "./structures/Player";
export { PlayerManager } from "./structures/PlayerManager";
export { Bus } from "./structures/Bus";
export { PlayerAction } from "./structures/PlayerAction";
export {
	PlayerCapabilities,
	createPlayerCapabilities,
	QueueCapability,
	PluginCapability,
	ExtensionCapability,
	StreamCapability,
	PreloadCapability,
	FilterCapability,
} from "./capabilities/PlayerCapabilities";
export { PlaybackOrchestrator } from "./structures/PlaybackOrchestrator";
export { PlaybackSession } from "./structures/PlaybackSession";
export { TrackLoader } from "./structures/TrackLoader";
export { PlaybackController } from "./controller/PlaybackController";
export { ConnectionController } from "./controller/ConnectionController";
export { VolumeController } from "./controller/VolumeController";
export { StreamController, StreamWorker } from "./controller/StreamController";
export { QueueController, QueueState, QueueState as Queue } from "./controller/QueueController";
export { AntiStuckController } from "./controller/AntiStuckController";
export { PlaybackSessionController } from "./controller/PlaybackSessionController";
export { TransitionController } from "./controller/TransitionController";
export { PreloadController } from "./controller/PreloadController";
export { SaveController, SaveWorker } from "./controller/SaveController";
export { BusLatencyTrace } from "./controller/BusLatencyTrace";
export { PlayerEventDebug, DEBUG_PRIORITY } from "./controller/PlayerEventDebug";
export { GlobalControllerRegistry, globalControllerRegistry } from "./controller/GlobalControllerRegistry";
export { StreamManager } from "./structures/StreamManager";

export type {
	PlayerAction as PlayerActionMessage,
	PlayerEvent,
	PlayerEventType,
	BusEvents,
	PlayerQuery,
	PlayerQueryMap,
} from "./structures/Bus";

export type {
	PlaybackOrchestratorOptions,
	PlaybackOrchestratorAttachOptions,
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
