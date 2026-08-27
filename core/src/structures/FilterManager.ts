import type { AudioFilter, StreamInfo } from "../types";
import type { Player } from "./Player";
import type { PlayerManager } from "./PlayerManager";
import { FilterController } from "../Controller/FilterController";

/** @deprecated Use FilterController. Compatibility adapter only. */
export class FilterManager extends FilterController {
	constructor(player: Player, manager: PlayerManager) {
		super(player, (message?: any, ...optionalParams: any[]) => {
			if (manager.debugEnabled) manager.emit("debug", `[FilterManager] ${message}`, ...optionalParams);
		});
	}

	public async applyFilter(filter?: string | AudioFilter): Promise<boolean> {
		return super.applyFilter(filter);
	}
	public async applyFilters(filters: (string | AudioFilter)[]): Promise<boolean> {
		return super.applyFilters(filters);
	}
	public async removeFilter(filterName: string): Promise<boolean> {
		return super.removeFilter(filterName);
	}
	public async clearAll(): Promise<boolean> {
		return super.clearAll();
	}
	public async applyFiltersAndSeek(streamInfo: StreamInfo, position = -1): Promise<StreamInfo & { wasRecreated?: boolean }> {
		return super.applyFiltersAndSeek(streamInfo, position);
	}
}
