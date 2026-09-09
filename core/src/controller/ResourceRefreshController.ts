import type { PlayerBus, PlayerInput } from "../structures/PlayerBus";

export interface ResourceRefreshControllerOptions {
	bus: PlayerBus;
}

/** Bridges Player resource refresh requests to playback.refreshResource RPC. */
export class ResourceRefreshController {
	private readonly detach: () => void;

	constructor(options: ResourceRefreshControllerOptions) {
		this.detach = options.bus.onInput("[Player]->[Resource]:refresh", (event) => {
			void this.handleRefresh(event);
		});
	}

	dispose(): void {
		this.detach();
	}

	private async handleRefresh(event: Extract<PlayerInput, { type: "[Player]->[Resource]:refresh" }>): Promise<void> {
		const { bus } = this;
		try {
			const session = await bus.requestRpc("playback.refreshResource", { position: event.position ?? 0 });
			bus.emitOutput({ type: "[Resource]->[Player]:refreshed", requestId: event.requestId, session });
		} catch (error) {
			bus.emitOutput({
				type: "[Resource]->[Player]:error",
				requestId: event.requestId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
}
