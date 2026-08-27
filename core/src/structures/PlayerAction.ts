import {
	createPlayerRequestId,
	PlayerActionPriority,
	type PlayerAction as PlayerActionMessage,
	type PlayerActionExecutionContext,
	type PlayerBus,
} from "./PlayerBus";

interface PendingAction {
	action: PlayerActionMessage;
	resolve: () => void;
	reject: (error: unknown) => void;
	priority: PlayerActionPriority;
}

interface RunningAction {
	controller: AbortController;
	priority: PlayerActionPriority;
	promise: Promise<void>;
}

/**
 * Execution boundary for Player actions.
 *
 * Normal actions are serialized, while CRITICAL actions (notably SKIP/STOP)
 * may preempt an in-flight action immediately. Preemption aborts the current
 * execution context; playback work must additionally honour its PlaybackSession
 * signal so stale async work cannot mutate the active player state.
 */
export class PlayerAction {
	private readonly pending: PendingAction[] = [];
	private running: RunningAction | null = null;
	private criticalRunning = 0;
	private disposed = false;
	private idleWaiters: Array<() => void> = [];

	public constructor(private readonly bus: PlayerBus) {}

	public enqueue(action: PlayerActionMessage): Promise<void> {
		if (this.disposed) return Promise.resolve();

		const priority = action.priority ?? this.defaultPriority(action);
		const requestId = action.requestId ?? createPlayerRequestId();
		const normalized = { ...action, priority, requestId } as PlayerActionMessage;

		if (priority >= PlayerActionPriority.CRITICAL) {
			this.preempt(normalized);
			return this.runCritical(normalized);
		}

		return new Promise<void>((resolve, reject) => {
			this.pending.push({ action: normalized, resolve, reject, priority });
			this.sortPending();
			this.drain();
		});
	}

	public async idle(): Promise<void> {
		if (!this.running && this.criticalRunning === 0 && this.pending.length === 0) return;
		await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.running?.controller.abort();
		for (const pending of this.pending.splice(0)) pending.resolve();
		this.flushIdleWaiters();
	}

	private preempt(action: PlayerActionMessage): void {
		this.running?.controller.abort();
		const priority = action.priority ?? PlayerActionPriority.CRITICAL;
		for (let index = this.pending.length - 1; index >= 0; index -= 1) {
			if (this.pending[index].priority < priority) {
				this.pending[index].resolve();
				this.pending.splice(index, 1);
			}
		}
	}

	private runCritical(action: PlayerActionMessage): Promise<void> {
		const controller = new AbortController();
		const context: PlayerActionExecutionContext = {
			signal: controller.signal,
			priority: action.priority ?? PlayerActionPriority.CRITICAL,
			requestId: action.requestId ?? createPlayerRequestId(),
		};
		this.criticalRunning += 1;
		return this.bus.action(action, context).finally(() => {
			this.criticalRunning -= 1;
			this.drain();
			this.flushIdleWaiters();
		});
	}

	private drain(): void {
		if (this.disposed || this.running || this.criticalRunning > 0 || this.pending.length === 0) {
			this.flushIdleWaiters();
			return;
		}

		const pending = this.pending.shift()!;
		const controller = new AbortController();
		const context: PlayerActionExecutionContext = {
			signal: controller.signal,
			priority: pending.priority,
			requestId: pending.action.requestId ?? createPlayerRequestId(),
		};
		const promise = this.bus.action(pending.action, context);
		this.running = { controller, priority: pending.priority, promise };

		promise.then(pending.resolve, pending.reject).finally(() => {
			if (this.running?.promise === promise) this.running = null;
			this.drain();
			this.flushIdleWaiters();
		});
	}

	private sortPending(): void {
		this.pending.sort((a, b) => b.priority - a.priority);
	}

	private defaultPriority(action: PlayerActionMessage): PlayerActionPriority {
		switch (action.type) {
			case "SKIP":
			case "STOP":
				return PlayerActionPriority.CRITICAL;
			case "PAUSE":
			case "RESUME":
			case "SEEK":
			case "SET_VOLUME":
				return PlayerActionPriority.HIGH;
			case "PLAY":
			default:
				return PlayerActionPriority.NORMAL;
		}
	}

	private flushIdleWaiters(): void {
		if (this.running || this.criticalRunning > 0 || this.pending.length > 0) return;
		const waiters = this.idleWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}
}
