import { PlayerManager, getGlobalManager } from "./structures/PlayerManager";

export { Player, assertVoiceChannel } from "./structures/Player";
export { PlayerManager } from "./structures/PlayerManager";
export { Bus } from "./structures/Bus";
export {
	BUS_REQUEST,
	BUS_OUTPUT,
	CONTROLLER_RPC,
	PLAYER_RPC,
	BUS_EVENT,
	PLAYER_ACTION,
	PLAYER_QUERY,
	traceBusSignal,
} from "./structures/BusContract";
export type {
	BusRequestKey,
	BusOutputKey,
	ControllerRpcKey,
	PlayerRpcKey,
	BusEventKey,
	PlayerActionKey,
	PlayerQueryKey,
} from "./structures/BusContract";
export { PlayerAction } from "./structures/PlayerAction";

export { PlaybackOrchestrator, createPlaybackOrchestrator } from "./structures/PlaybackOrchestrator";
export { createSharedControllers } from "./structures/PlayerManager";
export { PlaybackSession } from "./structures/PlaybackSession";
export {
	DiscordVoiceOutputBackend,
	audioFrameFormatFromDiscordStreamType,
	convertFloat32PcmToS16Le,
	resolveOutputStreamType,
} from "./output/DiscordVoiceOutputBackend";
export {
	WebSocketAudioOutputBackend,
	WebAudioOutputBackend,
	WebSocketOutputBackend,
	WebAudioOutputHandle,
	WebSocketAudioOutputHandleImpl,
	WEB_AUDIO_PROTOCOL_VERSION,
	WEB_AUDIO_SAMPLE_RATE_HZ,
	WEB_AUDIO_CHANNELS,
	WEB_AUDIO_SAMPLE_BYTES,
	WEB_AUDIO_MAX_MESSAGE_BYTES,
	webAudioFormatFromPcm,
	validateWebAudioOutputFormat,
	encodeWebAudioControlMessage,
	decodeWebAudioControlMessage,
	encodeWebAudioFrame,
	decodeWebAudioFrame,
	defaultWebAudioSocketFactory,
} from "./output/WebSocketAudioOutputBackend";
export type {
	AudioFrameFormat,
	AudioOutputInput,
	AudioOutputCapabilities,
	AudioOutputBackendFactory,
	AudioOutputBackendFactoryContext,
	AudioOutputContext,
	AudioOutputEvent,
	AudioOutputHandle,
	AudioOutputState,
	AudioOutputBackend,
} from "./output/AudioOutputBackend";
export type {
	WebSocketLike,
	WebSocketAudioControlMessage,
	WebSocketAudioBackendContext,
	WebSocketAudioOutputBackendOptions,
	WebSocketAudioOutputHandleContract,
	WebSocketAudioSessionResource,
} from "./output/WebSocketAudioOutputBackend";
export { AudioOutputUnsupportedOperationError } from "./output/AudioOutputBackend";
export { TrackLoader } from "./structures/TrackLoader";
export { PlaybackController } from "./controller/PlaybackController";
export { ConnectionController } from "./controller/ConnectionController";
export { VolumeController, defaults } from "./controller/VolumeController";
export { StreamController } from "./controller/StreamController";
export { QueueController, QueueState, QueueState as Queue } from "./controller/QueueController";
export type { PlayerQueue } from "./controller/QueueController";
export { AntiStuckController } from "./controller/AntiStuckController";
export { PlaybackSessionController } from "./controller/PlaybackSessionController";
export { TransitionController } from "./controller/TransitionController";
export { PreloadController } from "./controller/PreloadController";
export { SaveController } from "./controller/SaveController";
export { BusLatencyTrace } from "./controller/BusLatencyTrace";
export { PlayerEventBridge } from "./controller/PlayerEventBridge";
export { PlayerEventDebug, DEBUG_PRIORITY } from "./controller/PlayerEventDebug";
export { GlobalControllerRegistry, globalControllerRegistry } from "./controller/GlobalControllerRegistry";
export { FilterEngine, isSafeCustomFilter } from "./controller/FilterController";
export { StreamManager } from "./structures/StreamManager";
export {
	createAudioProcessingEngine,
	defaultAudioProcessingEngine,
	AudioJsAudioProcessingEngine,
} from "./audio/AudioProcessingEngine";
export type {
	AudioProcessingEngine,
	AudioProcessingPipeline,
	AudioProcessingOptions,
	AudioProcessingContext,
	AudioProcessingFormat,
} from "./audio/AudioProcessingEngine";

export type {
	PlayerAction as PlayerActionMessage,
	PlayerEvent,
	PlayerEventType,
	BusEvents,
	PlayerQuery,
	PlayerQueryMap,
} from "./structures/Bus";

export { PreloadManager } from "./structures/PreloadManager";
export * from "./types";
export * from "./plugins";
export * from "./extensions";

export default PlayerManager;
export const getManager = () => getGlobalManager();
export const getPlayer = (guildOrId: string) => getManager()?.get(guildOrId);
