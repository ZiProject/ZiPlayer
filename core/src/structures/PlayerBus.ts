import type { VoiceChannel } from "../types";
import type { VoiceConnection } from "@discordjs/voice";

/** Correlates one request with its asynchronous response lifecycle. */
export type PlayerRequestId = string;
export type PlayerSessionId = string;

/** Player -> subsystem commands. */
export type PlayerInput = PlayerConnectionInput;

/** Subsystem -> Player state/events. */
export type PlayerOutput = PlayerConnectionOutput;

export type PlayerConnectionInput =
	| { type: "[Player]->[Connection]:connect"; requestId: PlayerRequestId; channel: VoiceChannel }
	| { type: "[Player]->[Connection]:disconnect"; requestId: PlayerRequestId; reason?: string }
	| { type: "[Player]->[Connection]:reconnect"; requestId: PlayerRequestId; channel: VoiceChannel };

export type PlayerConnectionOutput =
	| { type: "[Connection]->[Player]:connecting"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel }
	| { type: "[Connection]->[Player]:connected"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel; connection: VoiceConnection }
	| { type: "[Connection]->[Player]:disconnected"; requestId?: PlayerRequestId; sessionId: PlayerSessionId; reason?: string }
	| { type: "[Connection]->[Player]:error"; requestId: PlayerRequestId; sessionId?: PlayerSessionId; operation: "connect" | "disconnect" | "reconnect"; error: Error };

export interface PlayerBus {
	emitInput(event: PlayerInput): void;
	emitOutput(event: PlayerOutput): void;
	onInput<K extends PlayerInput["type"]>(type: K, handler: (event: Extract<PlayerInput, { type: K }>) => void | Promise<void>): () => void;
	onOutput<K extends PlayerOutput["type"]>(type: K, handler: (event: Extract<PlayerOutput, { type: K }>) => void): () => void;
}

export const createPlayerRequestId = (): PlayerRequestId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const createPlayerSessionId = (): PlayerSessionId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
