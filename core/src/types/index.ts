import { VoiceConnection } from "@discordjs/voice";
import { Readable } from "stream";
import { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";

/**
 * Represents a music track with metadata and streaming information.
 *
 * @example
 * // Basic track from YouTube
 * const track: Track = {
 *   id: "dQw4w9WgXcQ",
 *   title: "Never Gonna Give You Up",
 *   url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
 *   duration: 212000,
 *   thumbnail: "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
 *   requestedBy: "123456789",
 *   source: "youtube",
 *   metadata: {
 *     artist: "Rick Astley",
 *     album: "Whenever You Need Somebody"
 *   }
 * };
 *
 * // Track from SoundCloud
 * const soundcloudTrack: Track = {
 *   id: "soundcloud-track-123",
 *   title: "Electronic Song",
 *   url: "https://soundcloud.com/artist/electronic-song",
 *   duration: 180000,
 *   requestedBy: "user456",
 *   source: "soundcloud",
 *   metadata: {
 *     artist: "Electronic Artist",
 *     genre: "Electronic"
 *   }
 * };
 *
 * // TTS track
 * const ttsTrack: Track = {
 *   id: "tts-" + Date.now(),
 *   title: "TTS: Hello everyone!",
 *   url: "tts: Hello everyone!",
 *   duration: 5000,
 *   requestedBy: "user789",
 *   source: "tts",
 *   metadata: {
 *     text: "Hello everyone!",
 *     language: "en"
 *   }
 * };
 */
export interface Track {
	id: string;
	title: string;
	url: string;
	duration: number;
	thumbnail?: string;
	requestedBy: string;
	source: string;
	metadata?: Record<string, any>;
}

/**
 * Contains search results from plugins, including tracks and optional playlist information.
 *
 * @example
 * const result: SearchResult = {
 *   tracks: [
 *     {
 *       id: "track1",
 *       title: "Song 1",
 *       url: "https://example.com/track1",
 *       duration: 180000,
 *       requestedBy: "user123",
 *       source: "youtube"
 *     }
 *   ],
 *   playlist: {
 *     name: "My Playlist",
 *     url: "https://example.com/playlist",
 *     thumbnail: "https://example.com/thumb.jpg"
 *   }
 * };
 */
export interface SearchResult {
	tracks: Track[];
	playlist?: {
		name: string;
		url: string;
		thumbnail?: string;
	};
}

/**
 * Contains streaming information for audio playback.
 *
 * @example
 * const streamInfo: StreamInfo = {
 *   stream: audioStream,
 *   type: "webm/opus",
 *   metadata: {
 *     bitrate: 128000,
 *     sampleRate: 48000
 *   }
 * };
 */
export interface StreamInfo {
	stream: Readable;
	type: "webm/opus" | "ogg/opus" | "arbitrary";
	metadata?: Record<string, any>;
}

/**
 * Configuration options for creating a new player instance.
 *
 * @example
 * const options: PlayerOptions = {
 *   leaveOnEnd: true,
 *   leaveOnEmpty: true,
 *   leaveTimeout: 30000,
 *   volume: 0.5,
 *   quality: "high",
 *   selfDeaf: false,
 *   selfMute: false,
 *   extractorTimeout: 10000,
 *   tts: {
 *     createPlayer: true,
 *     interrupt: true,
 *     volume: 1.0,
 *     Max_Time_TTS: 30000
 *   }
 * };
 */
export interface PlayerOptions {
	leaveOnEnd?: boolean;
	leaveOnEmpty?: boolean;
	leaveTimeout?: number;
	volume?: number;
	quality?: "high" | "low";
	selfDeaf?: boolean;
	selfMute?: boolean;
	/**
	 * Timeout in milliseconds for plugin operations (search, streaming, etc.)
	 * to prevent long-running tasks from blocking the player.
	 */
	extractorTimeout?: number;
	userdata?: Record<string, any>;
	/**
	 * Text-to-Speech settings. When enabled, the player can create a
	 * dedicated AudioPlayer to play TTS while pausing the music player
	 * then resume the music after TTS finishes.
	 */
	tts?: {
		/** Create a dedicated tts AudioPlayer at construction time */
		createPlayer?: boolean;
		/** Pause music and swap subscription to play TTS */
		interrupt?: boolean;
		/** Default TTS volume multiplier 1 => 100% */
		volume?: number;
		/** Max time tts playback Duration */
		Max_Time_TTS?: number;
	};
	/**
	 * Optional per-player extension selection. When provided, only these
	 * extensions will be activated for the created player.
	 * - Provide instances or constructors to use them explicitly
	 * - Or provide names (string) to select from manager-registered extensions
	 */
	extensions?: any[] | string[];
	/**
	 * Audio filters configuration. When provided, these filters will be
	 * applied to all audio streams played by this player.
	 * - Provide filter names (string) to use predefined filters
	 * - Or provide AudioFilter objects for custom filters
	 * - Multiple filters can be combined
	 */
	filters?: (string | AudioFilter)[];
}

/**
 * Constructor for a SourcePlugin
 *
 * @example
 * const plugin = new YouTubePlugin();
 * console.log(`Plugin: ${plugin.name}`);
 */
export type SourcePluginCtor<T extends SourcePlugin = SourcePlugin> = new (...args: any[]) => T;

/**
 * SourcePlugin or SourcePluginCtor
 *
 * @example
 * const plugin = new YouTubePlugin();
 * console.log(`Plugin: ${plugin.name}`);
 */
export type SourcePluginLike = SourcePlugin | SourcePluginCtor;

/**
 * Configuration options for creating a PlayerManager instance.
 *
 * @example
 * const managerOptions: PlayerManagerOptions = {
 *   plugins: [
 *     new YouTubePlugin(),
 *     new SoundCloudPlugin(),
 *     new SpotifyPlugin(),
 *     new TTSPlugin({ defaultLang: "en" })
 *   ],
 *   extensions: [
 *     new voiceExt(null, { lang: "en-US" }),
 *     new lavalinkExt(null, { nodes: [...] })
 *   ],
 *   extractorTimeout: 10000
 * };
 */
export interface PlayerManagerOptions {
	plugins?: SourcePluginLike[];
	extensions?: any[];
	/**
	 * Timeout in milliseconds for manager-level operations (e.g. search)
	 * when running without a Player instance.
	 */
	extractorTimeout?: number;
}

/**
 * Options for the progress bar
 *
 * @example
 * const options: ProgressBarOptions = {
 *   size: 10,
 *   barChar: "=",
 *   progressChar: ">"
 * };
 */
export interface ProgressBarOptions {
	size?: number;
	barChar?: string;
	progressChar?: string;
}

/**
 * Options for saving tracks
 *
 * @example
 * const options: SaveOptions = {
 *   filename: "my-song.mp3",
 *   quality: "high",
 *   timeout: 30000
 * };
 */
export interface SaveOptions {
	/** Optional filename for the saved file */
	filename?: string;
	/** Quality of the saved audio ("high" | "low") */
	quality?: "high" | "low";
	/** Timeout in milliseconds for the save operation */
	timeout?: number;
	/** Additional metadata to include */
	metadata?: Record<string, any>;
}

export type LoopMode = "off" | "track" | "queue";

/**
 * Audio filter configuration for applying effects to audio streams.
 * Based on FFmpeg audio filters for Discord music bots.
 *
 * @example
 * // Bass boost filter
 * const bassFilter: AudioFilter = {
 *   name: "bassboost",
 *   ffmpegFilter: "bass=g=10:f=110:w=0.5",
 *   description: "Tăng âm trầm"
 * };
 *
 * // Nightcore filter (speed + pitch)
 * const nightcoreFilter: AudioFilter = {
 *   name: "nightcore",
 *   ffmpegFilter: "atempo=1.25,asetrate=44100*1.25",
 *   description: "Tăng tốc độ và cao độ"
 * };
 *
 * // Custom filter
 * const customFilter: AudioFilter = {
 *   name: "custom",
 *   ffmpegFilter: "volume=1.5,treble=g=5",
 *   description: "Tăng âm lượng và âm cao"
 * };
 */
export interface AudioFilter {
	/** Unique name identifier for the filter */
	name: string;
	/** FFmpeg audio filter string */
	ffmpegFilter: string;
	/** Human-readable description of the filter */
	description: string;
	/** Optional category for grouping filters */
	category?: string;
	/** Optional parameters for dynamic filter generation */
	parameters?: Record<string, any>;
}

/**
 * Predefined audio filters commonly used in Discord music bots.
 * These filters are based on popular FFmpeg audio filter combinations.
 */
export const PREDEFINED_FILTERS: Record<string, AudioFilter> = {
	bassboost: {
		name: "bassboost",
		ffmpegFilter: "bass=g=10:f=110:w=0.5",
		description: "Tăng âm trầm",
		category: "eq",
	},
	nightcore: {
		name: "nightcore",
		ffmpegFilter: "aresample=48000,asetrate=48000*1.5",
		description: "Tăng tốc độ và cao độ",
		category: "speed",
	},
	vaporwave: {
		name: "vaporwave",
		ffmpegFilter: "aresample=48000,asetrate=48000*0.8",
		description: "Giảm tốc độ và cao độ",
		category: "speed",
	},
	trebleboost: {
		name: "trebleboost",
		ffmpegFilter: "treble=g=10:f=3000:w=0.5",
		description: "Tăng âm cao",
		category: "eq",
	},
	karaoke: {
		name: "karaoke",
		ffmpegFilter: "stereotools=mlev=0.1",
		description: "Giảm giọng hát (karaoke)",
		category: "vocal",
	},
	chorus: {
		name: "chorus",
		ffmpegFilter: "chorus=0.5:0.9:50:0.4:0.25:2",
		description: "Hiệu ứng chorus",
		category: "effect",
	},
	flanger: {
		name: "flanger",
		ffmpegFilter: "flanger=delay=10:depth=2:regen=0:width=71:speed=0.5",
		description: "Hiệu ứng flanger",
		category: "effect",
	},
	phaser: {
		name: "phaser",
		ffmpegFilter: "aphaser=in_gain=0.4:out_gain=0.74:delay=3.0:decay=0.4:speed=0.5",
		description: "Hiệu ứng phaser",
		category: "effect",
	},
	tremolo: {
		name: "tremolo",
		ffmpegFilter: "tremolo=f=4.0:d=0.5",
		description: "Hiệu ứng tremolo",
		category: "effect",
	},
	vibrato: {
		name: "vibrato",
		ffmpegFilter: "vibrato=f=5.5:d=0.5",
		description: "Hiệu ứng vibrato",
		category: "effect",
	},
	reverse: {
		name: "reverse",
		ffmpegFilter: "areverse",
		description: "Phát ngược",
		category: "effect",
	},
	normalize: {
		name: "normalize",
		ffmpegFilter: "loudnorm",
		description: "Chuẩn hóa âm lượng",
		category: "volume",
	},
	compressor: {
		name: "compressor",
		ffmpegFilter: "acompressor=threshold=0.089:ratio=9:attack=200:release=1000",
		description: "Nén âm thanh",
		category: "dynamics",
	},
	limiter: {
		name: "limiter",
		ffmpegFilter: "alimiter=level_in=1:level_out=0.8:limit=0.9",
		description: "Giới hạn âm lượng",
		category: "dynamics",
	},
	gate: {
		name: "gate",
		ffmpegFilter: "agate=threshold=0.01:ratio=2:attack=1:release=100",
		description: "Cổng âm thanh",
		category: "dynamics",
	},
	lowpass: {
		name: "lowpass",
		ffmpegFilter: "lowpass=f=3000",
		description: "Lọc thông thấp",
		category: "filter",
	},
	highpass: {
		name: "highpass",
		ffmpegFilter: "highpass=f=200",
		description: "Lọc thông cao",
		category: "filter",
	},
	bandpass: {
		name: "bandpass",
		ffmpegFilter: "bandpass=f=1000:csg=1",
		description: "Lọc thông dải",
		category: "filter",
	},
	bandreject: {
		name: "bandreject",
		ffmpegFilter: "bandreject=f=1000:csg=1",
		description: "Lọc chặn dải",
		category: "filter",
	},
	allpass: {
		name: "allpass",
		ffmpegFilter: "allpass=f=1000:width_type=h:width=200",
		description: "Lọc thông tất cả",
		category: "filter",
	},
	equalizer: {
		name: "equalizer",
		ffmpegFilter: "equalizer=f=1000:width_type=h:width=200:g=5",
		description: "Equalizer",
		category: "eq",
	},
	reverb: {
		name: "reverb",
		ffmpegFilter: "aecho=0.8:0.88:60:0.4",
		description: "Hiệu ứng reverb",
		category: "effect",
	},
	delay: {
		name: "delay",
		ffmpegFilter: "aecho=0.8:0.9:1000:0.3",
		description: "Hiệu ứng delay",
		category: "effect",
	},
	distortion: {
		name: "distortion",
		ffmpegFilter: "acrusher=bits=8:mode=log:aa=1",
		description: "Hiệu ứng distortion",
		category: "effect",
	},
	bitcrusher: {
		name: "bitcrusher",
		ffmpegFilter: "acrusher=bits=8:mode=log:aa=1",
		description: "Giảm bit depth",
		category: "effect",
	},
	robot: {
		name: "robot",
		ffmpegFilter: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
		description: "Giọng robot",
		category: "vocal",
	},
	slow: {
		name: "slow",
		ffmpegFilter: "atempo=0.5",
		description: "Phát chậm",
		category: "speed",
	},
	fast: {
		name: "fast",
		ffmpegFilter: "atempo=2.0",
		description: "Phát nhanh",
		category: "speed",
	},
	smooth: {
		name: "smooth",
		ffmpegFilter: "smooth=f=11:o=1",
		description: "Làm mượt âm thanh",
		category: "effect",
	},
	mono: {
		name: "mono",
		ffmpegFilter: "pan=mono|c0=0.5*c0+0.5*c1",
		description: "Chuyển sang mono",
		category: "channel",
	},
	stereo: {
		name: "stereo",
		ffmpegFilter: "stereotools=mlev=0.1",
		description: "Tăng cường stereo",
		category: "channel",
	},
};

/**
 * Context for the extension
 *
 * @example
 * const context: ExtensionContext = {
 *   player: player,
 *   manager: manager
 * };
 */
export interface ExtensionContext {
	player: Player;
	manager: PlayerManager;
}

/**
 * Request for the extension to play a track
 *
 * @example
 * const request: ExtensionPlayRequest = {
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionPlayRequest {
	query: string | Track;
	requestedBy?: string;
}

/**
 * Response for the extension to play a track
 *
 * @example
 * const response: ExtensionPlayResponse = {
 *   handled: true,
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionPlayResponse {
	handled?: boolean;
	query?: string | Track;
	requestedBy?: string;
	tracks?: Track[];
	isPlaylist?: boolean;
	success?: boolean;
	error?: Error;
}

/**
 * Payload for the extension to play a track
 *
 * @example
 * const payload: ExtensionAfterPlayPayload = {
 *   success: true,
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionAfterPlayPayload {
	success: boolean;
	query: string | Track;
	requestedBy?: string;
	tracks?: Track[];
	isPlaylist?: boolean;
	error?: Error;
}

/**
 * Request for the extension to stream a track
 *
 * @example
 * const request: ExtensionStreamRequest = {
 *   track: track
 * };
 */
export interface ExtensionStreamRequest {
	track: Track;
}

/**
 * Request for the extension to search for a track
 *
 * @example
 * const request: ExtensionSearchRequest = {
 *   query: "Song Name",
 *   requestedBy: "user123"
 * };
 */
export interface ExtensionSearchRequest {
	query: string;
	requestedBy: string;
}

/**
 * Event types emitted by Player instances.
 *
 * @example
 *
 * manager.on("willPlay", (player, track) => {
 *   console.log(`Up next: ${track.title}`);
 * });
 *
 * manager.on("trackEnd", (player, track) => {
 *   console.log(`Now playing: ${track.title}`);
 * });
 *
 * manager.on("queueAdd", (player, track) => {
 *   console.log(`Queue added: ${track.title}`);
 * });
 *
 * manager.on("queueAddList", (player, tracks) => {
 *   console.log(`Queue added: ${tracks.length} tracks`);
 * });
 *
 * manager.on("queueRemove", (player, track, index) => {
 *   console.log(`Queue removed: ${track.title} at index ${index}`);
 * });
 *
 * manager.on("playerPause", (player, track) => {
 *   console.log(`Player paused: ${track.title}`);
 * });
 *
 * manager.on("playerResume", (player, track) => {
 *   console.log(`Player resumed: ${track.title}`);
 * });
 *
 * manager.on("playerStop", (player) => {
 *   console.log("Player stopped");
 * });
 *
 * manager.on("playerDestroy", (player) => {
 *   console.log("Player destroyed");
 * });
 *
 * manager.on("ttsStart", (player, payload) => {
 *   console.log(`TTS started: ${payload.text}`);
 * });
 *
 * manager.on("ttsEnd", (player) => {
 *   console.log("TTS ended");
 * });
 *
 * manager.on("playerError", (player, error, track) => {
 *   console.log(`Player error: ${error.message}`);
 * });
 *
 * manager.on("connectionError", (player, error) => {
 *   console.log(`Connection error: ${error.message}`);
 * });
 * manager.on("trackStart", (player, track) => {
 *   console.log(`Track started: ${track.title}`);
 * });
 *
 * manager.on("volumeChange", (player, oldVolume, newVolume) => {
 *   console.log(`Volume changed: ${oldVolume} -> ${newVolume}`);
 * });
 *
 * manager.on("queueEnd", (player) => {
 *   console.log("Queue finished");
 * });
 *
 */
export interface ManagerEvents {
	debug: [message: string, ...args: any[]];
	willPlay: [player: Player, track: Track, upcomingTracks: Track[]];
	trackStart: [player: Player, track: Track];
	trackEnd: [player: Player, track: Track];
	queueEnd: [player: Player];
	playerError: [player: Player, error: Error, track?: Track];
	connectionError: [player: Player, error: Error];
	volumeChange: [player: Player, oldVolume: number, newVolume: number];
	queueAdd: [player: Player, track: Track];
	queueAddList: [player: Player, tracks: Track[]];
	queueRemove: [player: Player, track: Track, index: number];
	playerPause: [player: Player, track: Track];
	playerResume: [player: Player, track: Track];
	playerStop: [player: Player];
	playerDestroy: [player: Player];
	ttsStart: [player: Player, payload: { text?: string; track?: Track }];
	ttsEnd: [player: Player];
	/** Emitted when audio filter is applied */
	filterApplied: [player: Player, filter: AudioFilter];
	/** Emitted when audio filter is removed */
	filterRemoved: [player: Player, filter: AudioFilter];
	/** Emitted when all filters are cleared */
	filtersCleared: [player: Player];
	//extension events
	lyricsCreate: [player: Player, track: Track, lyrics: any];
	lyricsChange: [player: Player, track: Track, lyrics: any];
	voiceCreate: [player: Player, evt: any];
}
export interface PlayerEvents {
	debug: [message: string, ...args: any[]];
	willPlay: [track: Track, upcomingTracks: Track[]];
	trackStart: [track: Track];
	trackEnd: [track: Track];
	queueEnd: [];
	playerError: [error: Error, track?: Track];
	connectionError: [error: Error];
	volumeChange: [oldVolume: number, newVolume: number];
	queueAdd: [track: Track];
	queueAddList: [tracks: Track[]];
	queueRemove: [track: Track, index: number];
	playerPause: [track: Track];
	playerResume: [track: Track];
	playerStop: [];
	playerDestroy: [];
	/** Emitted when seeking to a position in current track */
	seek: [payload: { track: Track; position: number }];
	/** Emitted when TTS starts playing (interruption mode) */
	ttsStart: [payload: { text?: string; track?: Track }];
	/** Emitted when TTS finished (interruption mode) */
	ttsEnd: [];
	/** Emitted when audio filter is applied */
	filterApplied: [filter: AudioFilter];
	/** Emitted when audio filter is removed */
	filterRemoved: [filter: AudioFilter];
	/** Emitted when all filters are cleared */
	filtersCleared: [];
}
/**
 * Plugin interface
 *
 * @example
 * const plugin: SourcePlugin = {
 *   name: "YouTube",
 *   version: "1.0.0"
 * };
 */
export interface SourcePlugin {
	name: string;
	version: string;
	canHandle(query: string): boolean;
	search(query: string, requestedBy: string): Promise<SearchResult>;
	getStream(track: Track): Promise<StreamInfo>;
	getRelatedTracks?(track: string | number, opts?: { limit?: number; offset?: number }): Promise<Track[]>;
	validate?(url: string): boolean;
	extractPlaylist?(url: string, requestedBy: string): Promise<Track[]>;
}

/**
 * Extension interface
 *
 * @example
 * const extension: SourceExtension = {
 *   name: "YouTube",
 *   version: "1.0.0"
 * };
 */
export interface SourceExtension {
	name: string;
	version: string;
	connection?: VoiceConnection;
	player: Player | null;
	active(alas: any): boolean | Promise<boolean>;
	onRegister?(context: ExtensionContext): void | Promise<void>;
	onDestroy?(context: ExtensionContext): void | Promise<void>;
	beforePlay?(
		context: ExtensionContext,
		payload: ExtensionPlayRequest,
	): Promise<ExtensionPlayResponse | void> | ExtensionPlayResponse | void;
	afterPlay?(context: ExtensionContext, payload: ExtensionAfterPlayPayload): Promise<void> | void;
	provideSearch?(
		context: ExtensionContext,
		payload: ExtensionSearchRequest,
	): Promise<SearchResult | null | undefined> | SearchResult | null | undefined;
	provideStream?(
		context: ExtensionContext,
		payload: ExtensionStreamRequest,
	): Promise<StreamInfo | null | undefined> | StreamInfo | null | undefined;
}
