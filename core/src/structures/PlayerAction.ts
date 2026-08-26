import type { PlayerAction as PlayerActionMessage, PlayerBus } from "./PlayerBus";

/**
 * Execution boundary for Player actions.
 *
 * PlayerBus remains a communication layer. PlayerAction owns the ordering of
 * actions so concurrent play/skip/stop/pause/resume calls are executed in the
 * order they were submitted.
 */
export class PlayerAction {
	private tail: Promise<void> = Promise.resolve();
	private disposed = false;

	public constructor(private readonly bus: PlayerBus) {}

	public enqueue(action: PlayerActionMessage): Promise<void> {
		if (this.disposed) return Promise.resolve();

		const run = this.tail.then(() => {
			if (this.disposed) return;
			return this.bus.action(action);
		});

		this.tail = run.catch(() => undefined);
		return run;
	}

	public async idle(): Promise<void> {
		await this.tail;
	}

	public dispose(): void {
		this.disposed = true;
	}
}
