"use strict";

// Authenticates publisher/listener sockets and relays PCM to browser clients.
// For production, use HTTPS/WSS and short-lived per-session tokens.
const { createServer } = require("node:http");
const { timingSafeEqual } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const PROTOCOL_VERSION = 1;
const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 2;
const SAMPLE_BYTES = 2;
const FRAME_HEADER_BYTES = 16;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_LISTENER_BUFFER_BYTES = 256 * 1024;
const MAX_QUERY_LENGTH = 500;
const WS_OPEN = 1;
const STATIC_FILES = new Map([
	["/", ["client/index.html", "text/html; charset=utf-8"]],
	["/client.js", ["client/client.js", "text/javascript; charset=utf-8"]],
	["/web-audio-client.js", ["../../client/browser/index.js", "text/javascript; charset=utf-8"]],
]);

function equalSecret(actual, expected) {
	if (typeof actual !== "string" || !actual || !expected) return false;
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendHttpError(socket, status, message) {
	socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

function readRequest(request) {
	const url = new URL(request.url ?? "/", "http://localhost");
	const role =
		url.pathname === "/publish" ? "publisher"
		: url.pathname === "/listen-next" ? "next-listener"
		: url.pathname === "/listen" ? "listener"
		: null;
	const sessionId = url.searchParams.get("sessionId");
	if (!role || (role !== "next-listener" && (!sessionId || sessionId.length > 128))) return null;

	const token =
		request.headers.authorization?.startsWith("Bearer ") ?
			request.headers.authorization.slice("Bearer ".length)
		:	url.searchParams.get("token");

	return { role, sessionId, token };
}

function isAudioConfig(message, sessionId) {
	return (
		message.v === PROTOCOL_VERSION &&
		message.type === "audio:config" &&
		message.sessionId === sessionId &&
		message.protocolVersion === PROTOCOL_VERSION &&
		message.sampleRateHz === SAMPLE_RATE_HZ &&
		message.channels === CHANNELS &&
		message.sampleFormat === "s16" &&
		message.endianness === "little" &&
		message.channelLayout === "interleaved"
	);
}

function isAudioFrame(data) {
	if (data.length < FRAME_HEADER_BYTES || data.length > MAX_MESSAGE_BYTES + FRAME_HEADER_BYTES) return false;
	const samplesPerChannel = data.length - FRAME_HEADER_BYTES;
	const bytesPerSampleFrame = CHANNELS * SAMPLE_BYTES;
	if (samplesPerChannel === 0 || samplesPerChannel % bytesPerSampleFrame !== 0) return false;

	return data.readUInt16LE(8) === SAMPLE_RATE_HZ && data.readUInt16LE(10) === CHANNELS && data.readUInt16LE(12) === SAMPLE_BYTES;
}

function relayToListeners(session, data, isBinary) {
	const byteLength = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
	for (const listener of session.listeners) {
		if (listener.readyState !== WS_OPEN) continue;
		if (listener.bufferedAmount + byteLength > MAX_LISTENER_BUFFER_BYTES) {
			listener.close(1013, "Listener is too slow");
			continue;
		}
		listener.send(data, { binary: isBinary }, (error) => {
			if (error) {
				console.error(`Failed to send audio to listener for ${session.sessionId}:`, error);
				listener.close(1011, "Audio forwarding failed");
			}
		});
	}
}

function removeSessionIfUnused(session, sessions) {
	if (!session.publisher && session.listeners.size === 0 && sessions.get(session.sessionId) === session) {
		sessions.delete(session.sessionId);
	}
}

function sendJson(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

async function waitForPublisherSession(sessions, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const session of sessions.values()) {
			if (session.publisher?.readyState === WS_OPEN) return session.sessionId;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}

async function readJsonBody(request, maxBytes) {
	const chunks = [];
	let bytesRead = 0;
	let oversized = false;
	for await (const chunk of request) {
		bytesRead += chunk.length;
		if (bytesRead > maxBytes) {
			oversized = true;
			chunks.length = 0;
		} else if (!oversized) {
			chunks.push(chunk);
		}
	}
	if (oversized) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 });
	}
}

function attachPublisher(session, socket, sessions) {
	let configured = false;
	let frameCount = 0;
	let frameBytes = 0;
	let lastStatsAt = Date.now();
	let statsTimer;
	session.publisher = socket;
	session.config = null;
	for (const listener of session.nextListeners) {
		session.listeners.add(listener);
		listener.once("close", () => {
			session.listeners.delete(listener);
			removeSessionIfUnused(session, sessions);
		});
	}
	session.nextListeners.clear();

	socket.on("message", (data, isBinary) => {
		if (isBinary) {
			if (!configured || !isAudioFrame(data)) {
				socket.close(1003, "Invalid or unexpected PCM audio frame");
				return;
			}
			frameCount++;
			frameBytes += data.length - FRAME_HEADER_BYTES;
			if (frameCount === 1) {
				console.info(`First PCM frame from ${session.sessionId}: ${data.length - FRAME_HEADER_BYTES} bytes`);
			}
			if (Date.now() - lastStatsAt >= 5000) {
				console.info(
					`PCM stream ${session.sessionId}: ${frameCount} frames, ${frameBytes} audio bytes, ${session.listeners.size} listener(s)`,
				);
				lastStatsAt = Date.now();
			}
			relayToListeners(session, data, true);
			return;
		}

		let message;
		try {
			message = JSON.parse(data.toString());
		} catch {
			socket.close(1003, "Invalid JSON control message");
			return;
		}
		if (!message || typeof message !== "object" || message.sessionId !== session.sessionId) {
			socket.close(1008, "Control message session mismatch");
			return;
		}
		if (message.type === "audio:config") {
			if (!isAudioConfig(message, session.sessionId)) {
				socket.close(1008, "Unsupported audio configuration");
				return;
			}
			configured = true;
			session.config = message;
			statsTimer ??= setInterval(() => {
				if (session.publisher !== socket) return;
				if (frameCount === 0) {
					console.warn(
						`No PCM frames received for ${session.sessionId} after audio:config; check the ZiPlayer stream/decode errors`,
					);
				} else {
					console.info(
						`PCM stream ${session.sessionId}: ${frameCount} frames, ${frameBytes} audio bytes, ${session.listeners.size} listener(s)`,
					);
				}
			}, 5000);
			statsTimer.unref?.();
		} else if (!configured) {
			socket.close(1008, "Audio configuration is required first");
			return;
		} else if (message.v !== PROTOCOL_VERSION) {
			socket.close(1008, "Unsupported protocol version");
			return;
		}
		relayToListeners(session, data.toString(), false);
	});

	socket.on("close", () => {
		clearInterval(statsTimer);
		if (session.publisher !== socket) return;
		session.publisher = null;
		session.config = null;
		removeSessionIfUnused(session, sessions);
	});

	socket.on("error", (error) => {
		console.error(`Publisher socket error for ${session.sessionId}:`, error);
	});
}

function createWebAudioGateway({ host = "127.0.0.1", port = 8080, token = process.env.WEB_AUDIO_TOKEN, onPlayQuery } = {}) {
	if (!token) throw new Error("Set WEB_AUDIO_TOKEN to a non-empty secret before starting the gateway");
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be an integer from 0 to 65535");

	const sessions = new Map();
	const pendingListeners = new Set();
	const httpServer = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (request.method === "GET" && pathname === "/health") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ status: "ok", activeSessions: sessions.size }));
			return;
		}
		if (request.method === "POST" && pathname === "/play") {
			void (async () => {
				const authorization = request.headers.authorization ?? "";
				if (!authorization.startsWith("Bearer ") || !equalSecret(authorization.slice("Bearer ".length), token)) {
					sendJson(response, 401, { error: "Unauthorized" });
					request.resume();
					return;
				}
				if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
					sendJson(response, 415, { error: "Content-Type must be application/json" });
					request.resume();
					return;
				}
				if (typeof onPlayQuery !== "function") {
					sendJson(response, 503, { error: "Playback is not available" });
					request.resume();
					return;
				}

				try {
					const body = await readJsonBody(request, 4096);
					if (!body || typeof body.query !== "string" || !body.query.trim() || body.query.length > MAX_QUERY_LENGTH) {
						sendJson(response, 400, { error: "query must be a non-empty string of at most 500 characters" });
						return;
					}
					const result = await onPlayQuery(body.query.trim());
					if (result === null) {
						sendJson(response, 503, { error: "Player is not ready" });
						return;
					}
					if (!result) {
						sendJson(response, 422, { error: "No playable track found for this query" });
						return;
					}
					const sessionId = await waitForPublisherSession(sessions);
					sendJson(response, 200, {
						sessionId,
						track: {
							title: result.track?.title ?? body.query.trim(),
							url: result.track?.url ?? null,
						},
					});
				} catch (error) {
					const statusCode = error && typeof error === "object" ? error.statusCode : undefined;
					if (statusCode) {
						if (!response.destroyed) sendJson(response, statusCode, { error: error.message });
						return;
					}
					console.error("Web playback search failed:", error);
					if (!response.destroyed) sendJson(response, 500, { error: "Playback search failed" });
				}
			})();
			return;
		}
		const file = request.method === "GET" ? STATIC_FILES.get(pathname) : undefined;
		if (!file) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Not found");
			return;
		}
		void readFile(path.join(__dirname, file[0]))
			.then((content) => {
				response.writeHead(200, {
					"content-type": file[1],
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				});
				response.end(content);
			})
			.catch((error) => {
				console.error(`Failed to serve ${pathname}:`, error);
				if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				response.end("Failed to load Web audio client");
			});
	});
	const webSocketServer = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_MESSAGE_BYTES + FRAME_HEADER_BYTES,
	});

	httpServer.on("upgrade", (request, socket, head) => {
		const parsed = readRequest(request);
		if (!parsed) {
			sendHttpError(socket, 404, "Not Found");
			return;
		}
		if (!equalSecret(parsed.token, token)) {
			sendHttpError(socket, 401, "Unauthorized");
			return;
		}

		const existing = sessions.get(parsed.sessionId);
		if (parsed.role === "publisher" && existing?.publisher?.readyState === WS_OPEN) {
			sendHttpError(socket, 409, "Session Already Published");
			return;
		}
		if (parsed.role === "listener" && (!existing || existing.publisher?.readyState !== WS_OPEN)) {
			sendHttpError(socket, 404, "Audio Session Not Found");
			return;
		}

		webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
			if (parsed.role === "publisher") {
				const session = existing ?? {
					sessionId: parsed.sessionId,
					publisher: null,
					listeners: new Set(),
					nextListeners: new Set(),
					config: null,
				};
				for (const listener of pendingListeners) session.nextListeners.add(listener);
				pendingListeners.clear();
				sessions.set(parsed.sessionId, session);
				attachPublisher(session, webSocket, sessions);
				console.info(`Audio publisher connected: ${parsed.sessionId}`);
			} else if (parsed.role === "next-listener") {
				pendingListeners.add(webSocket);
				webSocket.once("close", () => pendingListeners.delete(webSocket));
				webSocket.on("error", (error) => {
					console.error("Waiting audio listener socket error:", error);
				});
				console.info("Audio listener waiting for next publisher");
			} else {
				const session = sessions.get(parsed.sessionId);
				if (!session || session.publisher?.readyState !== WS_OPEN) {
					webSocket.close(1012, "Publisher disconnected");
					return;
				}
				session.listeners.add(webSocket);
				if (session.config) webSocket.send(JSON.stringify(session.config));
				webSocket.once("close", () => {
					session.listeners.delete(webSocket);
					removeSessionIfUnused(session, sessions);
				});
				webSocket.on("error", (error) => {
					console.error(`Listener socket error for ${parsed.sessionId}:`, error);
				});
				console.info(`Audio listener connected: ${parsed.sessionId}`);
			}
		});
	});

	return {
		httpServer,
		listen() {
			return new Promise((resolve, reject) => {
				const onError = (error) => {
					httpServer.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					httpServer.off("error", onError);
					resolve(httpServer.address());
				};
				httpServer.once("error", onError);
				httpServer.once("listening", onListening);
				httpServer.listen(port, host);
			});
		},
		async close() {
			for (const listener of pendingListeners) listener.close(1001, "Gateway shutting down");
			pendingListeners.clear();
			for (const session of sessions.values()) {
				session.publisher?.close(1001, "Gateway shutting down");
				for (const listener of session.listeners) listener.close(1001, "Gateway shutting down");
			}
			sessions.clear();
			webSocketServer.close();
			if (httpServer.listening) {
				await new Promise((resolve, reject) => {
					httpServer.close((error) => (error ? reject(error) : resolve()));
				});
			}
		},
	};
}

module.exports = { createWebAudioGateway };
