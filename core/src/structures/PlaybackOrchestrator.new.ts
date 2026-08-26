import type { PlayerBus, PlayerAction } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession.new";
export class PlaybackOrchestrator {
	private session: PlaybackSession | null = null;
	private readonly detach: () => void;
	constructor(private readonly bus: PlayerBus) {
		this.detach = bus.onAction((action: PlayerAction) => this.handle(action));
	}
	get currentSession(): PlaybackSession | null { return this.session; }
	dispose(): void { this.detach(); this.session?.destroy(); this.session = null; }
	private async handle(action: PlayerAction): Promise<void> {
		switch (action.type) {
			case "play": if (action.track) this.start(action.track); break;
			case "pause": this.session?.markPaused(); break;
			case "resume": this.session?.markPlaying(); break;
			case "seek": this.session?.updatePosition(action.position); break;
			case "stop": this.session?.markStopped(); break;
			case "skip": this.session?.markEnded(); break;
		}
	}
	private start(track: import("../types").Track): void { this.session?.destroy(); this.session = new PlaybackSession(); this.session.begin(track); }
}
