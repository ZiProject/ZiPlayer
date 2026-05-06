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

export abstract class BaseExtension implements SourceExtension {
	abstract name: string;
	abstract version: string;
	priority?: number; // Higher = run first
	abstract player: Player | null;
	abstract active(alas: any): boolean | Promise<boolean>;

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
