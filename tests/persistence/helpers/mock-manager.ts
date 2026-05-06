import { EventEmitter } from "events";
import type { PlayerManager } from "../../../core/src/structures/PlayerManager";
import type { Player } from "../../../core/src/structures/Player";

export class MockPlayerManager extends EventEmitter {
	public debugEnabled: boolean = true;
	private players: Map<string, Player> = new Map();

	constructor() {
		super();
	}

	getAll(): Player[] {
		return Array.from(this.players.values());
	}

	get(guildId: string): Player | undefined {
		return this.players.get(guildId);
	}

	async create(guildId: string, options?: any): Promise<Player> {
		// Mock player creation
		const mockPlayer = {
			guildId,
			options: options || {},
			queue: {
				clear: () => {},
				loop: () => {},
				autoPlay: () => {},
				addMultiple: () => {},
				willNextTrack: () => {},
				loopMode: "off",
				autoPlayEnabled: false,
			},
			connection: true,
			setVolume: () => {},
			refreshPlayerResource: async () => true,
			play: async () => true,
			volume: 100,
			isPlaying: false,
			isPaused: false,
			upcomingTracks: [],
			currentTrack: null,
			previousTracks: [],
			getTime: () => ({ current: 0, total: 0, format: "00:00" }),
			filter: {
				getFilterString: () => "",
				applyFilters: async () => {},
			},
		} as unknown as Player;

		this.players.set(guildId, mockPlayer);
		return mockPlayer;
	}

	emit(event: string, ...args: any[]): boolean {
		return super.emit(event, ...args);
	}
}

export function createMockTrack(overrides: any = {}): any {
	return {
		id: overrides.id || `track_${Date.now()}`,
		title: overrides.title || "Test Track",
		url: overrides.url || "https://test.com/track",
		source: overrides.source || "youtube",
		duration: overrides.duration || 180000,
		thumbnail: overrides.thumbnail || "https://test.com/thumb.jpg",
		requestedBy: overrides.requestedBy || "user123",
		isLive: overrides.isLive || false,
		author: overrides.author || "Test Artist",
		artwork: overrides.artwork || "https://test.com/artwork.jpg",
		...overrides,
	};
}

export function createMockPlayer(overrides: any = {}): any {
	const tracks = overrides.tracks || [];
	const currentTrack = overrides.currentTrack || null;

	return {
		guildId: overrides.guildId || "guild123",
		volume: overrides.volume || 100,
		isPlaying: overrides.isPlaying || false,
		isPaused: overrides.isPaused || false,
		options: overrides.options || {},
		upcomingTracks: tracks,
		currentTrack: currentTrack,
		previousTracks: overrides.previousTracks || [],
		queue: {
			clear: () => {},
			loop: (mode?: string) => mode || overrides.loopMode || "off",
			autoPlay: (value?: boolean) => (value !== undefined ? value : overrides.autoPlay || false),
			addMultiple: () => {},
			willNextTrack: (track?: any) => track || null,
			loopMode: overrides.loopMode || "off",
			autoPlayEnabled: overrides.autoPlay || false,
		},
		connection: overrides.connection !== false,
		setVolume: (vol: number) => {
			overrides.volume = vol;
		},
		refreshPlayerResource: async (apply: boolean, position?: number) => true,
		play: async (track: any) => true,
		getTime: () => ({
			current: overrides.position || 0,
			total: overrides.duration || 180000,
			format: "00:00",
		}),
		filter: {
			getFilterString: () => overrides.filters?.join(",") || "",
			applyFilters: async (filters: string[]) => {
				overrides.filters = filters;
			},
		},
	};
}
