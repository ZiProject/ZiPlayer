import type { PlayerBus } from "../structures/PlayerBus";
import { PlaybackSession } from "../structures/PlaybackSession";
import type { Track } from "../types";

/** Owns the active PlaybackSession and exposes it only through the internal Bus capability. */
export class PlaybackSessionController {
	private session: PlaybackSession | null = null;
	private readonly detachQuery: () => void;
	private disposed = false;

	public constructor(private readonly bus: PlayerBus) {
		this.detachQuery = bus.registerQuery("playbackSessionInternal", () => this.session);
	}

	public get current(): PlaybackSession | null {
		return this.session;
	}

	public replace(track: Track): PlaybackSession {
		if (this.disposed) throw new Error("PlaybackSessionController is disposed");
		this.session?.markStopped();
		this.session?.destroy();
		const session = new PlaybackSession();
		session.begin(track);
		this.session = session;
		return session;
	}

	public clear(): void {
		this.session?.destroy();
		this.session = null;
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear();
		this.detachQuery();
	}
}
