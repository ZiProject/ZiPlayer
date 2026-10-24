import type { Bus } from "../structures/Bus";
import { playerDataMap } from "../structures/PlayerDataRegistry";
import { CONTROLLER_RPC } from "../structures/BusContract";

export interface GlobalControllerEntry<T = unknown> {
	readonly playerId: string;
	readonly bus: Bus;
	readonly graph: T;
	readonly registeredAt: number;
	lastPingAt: number;
	unreachableSince?: number;
}

export interface GlobalControllerRegistration<T = unknown> {
	readonly entry: GlobalControllerEntry<T>;
	unregister(): void;
	ping(): Promise<boolean>;
}

interface GlobalControllerSlot<T> {
	entry: GlobalControllerEntry<T>;
	cleanup: () => void | Promise<void>;
	timer: ReturnType<typeof setInterval>;
}

/**
 * Process-wide controller registry.
 *
 * Controllers are owned by this registry rather than by an individual Player
 * instance. Every player shares the same Bus; the guild/player id is
 * the routing key used to find the controller graph.
 */
export class GlobalControllerRegistry<T = unknown> {
	private static readonly GLOBAL_KEY = Symbol.for("ziplayer.GlobalControllerRegistry");
	private static nextNamespace = 0;
	private readonly buses = new Set<Bus>();
	private readonly namespace = `controller.globalRegistry.${++GlobalControllerRegistry.nextNamespace}`;
	private readonly heartbeatMs: number;
	private readonly pingTimeoutMs: number;
	private readonly staleAfterMs: number;

	public static global<T = unknown>(options?: {
		heartbeatMs?: number;
		pingTimeoutMs?: number;
		staleAfterMs?: number;
	}): GlobalControllerRegistry<T> {
		const root = globalThis as typeof globalThis & {
			[GlobalControllerRegistry.GLOBAL_KEY]?: GlobalControllerRegistry<T>;
		};
		const existing = root[GlobalControllerRegistry.GLOBAL_KEY];
		if (existing) return existing;
		const registry = new GlobalControllerRegistry<T>(options);
		root[GlobalControllerRegistry.GLOBAL_KEY] = registry;
		return registry;
	}

	public constructor(options: { heartbeatMs?: number; pingTimeoutMs?: number; staleAfterMs?: number } = {}) {
		this.heartbeatMs = Math.max(1000, options.heartbeatMs ?? 2000);
		this.pingTimeoutMs = Math.max(250, options.pingTimeoutMs ?? 1000);
		this.staleAfterMs = Math.max(10_000, options.staleAfterMs ?? 10_000);
	}

	public register(playerId: string, bus: Bus, graph: T, dispose: () => void | Promise<void>): GlobalControllerRegistration<T> {
		this.unregister(playerId);
		const now = Date.now();
		const entry: GlobalControllerEntry<T> = {
			playerId,
			bus,
			graph,
			registeredAt: now,
			lastPingAt: now,
		};
		this.buses.add(bus);
		const slot: GlobalControllerSlot<T> = {
			entry,
			cleanup: dispose,
			timer: setInterval(() => {
				void this.ping(playerId);
			}, this.heartbeatMs),
		};
		slot.timer.unref?.();
		this.slots(bus).set(playerId, slot);

		let active = true;
		return {
			entry,
			unregister: () => {
				if (!active) return;
				active = false;
				this.unregister(playerId);
			},
			ping: () => this.ping(playerId),
		};
	}

	public get(playerId: string): GlobalControllerEntry<T> | undefined {
		return this.findSlot(playerId)?.entry;
	}

	public has(playerId: string): boolean {
		return this.findSlot(playerId) !== undefined;
	}

	public async ping(playerId: string): Promise<boolean> {
		const slot = this.findSlot(playerId);
		const entry = slot?.entry;
		if (!entry) return false;
		try {
			const alive = await entry.bus.requestRpc<{ playerId: string }, boolean>(
				playerId,
				CONTROLLER_RPC.runtimePing,
				{ playerId },
				{ timeoutMs: this.pingTimeoutMs },
			);
			if (alive !== true) throw new Error(`runtime.ping did not confirm "${playerId}" is alive.`);
			entry.lastPingAt = Date.now();
			entry.unreachableSince = undefined;
			return true;
		} catch {
			const now = Date.now();
			entry.unreachableSince ??= now;
			if (now - entry.unreachableSince >= this.staleAfterMs) {
				await this.disposeIfStale(playerId, entry);
			}
			return false;
		}
	}

	public async dispose(playerId: string): Promise<void> {
		const found = this.findSlot(playerId);
		if (!found) return;
		clearInterval(found.timer);
		const slots = this.slots(found.entry.bus);
		slots.delete(playerId);
		if (slots.size === 0) this.buses.delete(found.entry.bus);
		await found.cleanup();
	}

	public unregister(playerId: string): void {
		for (const bus of [...this.buses]) {
			const slots = this.slots(bus);
			const slot = slots.get(playerId);
			if (!slot) continue;
			clearInterval(slot.timer);
			slots.delete(playerId);
			if (slots.size === 0) this.buses.delete(bus);
		}
	}

	public clear(): void {
		for (const bus of [...this.buses]) {
			const slots = this.slots(bus);
			for (const [, slot] of slots) clearInterval(slot.timer);
			slots.clear();
		}
		this.buses.clear();
	}

	private slots(bus: Bus): Map<string, GlobalControllerSlot<T>> {
		return playerDataMap(bus, this.namespace);
	}

	private findSlot(playerId: string): GlobalControllerSlot<T> | undefined {
		for (const bus of this.buses) {
			const slot = this.slots(bus).get(playerId);
			if (slot) return slot;
		}
		return undefined;
	}

	private async disposeIfStale(playerId: string, expected: GlobalControllerEntry<T>): Promise<void> {
		if (this.findSlot(playerId)?.entry !== expected) return;
		await this.dispose(playerId);
	}
}

export const globalControllerRegistry = GlobalControllerRegistry.global();
