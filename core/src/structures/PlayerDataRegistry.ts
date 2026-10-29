export const PLAYER_DATA_NAMESPACE_PREFIX = "@ziplayer/";

export class PlayerData extends Map<string, unknown> {
	private closed = false;

	public override set(key: string, value: unknown): this {
		if (this.closed) throw new Error("Player data is unavailable after the player is destroyed.");
		return super.set(key, value);
	}

	public override delete(key: string): boolean {
		return this.closed ? false : super.delete(key);
	}

	public override clear(): void {
		if (!this.closed) super.clear();
	}

	public dispose(): void {
		if (this.closed) return;
		super.clear();
		this.closed = true;
	}
}

export class PlayerDataRegistry {
	private static readonly registries = new WeakMap<object, PlayerDataRegistry>();
	private readonly players = new Map<string, Map<string, unknown>>();
	private readonly namespaceMaps = new Map<string, Map<string, unknown>>();
	private readonly closedPlayers = new Set<string>();

	public static for(scope: object): PlayerDataRegistry {
		let registry = this.registries.get(scope);
		if (!registry) {
			registry = new PlayerDataRegistry();
			this.registries.set(scope, registry);
		}
		return registry;
	}

	public attach(playerId: string, data: Map<string, unknown>): Map<string, unknown> {
		const existing = this.players.get(playerId);
		if (existing && !this.closedPlayers.has(playerId)) return existing;
		this.closedPlayers.delete(playerId);
		this.players.set(playerId, data);
		return data;
	}

	public disposePlayer(playerId: string): void {
		const data = this.players.get(playerId);
		if (data instanceof PlayerData) data.dispose();
		else data?.clear();
		this.players.delete(playerId);
		this.closedPlayers.add(playerId);
	}

	public playerDataMap<T>(namespace: string): Map<string, T> {
		const key = `${PLAYER_DATA_NAMESPACE_PREFIX}${namespace}`;
		let map = this.namespaceMaps.get(key);
		if (!map) {
			map = new PlayerDataNamespaceMap<unknown>(this, key);
			this.namespaceMaps.set(key, map);
		}
		return map as Map<string, T>;
	}

	private ensurePlayerData(playerId: string): Map<string, unknown> {
		if (this.closedPlayers.has(playerId)) throw new Error(`Cannot write data for destroyed player "${playerId}".`);
		let data = this.players.get(playerId);
		if (!data) {
			data = new PlayerData();
			this.players.set(playerId, data);
		}
		return data;
	}

	public getNamespaceValue<T>(playerId: string, namespace: string): T | undefined {
		return this.players.get(playerId)?.get(namespace) as T | undefined;
	}

	public hasNamespaceValue(playerId: string, namespace: string): boolean {
		return this.players.get(playerId)?.has(namespace) ?? false;
	}

	public setNamespaceValue<T>(playerId: string, namespace: string, value: T): void {
		this.ensurePlayerData(playerId).set(namespace, value);
	}

	public deleteNamespaceValue(playerId: string, namespace: string): boolean {
		return this.players.get(playerId)?.delete(namespace) ?? false;
	}

	public namespaceEntries<T>(namespace: string): Iterable<[string, T]> {
		const entries: Array<[string, T]> = [];
		for (const [playerId, data] of this.players) {
			if (data.has(namespace)) entries.push([playerId, data.get(namespace) as T]);
		}
		return entries;
	}
}

class PlayerDataNamespaceMap<T> implements Map<string, T> {
	public constructor(
		private readonly registry: PlayerDataRegistry,
		private readonly namespace: string,
	) {}

	get size(): number {
		return Array.from(this.entries()).length;
	}

	clear(): void {
		for (const [playerId] of this.entries()) this.registry.deleteNamespaceValue(playerId, this.namespace);
	}

	delete(playerId: string): boolean {
		return this.registry.deleteNamespaceValue(playerId, this.namespace);
	}

	forEach(callbackfn: (value: T, key: string, map: Map<string, T>) => void, thisArg?: any): void {
		for (const [key, value] of this.entries()) callbackfn.call(thisArg, value, key, this);
	}

	get(playerId: string): T | undefined {
		return this.registry.getNamespaceValue<T>(playerId, this.namespace);
	}

	has(playerId: string): boolean {
		return this.registry.hasNamespaceValue(playerId, this.namespace);
	}

	set(playerId: string, value: T): this {
		this.registry.setNamespaceValue(playerId, this.namespace, value);
		return this;
	}

	entries(): IterableIterator<[string, T]> {
		return new Map(this.registry.namespaceEntries<T>(this.namespace)).entries();
	}

	keys(): IterableIterator<string> {
		return Array.from(this.entries(), ([key]) => key).values();
	}

	values(): IterableIterator<T> {
		return Array.from(this.entries(), ([, value]) => value).values();
	}

	[Symbol.iterator](): IterableIterator<[string, T]> {
		return this.entries();
	}

	get [Symbol.toStringTag](): string {
		return "Map";
	}
}

export function playerDataMap<T>(scope: object, namespace: string): Map<string, T> {
	return PlayerDataRegistry.for(scope).playerDataMap<T>(namespace);
}
