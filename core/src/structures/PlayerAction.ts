import type { PlayerAction as PlayerActionMessage, PlayerActionType, PlayerBus } from "./PlayerBus";

type ActionHandler<A extends PlayerActionMessage> = (action: A) => void | Promise<void>;

/**
 * Serializes player actions independently from PlayerBus.
 *
 * PlayerBus is only responsible for communication/routing. PlayerAction owns
 * execution ordering and makes play/skip/stop/pause/etc. deterministic when
 * callers issue multiple operations concurrently.
 */
export class PlayerAction {
	private readonly handlers = new Map<PlayerActionType, Set<ActionHandler<any>>>();
	private tail: Promise<void> = Promise.resolve();
	private disposed = false;
	private readonly detachBus: () => void;

	public constructor(private readonly bus: PlayerBus) {
		this.detachBus = this.bus.onAction((action) => this.enqueue(action));
	}

	public on<K extends PlayerActionType>(
		type: K,
		handler: ActionHandler<Extract<PlayerActionMessage, { type: K }>>,
	): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler);
		return () => {
			handlers?.delete(handler);
			if (handlers?.size === 0) this.handlers.delete(type);
		};
	}

	public enqueue(action: PlayerActionMessage): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const run = this.tail.then(() => this.execute(action));
		this.tail = run.catch(() => undefined);
		return run;
	}

	public async idle(): Promise<void> {
		await this.tail;
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachBus();
		this.handlers.clear();
	}

	private async execute(action: PlayerActionMessage): Promise<void> {
		if (this.disposed) return;
		const handlers = this.handlers.get(action.type);
		if (!handlers?.size) return;
		await Promise.all([...handlers].map((handler) => handler(action)));
	}
}
