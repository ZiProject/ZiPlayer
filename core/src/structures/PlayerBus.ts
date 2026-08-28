import type { VoiceChannel, Track } from "../types";
import type { VoiceConnection, AudioPlayerState } from "@discordjs/voice";
import type { PlaybackSessionSnapshot } from "./PlaybackSession";

export type PlayerRequestId = string;
export type PlayerSessionId = string;
export enum PlayerActionPriority { BACKGROUND = 0, NORMAL = 10, HIGH = 50, CRITICAL = 100 }
export interface PlayerActionExecutionContext { readonly signal: AbortSignal; readonly priority: PlayerActionPriority; readonly requestId: PlayerRequestId }
export type PlayerAction =
	| { type: "PLAY"; track?: Track; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "PAUSE"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "RESUME"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SEEK"; position: number; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "STOP"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SKIP"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SET_VOLUME"; volume: number; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "QUEUE_NEXT"; ignoreLoop?: boolean; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "QUEUE_SET_CURRENT"; track: Track | null; priority?: PlayerActionPriority; requestId?: PlayerRequestId };
export type PlayerActionType = PlayerAction["type"];
export type PlayerConnectionInput =
	| { type: "[Player]->[Connection]:connect"; requestId: PlayerRequestId; channel: VoiceChannel }
	| { type: "[Player]->[Connection]:disconnect"; requestId: PlayerRequestId; reason?: string }
	| { type: "[Player]->[Connection]:reconnect"; requestId: PlayerRequestId; channel: VoiceChannel };
export type PlayerPreloadInput = { type: "[Player]->[Preload]:request"; requestId: PlayerRequestId; track: Track };
export type PlayerRecoveryInput = { type: "[Player]->[Recovery]:recover"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; reason: string };
export type PlayerResourceInput = { type: "[Player]->[Resource]:refresh"; requestId: PlayerRequestId; position?: number };
export type PlayerInput = PlayerConnectionInput | PlayerPreloadInput | PlayerRecoveryInput | PlayerResourceInput;
export type PlayerConnectionOutput =
	| { type: "[Connection]->[Player]:connecting"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel }
	| { type: "[Connection]->[Player]:connected"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel; connection: VoiceConnection }
	| { type: "[Connection]->[Player]:disconnected"; requestId?: PlayerRequestId; sessionId: PlayerSessionId; reason?: string }
	| { type: "[Connection]->[Player]:error"; requestId: PlayerRequestId; sessionId?: PlayerSessionId; operation: "connect" | "disconnect" | "reconnect"; error: Error };
export type PlayerPreloadOutput =
	| { type: "[Preload]->[Player]:loading"; requestId: PlayerRequestId; track: Track }
	| { type: "[Preload]->[Player]:ready"; requestId: PlayerRequestId; track: Track }
	| { type: "[Preload]->[Player]:failed"; requestId: PlayerRequestId; track: Track; error: Error };
export type PlayerRecoveryOutput =
	| { type: "[Recovery]->[Player]:retrying"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; attempt: number }
	| { type: "[Recovery]->[Player]:recovered"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot }
	| { type: "[Recovery]->[Player]:failed"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; error: Error };
export type PlayerResourceOutput =
	| { type: "[Resource]->[Player]:refreshed"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot }
	| { type: "[Resource]->[Player]:error"; requestId: PlayerRequestId; error: Error };
export type PlayerLifecycleEvents = { type: "initialized" } | { type: "ready" } | { type: "destroyed" };
export type PlayerPlaybackEvents =
	| { type: "TRACK_LOADING"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_LOADED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_ERROR"; session: PlaybackSessionSnapshot; error: Error }
	| { type: "TRACK_END"; session: PlaybackSessionSnapshot }
	| { type: "STREAM_ABORTED"; session: PlaybackSessionSnapshot }
	| { type: "playbackStateChanged"; session: PlaybackSessionSnapshot }
	| { type: "playbackSessionCreated"; session: PlaybackSessionSnapshot }
	| { type: "trackRequested"; track: Track; session: PlaybackSessionSnapshot }
	| { type: "stateChanged"; oldState: AudioPlayerState; newState: AudioPlayerState };
export type PlayerRecoveryEvents = { type: "STUCK_DETECTED"; session: PlaybackSessionSnapshot; reason: string } | { type: "RECOVERY_STARTED"; session: PlaybackSessionSnapshot } | { type: "RECOVERY_FAILED"; session: PlaybackSessionSnapshot };
export type PlayerPreloadEvents = { type: "preloadStateChanged"; state: PlayerPreloadState } | { type: "preloadPromoted"; track: Track } | { type: "preloadCancelled" };
export type PlayerQueueEvents = { type: "queueChanged"; queue: Track[] };
export type PlayerVolumeEvents = { type: "volumeRequested"; volume: number };
export type PlayerEvent = PlayerLifecycleEvents | PlayerPlaybackEvents | PlayerRecoveryEvents | PlayerPreloadEvents | PlayerQueueEvents | PlayerVolumeEvents;
export type PlayerEventType = PlayerEvent["type"];
export interface PlayerPreloadState { requestedTrack: Track | null; valid: boolean }
export type PlayerEventArgsMap = { [K in PlayerEventType]: K extends "initialized" | "ready" | "destroyed" | "preloadCancelled" ? [] : K extends ("TRACK_LOADING" | "TRACK_LOADED" | "TRACK_STARTED" | "TRACK_END" | "STREAM_ABORTED" | "playbackStateChanged" | "playbackSessionCreated" | "RECOVERY_STARTED" | "RECOVERY_FAILED") ? [PlaybackSessionSnapshot] : K extends "TRACK_ERROR" ? [PlaybackSessionSnapshot, Error] : K extends "STUCK_DETECTED" ? [PlaybackSessionSnapshot, string] : K extends "trackRequested" ? [Track, PlaybackSessionSnapshot] : K extends "queueChanged" ? [Track[]] : K extends "volumeRequested" ? [number] : K extends "stateChanged" ? [AudioPlayerState, AudioPlayerState] : K extends "preloadStateChanged" ? [PlayerPreloadState] : K extends "preloadPromoted" ? [Track] : never };
export type PlayerOutput = PlayerConnectionOutput | PlayerPreloadOutput | PlayerRecoveryOutput | PlayerResourceOutput;
export type PlayerBusEvents = PlayerInput | PlayerOutput;
export interface PlayerRequestReplyMap {
	"[Player]->[Connection]:connect": { success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connected" }>; progress: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connecting" }> };
	"[Player]->[Connection]:disconnect": { success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:disconnected" }> };
	"[Player]->[Connection]:reconnect": { success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connected" }>; progress: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connecting" }> };
	"[Player]->[Preload]:request": { success: Extract<PlayerPreloadOutput, { type: "[Preload]->[Player]:ready" }>; progress: Extract<PlayerPreloadOutput, { type: "[Preload]->[Player]:loading" }> };
	"[Player]->[Recovery]:recover": { success: Extract<PlayerRecoveryOutput, { type: "[Recovery]->[Player]:recovered" }>; progress: Extract<PlayerRecoveryOutput, { type: "[Recovery]->[Player]:retrying" }> };
	"[Player]->[Resource]:refresh": { success: Extract<PlayerResourceOutput, { type: "[Resource]->[Player]:refreshed" }> };
}
export type PlayerRequestInputType = keyof PlayerRequestReplyMap;
type Reply<K extends PlayerRequestInputType> = PlayerRequestReplyMap[K];
type Progress<K extends PlayerRequestInputType> = Reply<K> extends { progress: infer P } ? P : never;
interface RequestContract { success: PlayerOutput["type"]; error: PlayerOutput["type"]; progress?: PlayerOutput["type"] }
const REQUESTS: Record<PlayerRequestInputType, RequestContract> = {
	"[Player]->[Connection]:connect": { success: "[Connection]->[Player]:connected", error: "[Connection]->[Player]:error", progress: "[Connection]->[Player]:connecting" },
	"[Player]->[Connection]:disconnect": { success: "[Connection]->[Player]:disconnected", error: "[Connection]->[Player]:error" },
	"[Player]->[Connection]:reconnect": { success: "[Connection]->[Player]:connected", error: "[Connection]->[Player]:error", progress: "[Connection]->[Player]:connecting" },
	"[Player]->[Preload]:request": { success: "[Preload]->[Player]:ready", error: "[Preload]->[Player]:failed", progress: "[Preload]->[Player]:loading" },
	"[Player]->[Recovery]:recover": { success: "[Recovery]->[Player]:recovered", error: "[Recovery]->[Player]:failed", progress: "[Recovery]->[Player]:retrying" },
	"[Player]->[Resource]:refresh": { success: "[Resource]->[Player]:refreshed", error: "[Resource]->[Player]:error" },
};
export interface PlayerRequestOptions<K extends PlayerRequestInputType = PlayerRequestInputType> { timeoutMs?: number; signal?: AbortSignal; onProgress?: (event: Progress<K>) => void }
export type PlayerBusRequestErrorReason = "timeout" | "aborted" | "disposed" | "unhandled";
export class PlayerBusRequestError extends Error { public constructor(public readonly reason: PlayerBusRequestErrorReason, public readonly inputType: string, message: string) { super(message); this.name = "PlayerBusRequestError"; } }
export type PlayerQuery = keyof PlayerQueryMap;
export interface PlayerQueryMap { currentTrack: Track | null; queueCurrent: Track | null; playerState: PlaybackSessionSnapshot["status"] | "idle"; queue: Track[]; playbackSession: PlaybackSessionSnapshot | null; position: number | null; volume: number; isPlaying: boolean; isPaused: boolean }
export type PlayerQueryHandler<K extends PlayerQuery> = () => PlayerQueryMap[K] | Promise<PlayerQueryMap[K]>;
export class PlayerBus {
	private readonly inputListeners = new Map<PlayerInput["type"], Set<(event: PlayerInput) => void | Promise<void>>>();
	private readonly outputListeners = new Map<PlayerOutput["type"], Set<(event: PlayerOutput) => void>>();
	private readonly eventListeners = new Map<PlayerEventType, Set<(event: PlayerEvent) => void>>();
	private readonly actionListeners = new Set<(action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>>();
	private readonly queryHandlers = new Map<PlayerQuery, Set<PlayerQueryHandler<any>>>();
	private readonly pendingRequests = new Set<() => void>();
	private disposed = false;
	public emitInput(event: PlayerInput): void { if (!this.disposed) this.dispatch(this.inputListeners, event.type, event); }
	public emitOutput(event: PlayerOutput): void { if (!this.disposed) this.dispatch(this.outputListeners, event.type, event); }
	public onInput<K extends PlayerInput["type"]>(type: K, handler: (event: Extract<PlayerInput, { type: K }>) => void | Promise<void>): () => void { return this.addListener(this.inputListeners, type, handler as any); }
	public onOutput<K extends PlayerOutput["type"]>(type: K, handler: (event: Extract<PlayerOutput, { type: K }>) => void): () => void { return this.addListener(this.outputListeners, type, handler as any); }
	public request<K extends PlayerRequestInputType>(input: Extract<PlayerInput, { type: K }>, options: PlayerRequestOptions<K> = {}): Promise<Reply<K>["success"]> {
		if (this.disposed) return Promise.reject(new PlayerBusRequestError("disposed", input.type, `PlayerBus is disposed; cannot request "${input.type}"`));
		const requestId = input.requestId;
		if (!requestId) return Promise.reject(new PlayerBusRequestError("unhandled", input.type, `Input "${input.type}" has no requestId`));
		const contract = REQUESTS[input.type];
		return new Promise((resolve, reject) => {
			let settled = false; const cleanups: Array<() => void> = [];
			const settle = (fn: () => void) => { if (settled) return; settled = true; for (const cleanup of cleanups.splice(0)) cleanup(); this.pendingRequests.delete(cancel); fn(); };
			const cancel = () => settle(() => reject(new PlayerBusRequestError("disposed", input.type, `PlayerBus was disposed while awaiting reply to "${input.type}"`)));
			this.pendingRequests.add(cancel); cleanups.push(() => this.pendingRequests.delete(cancel));
			if (options.timeoutMs !== undefined) { const timer = setTimeout(() => settle(() => reject(new PlayerBusRequestError("timeout", input.type, `Timed out after ${options.timeoutMs}ms awaiting reply to "${input.type}"`))), options.timeoutMs); cleanups.push(() => clearTimeout(timer)); }
			if (options.signal) { if (options.signal.aborted) { settle(() => reject(new PlayerBusRequestError("aborted", input.type, `Request "${input.type}" was aborted`))); return; } const abort = () => settle(() => reject(new PlayerBusRequestError("aborted", input.type, `Request "${input.type}" was aborted`))); options.signal.addEventListener("abort", abort, { once: true }); cleanups.push(() => options.signal?.removeEventListener("abort", abort)); }
			cleanups.push(this.onOutput(contract.success, (event) => { if (event.requestId === requestId) settle(() => resolve(event as Reply<K>["success"])); }));
			cleanups.push(this.onOutput(contract.error, (event: any) => { if (event.requestId === requestId) settle(() => reject(event.error instanceof Error ? event.error : new PlayerBusRequestError("unhandled", input.type, String(event.error ?? "request failed")))); }));
			if (contract.progress && options.onProgress) cleanups.push(this.onOutput(contract.progress, (event) => { if (event.requestId === requestId && !settled) options.onProgress!(event as Progress<K>); }));
			this.emitInput(input);
		});
	}
	public action(action: PlayerAction, context?: PlayerActionExecutionContext): Promise<void> { if (this.disposed) return Promise.resolve(); const execution = context ?? { signal: new AbortController().signal, priority: action.priority ?? PlayerActionPriority.NORMAL, requestId: action.requestId ?? createPlayerRequestId() }; return Promise.all([...this.actionListeners].map((handler) => handler(action, execution))).then(() => undefined); }
	public onAction(handler: (action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>): () => void { this.actionListeners.add(handler); return () => this.actionListeners.delete(handler); }
	public event<K extends PlayerEventType>(event: Extract<PlayerEvent, { type: K }>): void { if (!this.disposed) this.dispatch(this.eventListeners, event.type, event); }
	public publish<K extends PlayerEventType>(type: K, ...args: PlayerEventArgsMap[K]): void { this.event(this.toEvent(type, args)); }
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void { return this.addListener(this.eventListeners, type, listener as any); }
	public registerQuery<K extends PlayerQuery>(query: K, handler: PlayerQueryHandler<K>): () => void { let handlers = this.queryHandlers.get(query); if (!handlers) { handlers = new Set(); this.queryHandlers.set(query, handlers); } handlers.add(handler); return () => handlers?.delete(handler); }
	public async query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> { if (this.disposed) return undefined as any; const handler = [...(this.queryHandlers.get(query) ?? [])][0] as PlayerQueryHandler<K> | undefined; return handler ? handler() : (undefined as any); }
	public clear(): void { for (const cancel of [...this.pendingRequests]) cancel(); this.inputListeners.clear(); this.outputListeners.clear(); this.eventListeners.clear(); this.actionListeners.clear(); this.queryHandlers.clear(); }
	public dispose(): void { if (this.disposed) return; this.disposed = true; this.clear(); }
	private toEvent<K extends PlayerEventType>(type: K, args: PlayerEventArgsMap[K]): Extract<PlayerEvent, { type: K }> { switch (type) { case "initialized": case "ready": case "destroyed": case "preloadCancelled": return { type } as any; case "TRACK_LOADING": case "TRACK_LOADED": case "TRACK_STARTED": case "TRACK_END": case "STREAM_ABORTED": case "playbackStateChanged": case "playbackSessionCreated": case "RECOVERY_STARTED": case "RECOVERY_FAILED": return { type, session: args[0] } as any; case "TRACK_ERROR": return { type, session: args[0], error: args[1] } as any; case "STUCK_DETECTED": return { type, session: args[0], reason: args[1] } as any; case "trackRequested": return { type, track: args[0], session: args[1] } as any; case "queueChanged": return { type, queue: args[0] } as any; case "volumeRequested": return { type, volume: args[0] } as any; case "stateChanged": return { type, oldState: args[0], newState: args[1] } as any; case "preloadStateChanged": return { type, state: args[0] } as any; case "preloadPromoted": return { type, track: args[0] } as any; } }
	private addListener<T extends string, E>(map: Map<T, Set<(event: E) => any>>, type: T, handler: (event: E) => any): () => void { let listeners = map.get(type); if (!listeners) { listeners = new Set(); map.set(type, listeners); } listeners.add(handler); return () => listeners?.delete(handler); }
	private dispatch<T extends string, E>(map: Map<T, Set<(event: E) => any>>, type: T, event: E): void { for (const listener of map.get(type) ?? []) void listener(event); }
}
export const createPlayerRequestId = (): PlayerRequestId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const createPlayerSessionId = (): PlayerSessionId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
