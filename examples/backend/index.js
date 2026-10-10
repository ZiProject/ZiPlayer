"use strict";

// Run `npm run build:core` and set WEB_AUDIO_TOKEN before starting the example.
require("dotenv").config();
const { WebSocket } = require("ws");
const { PlayerManager, WebSocketAudioOutputBackend } = require("ziplayer");
const { createWebAudioGateway } = require("./gateway");

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 2;
function createPublisherSocketFactory({ gatewayUrl, token }) {
	if (!gatewayUrl) throw new TypeError("gatewayUrl is required");
	if (!token) throw new TypeError("token is required");

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
			const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
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
			authorize: ({ sessionId }) => Boolean(sessionId),
			sessionId: playerId,
		});
}

async function main() {
	const host = process.env.HOST ?? "127.0.0.1";
	const port = Number(process.env.PORT ?? 8080);
	const token = process.env.WEB_AUDIO_TOKEN;
	const trackQuery = process.env.TRACK_QUERY ?? process.argv.slice(2).join(" ").trim();
	let player;
	const gateway = createWebAudioGateway({
		host,
		port,
		token,
		onPlayQuery: (query) => (player ? player.play(query, { requestedBy: "client" }) : null),
	});
	let manager;
	let shuttingDown = false;
	try {
		const address = await gateway.listen();
		const gatewayUrl =
			process.env.GATEWAY_URL ?? `ws://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${address.port}`;
		const pluginPackage = await import("@ziplayer/plugin");
		const plugins = [
			new pluginPackage.YouTubePlugin(),
			new pluginPackage.SoundCloudPlugin(),
			new pluginPackage.SpotifyPlugin(),
			new pluginPackage.AttachmentsPlugin(),
			new pluginPackage.TTSPlugin({ defaultLang: process.env.TTS_LANGUAGE ?? "vi" }),
		];

		manager = new PlayerManager({
			plugins,
			autoCleanup: false,
			extractorTimeout: Number(process.env.EXTRACTOR_TIMEOUT_MS ?? 30_000),
		});
		manager.on("trackStart", (_player, track) => {
			console.info(`Now playing: ${track.title} (${track.url})`);
		});
		manager.on("trackAdd", (_player, track) => {
			console.info(`Queued: ${track.title}`);
		});
		manager.on("error", (_queue, error) => {
			console.error("ZiPlayer playback error:", error);
		});

		const playerId = process.env.PLAYER_ID ?? "web-audio-demo";
		player = await manager.create(playerId, {
			audioOutputBackendFactory: createAudioOutputBackendFactory({ gatewayUrl, token }),
			audioProcessing: {
				enabled: true,
				inputFormat: "encoded",
				outputFormat: "pcm16le",
				sampleRate: SAMPLE_RATE_HZ,
				channels: CHANNELS,
			},
			preload: { enabled: false },
			crossfade: { enabled: false },
		});
		player.on("streamError", (error, track) => {
			console.error(`ZiPlayer stream/output error${track?.title ? ` for "${track.title}"` : ""}:`, error);
		});
		player.on("playerError", (error, track) => {
			console.error(`ZiPlayer track error${track?.title ? ` for "${track.title}"` : ""}:`, error);
		});

		const requestedBy = process.env.REQUESTED_BY ?? "client";
		console.info(`Web audio gateway and client listening on http://${address.address}:${address.port}`);
		console.info(`Starting ZiPlayer session "${playerId}" with ${plugins.length} plugins`);
		const shutdown = async (signal) => {
			if (shuttingDown) return;
			shuttingDown = true;
			console.info(`Received ${signal}; stopping ZiPlayer and Web audio gateway`);
			try {
				await manager?.dispose();
			} finally {
				await gateway.close();
			}
		};
		process.once("SIGINT", () => void shutdown("SIGINT").catch((error) => console.error("Shutdown failed:", error)));
		process.once("SIGTERM", () => void shutdown("SIGTERM").catch((error) => console.error("Shutdown failed:", error)));
		console.info("Open the gateway URL in a browser to search and listen.");
		if (trackQuery) {
			const result = await player.play(trackQuery, { requestedBy });
			if (!result) throw new Error(`ZiPlayer could not start playback for query: ${trackQuery}`);
		}
	} catch (error) {
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
};
