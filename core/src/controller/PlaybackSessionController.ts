import type { PlayerBus } from "../structures/PlayerBus";
import { PlaybackSession } from "../structures/PlaybackSession";
import type { Track } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/** Owns the active PlaybackSession and exposes it only through the internal Bus capability. */
export class PlaybackSessionController {
	private session: PlaybackSession | null = null;
	private pendingRetire: PlaybackSession | null = null;
	private readonly detachQuery: () => void;
	private readonly detachRetireRpc: () => void;
	private disposed = false;

	public constructor(private readonly bus: PlayerBus) {
		this.detachQuery = bus.registerQuery("playbackSessionInternal", () => this.session);
		this.detachRetireRpc = bus.registerRpc<void, void>(CONTROLLER_RPC.playbackSessionRetirePending, () =>
			this.retirePendingPrevious(),
		);
	}

	public get current(): PlaybackSession | null {
		return this.session;
	}

	public replace(track: Track, options?: { destroyPrevious?: boolean }): PlaybackSession {
		if (this.disposed) throw new Error("PlaybackSessionController is disposed");
		const previous = this.session;
		previous?.markStopped();
		if (options?.destroyPrevious ?? true) {
			previous?.destroy();
		} else if (previous) {
			this.pendingRetire = previous;
		}
		const session = new PlaybackSession();
		session.begin(track);
		this.session = session;
		return session;
	}
	public retirePendingPrevious(): void {
		const pending = this.pendingRetire;
		this.pendingRetire = null;
		pending?.destroy();
	}
	public clear(): void {
		this.retirePendingPrevious();
		this.session?.destroy();
		this.session = null;
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear();
		this.detachRetireRpc();
		this.detachQuery();
	}
}
