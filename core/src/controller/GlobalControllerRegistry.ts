import type { Bus } from "../structures/Bus";
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

/**
 * Process-wide controller registry.
 *
 * Controllers are owned by this registry rather than by an individual Player
 * instance. Every player shares the same Bus; the guild/player id is
 * the routing key used to find the controller graph.
 */
export class GlobalControllerRegistry<T = unknown> {
	private static readonly GLOBAL_KEY = Symbol.for("ziplayer.GlobalControllerRegistry");
	private readonly entries = new Map<string, GlobalControllerEntry<T>>();
	private readonly cleanups = new Map<string, () => void | Promise<void>>();
	private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
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
		this.entries.set(playerId, entry);
		this.cleanups.set(playerId, dispose);
		this.startHeartbeat(entry);

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
		return this.entries.get(playerId);
	}

	public has(playerId: string): boolean {
		return this.entries.has(playerId);
	}

	public async ping(playerId: string): Promise<boolean> {
		const entry = this.entries.get(playerId);
		if (!entry) return false;
		try {
			await entry.bus.requestRpc(playerId, CONTROLLER_RPC.runtimePing, { playerId }, { timeoutMs: this.pingTimeoutMs });
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
		const cleanup = this.cleanups.get(playerId);
		this.stopHeartbeat(playerId);
		this.entries.delete(playerId);
		this.cleanups.delete(playerId);
		if (cleanup) await cleanup();
	}

	public unregister(playerId: string): void {
		this.stopHeartbeat(playerId);
		this.entries.delete(playerId);
		this.cleanups.delete(playerId);
	}

	public clear(): void {
		for (const timer of this.timers.values()) clearInterval(timer);
		this.timers.clear();
		this.entries.clear();
		this.cleanups.clear();
	}

	private startHeartbeat(entry: GlobalControllerEntry<T>): void {
		const timer = setInterval(() => {
			void this.ping(entry.playerId);
		}, this.heartbeatMs);
		timer.unref?.();
		this.timers.set(entry.playerId, timer);
	}

	private stopHeartbeat(playerId: string): void {
		const timer = this.timers.get(playerId);
		if (timer) clearInterval(timer);
		this.timers.delete(playerId);
	}

	private async disposeIfStale(playerId: string, expected: GlobalControllerEntry<T>): Promise<void> {
		if (this.entries.get(playerId) !== expected) return;
		await this.dispose(playerId);
	}
}

export const globalControllerRegistry = GlobalControllerRegistry.global();
