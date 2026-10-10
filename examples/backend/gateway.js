"use strict";

// Relays PCM to browser clients; the example intentionally binds to loopback only.
const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const { isIP } = require("node:net");
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
const RESERVED_SESSION_ID = "__ziplayer_search__";
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATIC_FILES = new Map([
	["/", ["client/index.html", "text/html; charset=utf-8"]],
	["/client.js", ["client/client.js", "text/javascript; charset=utf-8"]],
	["/web-audio-client.js", ["../../client/browser/index.js", "text/javascript; charset=utf-8"]],
]);

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
	if (!role || (sessionId !== null && (!sessionId.trim() || sessionId.length > 128))) return null;
	if ((role === "publisher" || role === "listener") && (!sessionId || !sessionId.trim())) return null;

	return { role, sessionId: sessionId ?? null };
}

function isValidSessionId(sessionId) {
	return typeof sessionId === "string" && sessionId !== RESERVED_SESSION_ID && SESSION_ID_PATTERN.test(sessionId);
}

function invalidSessionIdMessage() {
	return "sessionId must contain 1-128 letters, numbers, underscores, or hyphens and cannot use ZiPlayer's reserved ID";
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
		session.nextListeners.clear();
		sessions.delete(session.sessionId);
	}
}

function getPendingListenerSet(pendingListeners, sessionId) {
	const key = sessionId;
	let listeners = pendingListeners.get(key);
	if (!listeners) {
		listeners = new Set();
		pendingListeners.set(key, listeners);
	}
	return listeners;
}

function queuePendingListener(pendingListeners, webSocket, sessionId) {
	const listeners = getPendingListenerSet(pendingListeners, sessionId);
	listeners.add(webSocket);
	webSocket.once("close", () => {
		listeners.delete(webSocket);
		if (listeners.size === 0) pendingListeners.delete(sessionId);
	});
	return listeners;
}

function attachPendingListeners(session, pendingListeners) {
	const sessionKey = session.sessionId;
	const globalKey = null;
	const queued = new Set([
		...(pendingListeners.get(sessionKey) ?? []),
		...(pendingListeners.get(globalKey) ?? []),
	]);
	for (const listener of queued) {
		session.nextListeners.add(listener);
		listener.once("close", () => {
			session.nextListeners.delete(listener);
		});
	}
	for (const key of [sessionKey, globalKey]) {
		const listeners = pendingListeners.get(key);
		if (!listeners) continue;
		listeners.clear();
		pendingListeners.delete(key);
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

async function waitForPublisher(sessions, sessionId, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const session = sessions.get(sessionId);
		if (session?.publisher?.readyState === WS_OPEN) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

function isLoopbackHost(host) {
	const normalizedHost = String(host).toLowerCase().replace(/^\[|\]$/g, "");
	if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost") || normalizedHost === "::1") return true;
	if (isIP(normalizedHost) === 4) return normalizedHost.startsWith("127.");
	return false;
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

function notifyListenerCount(session, onListenerCount) {
	onListenerCount?.(session.sessionId, session.listeners.size);
}

function attachPublisher(session, socket, sessions, onListenerCount) {
	let configured = false;
	let frameCount = 0;
	let frameBytes = 0;
	let lastStatsAt = Date.now();
	let statsTimer;
	session.publisher = socket;
	session.config = null;
	for (const listener of session.nextListeners) {
		if (listener.readyState !== WS_OPEN) continue;
		session.listeners.add(listener);
		listener.once("close", () => {
			if (session.listeners.delete(listener)) notifyListenerCount(session, onListenerCount);
			removeSessionIfUnused(session, sessions);
		});
	}
	session.nextListeners.clear();
	notifyListenerCount(session, onListenerCount);

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

function createWebAudioGateway({
	host = "127.0.0.1",
	port = 8080,
	defaultSessionId,
	onPlayQuery,
	onControl,
	onGetPlayerState,
	onListenerCount,
} = {}) {
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be an integer from 0 to 65535");
	if (defaultSessionId !== undefined && !isValidSessionId(defaultSessionId)) {
		throw new TypeError(invalidSessionIdMessage());
	}
	if (!isLoopbackHost(host)) throw new Error(`The example gateway only supports loopback hosts; refusing to bind to ${host}`);

	const sessions = new Map();
	const pendingListeners = new Map();
	const httpServer = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (request.method === "GET" && pathname === "/config") {
			sendJson(response, 200, { defaultSessionId: defaultSessionId ?? null });
			return;
		}
		if (request.method === "GET" && pathname === "/health") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ status: "ok", activeSessions: sessions.size }));
			return;
		}
		if (request.method === "GET" && pathname === "/player-state") {
			void (async () => {
				const sessionId = new URL(request.url ?? "/", "http://localhost").searchParams.get("sessionId");
				if (!isValidSessionId(sessionId)) {
					sendJson(response, 400, { error: invalidSessionIdMessage() });
					return;
				}
				if (typeof onGetPlayerState !== "function") {
					sendJson(response, 503, { error: "Player state is not available" });
					return;
				}
				try {
					const state = await onGetPlayerState(sessionId);
					if (state === null) {
						sendJson(response, 404, { error: `No player exists for session ${sessionId}` });
						return;
					}
					sendJson(response, 200, { sessionId, ...state });
				} catch (error) {
					const statusCode = error && typeof error === "object" ? error.statusCode : undefined;
					if (statusCode) {
						sendJson(response, statusCode, { error: error.message });
						return;
					}
					console.error("Web player state request failed:", error);
					sendJson(response, 500, { error: "Player state request failed" });
				}
			})();
			return;
		}
		if (request.method === "POST" && pathname === "/control") {
			void (async () => {
				if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
					sendJson(response, 415, { error: "Content-Type must be application/json" });
					request.resume();
					return;
				}
				if (typeof onControl !== "function") {
					sendJson(response, 503, { error: "Playback controls are not available" });
					request.resume();
					return;
				}
				try {
					const body = await readJsonBody(request, 4096);
					if (!body || typeof body !== "object" || Array.isArray(body) || !isValidSessionId(body.sessionId)) {
						sendJson(response, 400, { error: invalidSessionIdMessage() });
						return;
					}
					const { action } = body;
					const supportedActions = [
						"pause",
						"resume",
						"stop",
						"skip",
						"seek",
						"volume",
						"loop",
						"autoplay",
						"filter",
						"filter-clear",
					];
					if (!supportedActions.includes(action)) {
						sendJson(response, 400, { error: "Unsupported playback control action" });
						return;
					}
					if (action === "seek" && (!Number.isFinite(body.positionMs) || body.positionMs < 0)) {
						sendJson(response, 400, { error: "positionMs must be a non-negative number" });
						return;
					}
					if (action === "volume" && (!Number.isFinite(body.volume) || body.volume < 0 || body.volume > 200)) {
						sendJson(response, 400, { error: "volume must be a number from 0 to 200" });
						return;
					}
					if (action === "loop" && !["off", "track", "queue"].includes(body.mode)) {
						sendJson(response, 400, { error: "mode must be off, track, or queue" });
						return;
					}
					if (action === "autoplay" && typeof body.enabled !== "boolean") {
						sendJson(response, 400, { error: "enabled must be a boolean" });
						return;
					}
					if (
						action === "filter" &&
						(typeof body.filterName !== "string" || !body.filterName.trim() || body.filterName.length > 100)
					) {
						sendJson(response, 400, { error: "filterName must be a non-empty string of at most 100 characters" });
						return;
					}
					if (action === "filter" && typeof body.enabled !== "boolean") {
						sendJson(response, 400, { error: "enabled must be a boolean" });
						return;
					}
					const result = await onControl(action, body, body.sessionId);
					if (result === null) {
						sendJson(response, 503, { error: "Player is not ready" });
						return;
					}
					if (result === false) {
						sendJson(response, 409, {
							error: `${action} was not applied; check that the player has an active track and supports this operation`,
						});
						return;
					}
					sendJson(response, 200, { sessionId: body.sessionId, action, result: result ?? null });
				} catch (error) {
					const statusCode = error && typeof error === "object" ? error.statusCode : undefined;
					if (statusCode) {
						if (!response.destroyed) sendJson(response, statusCode, { error: error.message });
						return;
					}
					console.error("Web playback control failed:", error);
					if (!response.destroyed) sendJson(response, 500, { error: "Playback control failed" });
				}
			})();
			return;
		}
		if (request.method === "POST" && pathname === "/play") {
			void (async () => {
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
					const sessionId = body.sessionId ?? defaultSessionId;
					if (!isValidSessionId(sessionId)) {
						sendJson(response, 400, { error: invalidSessionIdMessage() });
						return;
					}
					const result = await onPlayQuery(body.query.trim(), sessionId);
					if (result === null) {
						sendJson(response, 503, { error: "Player is not ready" });
						return;
					}
					if (!result) {
						sendJson(response, 422, { error: "No playable track found for this query" });
						return;
					}
					if (!(await waitForPublisher(sessions, sessionId))) {
						sendJson(response, 504, { error: `No audio publisher appeared for session ${sessionId}` });
						return;
					}
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
				attachPendingListeners(session, pendingListeners);
				sessions.set(parsed.sessionId, session);
				attachPublisher(session, webSocket, sessions, onListenerCount);
				console.info(`Audio publisher connected: ${parsed.sessionId}`);
			} else if (parsed.role === "next-listener") {
				const queue = queuePendingListener(pendingListeners, webSocket, parsed.sessionId ?? null);
				webSocket.on("error", (error) => {
					console.error(`Waiting audio listener socket error for ${parsed.sessionId ?? "next publisher"}:`, error);
					queue.delete(webSocket);
				});
				console.info(`Audio listener waiting for ${parsed.sessionId ? `session ${parsed.sessionId}` : "the next publisher"}`);
			} else {
				const session = sessions.get(parsed.sessionId);
				if (!session || session.publisher?.readyState !== WS_OPEN) {
					webSocket.close(1012, "Publisher disconnected");
					return;
				}
				session.listeners.add(webSocket);
				notifyListenerCount(session, onListenerCount);
				if (session.config) webSocket.send(JSON.stringify(session.config));
				webSocket.once("close", () => {
					if (session.listeners.delete(webSocket)) notifyListenerCount(session, onListenerCount);
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
			for (const listeners of pendingListeners.values()) {
				for (const listener of listeners) listener.close(1001, "Gateway shutting down");
			}
			pendingListeners.clear();
			for (const session of sessions.values()) {
				session.publisher?.close(1001, "Gateway shutting down");
				for (const listener of session.listeners) listener.close(1001, "Gateway shutting down");
				session.nextListeners.clear();
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
