import type { SerializedPlayer, SerializedTrack } from "../../../core/src/types";

export const sampleTrack: SerializedTrack = {
	id: "track_001",
	title: "Never Gonna Give You Up",
	url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
	source: "youtube",
	duration: 212000,
	thumbnail: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
	requestedBy: "user123",
	isLive: false,
	author: "Rick Astley",
	artwork: "https://i.scdn.co/image/ab67616d0000b273",
};

export const sampleQueue = {
	tracks: [sampleTrack],
	current: sampleTrack,
	history: [],
	loopMode: "off" as const,
	autoPlay: false,
	position: 0,
};

export const sampleSerializedPlayer: SerializedPlayer = {
	guildId: "guild_001",
	queue: sampleQueue,
	volume: 100,
	isPlaying: false,
	isPaused: false,
	options: {
		leaveOnEnd: true,
		leaveTimeout: 60000,
	},
	filters: ["bassboost"],
	lastUpdate: Date.now(),
	version: "1.0.0",
};

export const multipleTracks: SerializedTrack[] = [
	{ ...sampleTrack, id: "track_001", title: "Song 1" },
	{ ...sampleTrack, id: "track_002", title: "Song 2", url: "https://youtube.com/watch?v=abc123" },
	{ ...sampleTrack, id: "track_003", title: "Song 3", source: "soundcloud" },
];
