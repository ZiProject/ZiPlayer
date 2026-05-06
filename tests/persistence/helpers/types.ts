import type { PlayerManager } from "../../../core/src/structures/PlayerManager";

export interface IMockPlayerManager extends Partial<PlayerManager> {
	debugEnabled: boolean;
	getAll(): any[];
	get(guildId: string): any;
	create(guildId: string, options?: any): Promise<any>;
	delete(guildId: string): boolean;
	destroy(): void;
	size: number;
	emit(event: string, ...args: any[]): boolean;
	on(event: string, listener: (...args: any[]) => void): this;
}

// Use type assertion when passing to PersistenceManager
// (mockManager as unknown as PlayerManager)
