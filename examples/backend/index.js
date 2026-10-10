"use strict";

// Run `npm run build:core` before starting the loopback-only example.
require("dotenv").config();
const { WebSocket } = require("ws");
const { PlayerManager, WebSocketAudioOutputBackend } = require("ziplayer");
const { createWebAudioGateway } = require("./gateway");
const pluginPackage = require("@ziplayer/plugin");

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 2;
function createPublisherSocketFactory({ gatewayUrl }) {
	if (!gatewayUrl) throw new TypeError("gatewayUrl is required");

	return ({ sessionId, signal }) =>
		new Promise((resolve, reject) => {
			if (!sessionId) {
				reject(new TypeError("WebSocket audio backend did not provide a sessionId"));
				return;
			}
			if (signal?.aborted) {
				const error = new Error("WebSocket connection was aborted");
				error.name = "AbortError";
				reject(error);
				return;
			}

			const url = new URL("/publish", gatewayUrl);
			url.searchParams.set("sessionId", sessionId);
			const socket = new WebSocket(url);
			const cleanup = () => {
				socket.off("open", onOpen);
				socket.off("error", onError);
				signal?.removeEventListener("abort", onAbort);
			};
			const onOpen = () => {
				cleanup();
				socket.on("error", (error) => {
					console.error(`WebSocket publisher error for ${sessionId}:`, error);
					socket.close(1011, "Publisher transport error");
				});
				resolve(socket);
			};
			const onError = (error) => {
				cleanup();
				socket.terminate();
				reject(error);
			};
			const onAbort = () => {
				cleanup();
				socket.terminate();
				const error = new Error("WebSocket connection was aborted");
				error.name = "AbortError";
				reject(error);
			};

			socket.once("open", onOpen);
			socket.once("error", onError);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
}

function createAudioOutputBackendFactory(options) {
	const socketFactory = createPublisherSocketFactory(options);
	return ({ playerId }) =>
		new WebSocketAudioOutputBackend({
			socketFactory,
			sessionId: playerId,
		});
}

function serializeTrack(track) {
	if (!track) return null;
	return {
		title: track.title ?? "Untitled",
		url: track.url ?? null,
		duration: track.duration ?? 0,
		thumbnail: track.thumbnail ?? null,
		author: track.author ?? null,
		source: track.source ?? null,
		isLive: Boolean(track.isLive),
	};
}

function createPlayerIdleCleanup(manager, timeoutMs = 100_000) {
	const idlePlayers = new Map();
	let disposed = false;

	return {
		onListenerCount(sessionId, listenerCount) {
			const current = idlePlayers.get(sessionId);
			if (current) {
				clearTimeout(current.timer);
				idlePlayers.delete(sessionId);
			}
			if (disposed || listenerCount > 0) return;
			const player = manager.getPlayer(sessionId);
			if (!player) return;

			const state = { player, listenerCount, timer: null };
			state.timer = setTimeout(() => {
				if (idlePlayers.get(sessionId) !== state || state.listenerCount !== 0) return;
				idlePlayers.delete(sessionId);
				if (manager.getPlayer(sessionId) !== player) return;
				void manager.destroy(sessionId).catch((error) => {
					console.error(`Failed to remove listener-idle player ${sessionId}:`, error);
				});
			}, timeoutMs);
			state.timer.unref?.();
			idlePlayers.set(sessionId, state);
		},
		dispose() {
			disposed = true;
			for (const state of idlePlayers.values()) clearTimeout(state.timer);
			idlePlayers.clear();
		},
	};
}

async function main() {
	const host = process.env.HOST ?? "127.0.0.1";
	const port = Number(process.env.PORT ?? 8080);
	const trackQuery = process.env.TRACK_QUERY ?? process.argv.slice(2).join(" ").trim();
	const playerId = process.env.PLAYER_ID ?? "web-audio-demo";
	const plugins = [
		new pluginPackage.YouTubePlugin({ preferYoutubei: true }),
		new pluginPackage.SoundCloudPlugin(),
		new pluginPackage.SpotifyPlugin(),
		new pluginPackage.AttachmentsPlugin(),
		new pluginPackage.TTSPlugin({ defaultLang: process.env.TTS_LANGUAGE ?? "vi" }),
	];

	let manager = new PlayerManager({
		plugins,
		autoCleanup: false,
		extractorTimeout: Number(process.env.EXTRACTOR_TIMEOUT_MS ?? 30_000),
		debugLevel: "verbose",
	});
	let playerIdleCleanup = createPlayerIdleCleanup(manager);
	manager.on("trackStart", (_player, track) => {
		console.info(`Now playing: ${track.title} (${track.url})`);
	});
	manager.on("trackAdd", (_player, track) => {
		console.info(`Queued: ${track.title}`);
	});

	manager.on("error", (_queue, error) => {
		console.error("ZiPlayer playback error:", error);
	});
	manager.on("debug", console.debug);
	let gatewayUrl;
	const gateway = createWebAudioGateway({
		host,
		port,
		defaultSessionId: playerId,
		onPlayQuery: async (query, sessionId) => {
			if (!manager) return null;
			const player = await getOrCreatePlayer(sessionId);
			return player.play(query, { requestedBy: process.env.REQUESTED_BY ?? "client" });
		},
		onControl: (action, body, sessionId) => {
			const player = manager?.getPlayer(sessionId);
			if (!player) throw Object.assign(new Error(`No player exists for session ${sessionId}`), { statusCode: 404 });
			switch (action) {
				case "pause":
					return player.pause();
				case "resume":
					return player.resume();
				case "stop":
					return player.stop();
				case "skip":
					return player.skip();
				case "seek":
					return player.seek(body.positionMs);
				case "volume":
					return player.setVolume(body.volume);
				case "loop":
					return player.loop(body.mode);
				case "autoplay":
					return player.autoPlay(body.enabled);
				case "filter": {
					const available = player.filter.getAvailableFilters().some((filter) => filter.name === body.filterName);
					if (!available) {
						throw Object.assign(new Error(`Unknown filter: ${body.filterName}`), { statusCode: 400 });
					}
					return body.enabled ? player.filter.applyFilter(body.filterName) : player.filter.removeFilter(body.filterName);
				}
				case "filter-clear":
					return player.filter.clearFilters();
			}
		},
		onGetPlayerState: (sessionId) => {
			const player = manager?.getPlayer(sessionId);
			if (!player) return null;
			const toFilterSummary = (filter) => ({
				name: filter.name,
				description: filter.description,
			});
			return {
				currentTrack: serializeTrack(player.currentTrack),
				tracks: player.upcomingTracks.map(serializeTrack),
				related: player.relatedTracks.map(serializeTrack),
				loopMode: player.loop(),
				autoPlay: player.autoPlay(),
				volume: player.volume,
				filters: player.filter.getAvailableFilters().map(toFilterSummary),
				activeFilters: player.filter.getActiveFilters().map(toFilterSummary),
			};
		},
		onListenerCount: (sessionId, listenerCount) => playerIdleCleanup?.onListenerCount(sessionId, listenerCount),
	});

	for (const event of [
		"willPlay",
		"trackStart",
		"trackEnd",
		"queueEnd",
		"trackAdd",
		"queueAdd",
		"queueAddList",
		"queueRemove",
		"volumeChange",
		"playerPause",
		"playerResume",
		"playerStop",
		"filterApplied",
		"filterRemoved",
		"filtersCleared",
		"seek",
		"playerDestroy",
	]) {
		manager.on(event, (player) => void gateway.publishPlayerState(player.playerId));
	}
	let shuttingDown = false;
	async function getOrCreatePlayer(sessionId) {
		let player = manager.getPlayer(sessionId);
		if (!player) {
			player = await manager.create(sessionId, {
				audioOutputBackendFactory: createAudioOutputBackendFactory({ gatewayUrl }),
				audioProcessing: {
					enabled: true,
					inputFormat: "encoded",
					outputFormat: "pcm16le",
					sampleRate: SAMPLE_RATE_HZ,
					channels: CHANNELS,
				},
				preload: { enabled: false },
				crossfade: { enabled: false },
				userdata: { webAudioGateway: { sessionId } },
			});
		}
		player.userdata ??= {};
		const webAudioMetadata = player.userdata.webAudioGateway ?? {};
		if (webAudioMetadata.listenersAttached) return player;
		player.userdata.webAudioGateway = { ...webAudioMetadata, sessionId, listenersAttached: true };
		player.on("streamError", (error, track) => {
			console.error(`ZiPlayer stream/output error for session ${sessionId}${track?.title ? ` (${track.title})` : ""}:`, error);
		});
		player.on("playerError", (error, track) => {
			console.error(`ZiPlayer track error for session ${sessionId}${track?.title ? ` (${track.title})` : ""}:`, error);
		});
		console.info(`Web Audio configured for session "${sessionId}"`);
		return player;
	}
	try {
		const address = await gateway.listen();
		gatewayUrl = process.env.GATEWAY_URL ?? `ws://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${address.port}`;
		const defaultPlayer = await getOrCreatePlayer(playerId);
		const requestedBy = process.env.REQUESTED_BY ?? "client";
		console.info(`Web audio gateway and client listening on http://${address.address}:${address.port}`);
		console.info(`Starting default ZiPlayer session "${playerId}" with ${plugins.length} plugins`);
		const shutdown = async (signal) => {
			if (shuttingDown) return;
			shuttingDown = true;
			console.info(`Received ${signal}; stopping ZiPlayer and Web audio gateway`);
			playerIdleCleanup?.dispose();
			try {
				await manager?.dispose();
			} finally {
				await gateway.close();
			}
		};
		process.once("SIGINT", () => void shutdown("SIGINT").catch((error) => console.error("Shutdown failed:", error)));
		process.once("SIGTERM", () => void shutdown("SIGTERM").catch((error) => console.error("Shutdown failed:", error)));
		console.info("Enter any valid player ID in the browser to create or select its independent playback session.");
		if (trackQuery) {
			const result = await defaultPlayer.play(trackQuery, { requestedBy });
			if (!result) throw new Error(`ZiPlayer could not start playback for query: ${trackQuery}`);
		}
	} catch (error) {
		playerIdleCleanup?.dispose();
		await manager?.dispose();
		await gateway.close();
		throw error;
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error("Failed to start Web audio gateway:", error);
		process.exitCode = 1;
	});
}

module.exports = {
	createAudioOutputBackendFactory,
	createPublisherSocketFactory,
	createWebAudioGateway,
	createPlayerIdleCleanup,
};
