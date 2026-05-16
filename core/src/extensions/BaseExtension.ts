import type {
	SourceExtension,
	ExtensionContext,
	SearchResult,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionAfterPlayPayload,
	ExtensionStreamRequest,
	StreamInfo,
	ExtensionSearchRequest,
} from "../types";
import type { Player } from "../structures/Player";
import { EventEmitter } from "events";

export abstract class BaseExtension extends EventEmitter implements SourceExtension {
	abstract name: string;
	abstract version: string;
	priority?: number; // Higher = run first
	abstract player: Player | null;
	abstract active(alas: any): boolean | Promise<boolean>;

	// Player event forwarders
	protected forwardToPlayer(event: string, ...args: any[]): void {
		if (this.player && !this.player.destroyed) {
			this.player.emit(event as any, ...args);
		}
	}

	// Direct player control methods
	protected async playerPlayNext(): Promise<void> {
		if (this.player && !this.player.destroyed) {
			await (this.player as any).playNext();
		}
	}

	protected async playerSkip(): Promise<void> {
		if (this.player && !this.player.destroyed) {
			(this.player as any).skip();
		}
	}

	protected updatePlayerState(state: Partial<{ playing: boolean; paused: boolean; track: any }>): void {
		if (this.player && !this.player.destroyed) {
			// Update internal player state if needed
			if (state.track !== undefined && (this.player as any).queue) {
				(this.player as any).queue.setCurrentTrack(state.track);
			}
		}
	}

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
