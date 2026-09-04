import type { PlayerBus } from "./PlayerBus";

/**
 * Runtime composition/lifecycle owner for a Player.
 *
 * Player is the public communication facade; this object owns the runtime
 * graph and is the only place that is responsible for shutting it down.
 * Controllers should never be reached from Player business methods.
 */
export class PlayerRuntimeController {
	private disposed = false;
	private readonly disposables = new Map<string, () => void | Promise<void>>();

	public constructor(public readonly bus: PlayerBus) {}

	public get isDisposed(): boolean {
		return this.disposed;
	}

	/** Register one runtime-owned subsystem/controller for teardown. */
	public monitor(name: string, controller: unknown): void {
		if (this.disposed) throw new Error(`PlayerRuntimeController is disposed; cannot register ${name}`);
		const dispose = this.resolveDispose(controller);
		if (dispose) this.disposables.set(name, dispose);
	}

	/** Register an explicit teardown hook for non-controller resources. */
	public monitorCleanup(name: string, cleanup: () => void | Promise<void>): void {
		if (this.disposed) throw new Error(`PlayerRuntimeController is disposed; cannot register ${name}`);
		this.disposables.set(name, cleanup);
	}

	/**
	 * Dispose in reverse registration order so dependencies are torn down after
	 * the workflows that use them.
	 */
	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		const entries = [...this.disposables.entries()].reverse();
		this.disposables.clear();
		for (const [name, cleanup] of entries) {
			try {
				await cleanup();
			} catch (error) {
				// Runtime teardown must be best-effort: one broken controller must
				// not prevent the remaining graph from being destroyed.
				this.bus.event({
					type: "TRACK_ERROR",
					session: {
						id: -1,
						track: null,
						resource: null,
						status: "destroyed",
						position: null,
						startedAt: null,
						} as any,
					error: error instanceof Error ? error : new Error(`${name} dispose failed: ${String(error)}`),
				});
			}
		}
	}

	private resolveDispose(controller: unknown): (() => void | Promise<void>) | null {
		if (!controller || typeof controller !== "object") return null;
		const value = controller as { dispose?: unknown; destroy?: unknown };
		if (typeof value.dispose === "function") return () => (value.dispose as () => void | Promise<void>)();
		if (typeof value.destroy === "function") return () => (value.destroy as () => void | Promise<void>)();
		return null;
	}
}
