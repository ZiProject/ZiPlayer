import type { VoiceConnection } from "@discordjs/voice";
import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Track, SearchResult, StreamInfo } from ".";

/**
 * Extension interface
 *
 * @example
 * const extension: SourceExtension = {
 *   name: "YouTube",
 *   version: "1.0.0"
 * };
 */
export interface SourceExtension {
	name: string;
	version: string;
	connection?: VoiceConnection;
	player: Player | null;
	active(alas: any): boolean | Promise<boolean>;
	onRegister?(context: ExtensionContext): void | Promise<void>;
	onDestroy?(context: ExtensionContext): void | Promise<void>;
	beforePlay?(
		context: ExtensionContext,
		payload: ExtensionPlayRequest,
	): Promise<ExtensionPlayResponse | void> | ExtensionPlayResponse | void;
	afterPlay?(context: ExtensionContext, payload: ExtensionAfterPlayPayload): Promise<void> | void;
	provideSearch?(
		context: ExtensionContext,
		payload: ExtensionSearchRequest,
	): Promise<SearchResult | null | undefined> | SearchResult | null | undefined;
	provideStream?(
		context: ExtensionContext,
		payload: ExtensionStreamRequest,
	): Promise<StreamInfo | null | undefined> | StreamInfo | null | undefined;
}

/**
 * Context for the extension
 *
 * @example
 * const context: ExtensionContext = {
 *   player: player,
 *   manager: manager
 * };
 */
export interface ExtensionContext {
	player: Player;
	manager: PlayerManager;
}

/**
 * Request for the extension to play a track
 *
 * @example
 * const request: ExtensionPlayRequest = {
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionPlayRequest {
	query: string | Track;
	requestedBy?: string;
}

/**
 * Response for the extension to play a track
 *
 * @example
 * const response: ExtensionPlayResponse = {
 *   handled: true,
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionPlayResponse {
	handled?: boolean;
	query?: string | Track;
	requestedBy?: string;
	tracks?: Track[];
	isPlaylist?: boolean;
	success?: boolean;
	error?: Error;
}

/**
 * Payload for the extension to play a track
 *
 * @example
 * const payload: ExtensionAfterPlayPayload = {
 *   success: true,
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionAfterPlayPayload {
	success: boolean;
	query: string | Track;
	requestedBy?: string;
	tracks?: Track[];
	isPlaylist?: boolean;
	error?: Error;
}

/**
 * Request for the extension to stream a track
 *
 * @example
 * const request: ExtensionStreamRequest = {
 *   track: track
 * };
 */
export interface ExtensionStreamRequest {
	track: Track;
}

/**
 * Request for the extension to search for a track
 *
 * @example
 * const request: ExtensionSearchRequest = {
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionSearchRequest {
	query: string;
	requestedBy: string;
}
