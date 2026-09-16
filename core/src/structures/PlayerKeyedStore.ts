import { currentPlayerId, type PlayerId } from "./playerScope";

/** Per-player value map used by singleton controllers. */
export class PlayerKeyedStore<T> {
	private readonly values = new Map<PlayerId, T>();

	public constructor(
		private readonly factory: (playerId: PlayerId) => T,
		private readonly disposeValue?: (value: T, playerId: PlayerId) => void,
	) {}

	public get(playerId: PlayerId = currentPlayerId()): T {
		let value = this.values.get(playerId);
		if (!value) {
			value = this.factory(playerId);
			this.values.set(playerId, value);
		}
		return value;
	}

	public peek(playerId: PlayerId = currentPlayerId()): T | undefined {
		return this.values.get(playerId);
	}

	public has(playerId: PlayerId): boolean {
		return this.values.has(playerId);
	}

	public delete(playerId: PlayerId): boolean {
		const value = this.values.get(playerId);
		if (value === undefined) return false;
		this.values.delete(playerId);
		this.disposeValue?.(value, playerId);
		return true;
	}

	public clear(): void {
		for (const playerId of [...this.values.keys()]) this.delete(playerId);
	}

	public ids(): PlayerId[] {
		return [...this.values.keys()];
	}

	public get size(): number {
		return this.values.size;
	}
}
