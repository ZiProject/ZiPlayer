import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

import { BotGuardClient, getChallenge } from "bgutils-js/botguard";

import type { WebPoSignalOutput } from "bgutils-js/shared-types";

import { buildURL, getHeaders, USER_AGENT } from "bgutils-js/utils";

import { WebPoMinter } from "bgutils-js/webpo";

import { JSDOM } from "jsdom";

import { Constants, Innertube, Platform, UniversalCache, type Types } from "youtubei.js";

import { SabrStream, type SabrPlaybackOptions } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import type { SabrFormat } from "googlevideo/shared-types";
import type { ReloadPlaybackContext } from "googlevideo/protos";

export interface OutputStream {
	stream: NodeJS.WritableStream;
	filePath: string;
}

export interface SabrAudioResult {
	title: string;
	stream: Readable;
	format: {
		mimeType: string;
		itag: number;
		contentLength: number;
	};
}

/**
 * youtubei.js needs a JS interpreter for player signature/n parameter
 * deciphering. googlevideo/SABR relies on the same player implementation.
 */
Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

/**
 * Generate a BotGuard Proof of Origin token.
 *
 * The token is bound to the video/content identifier. YouTube can reject
 * SABR requests without it, especially for newer Web clients.
 */
async function generatePoToken(contentBinding: string, signal?: AbortSignal): Promise<string> {
	const requestKey = "O43z0dpjhgX20SCx4KAo";

	const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
		url: "https://www.youtube.com/",
		referrer: "https://www.youtube.com/",
		userAgent: USER_AGENT,
	});

	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		origin: dom.window.origin,
	});

	if (!Reflect.has(globalThis, "navigator")) {
		Object.defineProperty(globalThis, "navigator", {
			value: dom.window.navigator,
		});
	}

	/*
	 * 1. Get BotGuard challenge
	 */
	const challenge = await getChallenge({
		fetchFunction: fetch,
		requestKey,
	});

	/*
	 * 2. Load BotGuard interpreter
	 */
	const interpreterJavascript = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;

	if (!interpreterJavascript) {
		throw new Error("BotGuard interpreter javascript is not available");
	}

	// eslint-disable-next-line no-new-func
	new Function(interpreterJavascript)();

	/*
	 * 3. Create BotGuard client
	 */
	const botGuardClient = await BotGuardClient.create({
		program: challenge.program,
		globalName: challenge.globalName,
		globalObject: globalThis,
	});

	/*
	 * 4. Generate WebPO signal
	 */
	const webPoSignalOutput: WebPoSignalOutput = [];

	const botguardResponse = await botGuardClient.snapshot({
		webPoSignalOutput,
	});

	/*
	 * 5. Exchange BotGuard response for Integrity Token
	 */
	const response = await fetch(buildURL("GenerateIT", true), {
		method: "POST",
		headers: getHeaders(),
		body: JSON.stringify([requestKey, botguardResponse]),
		signal,
	});

	if (!response.ok) {
		throw new Error(`GenerateIT failed: HTTP ${response.status}`);
	}

	const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = (await response.json()) as [
		string,
		number,
		number,
		string,
	];

	if (!integrityToken) {
		throw new Error("GenerateIT returned an empty integrity token");
	}

	/*
	 * 6. Create WebPO minter
	 */
	const webPoMinter = await WebPoMinter.create(
		{
			integrityToken,
			estimatedTtlSecs,
			mintRefreshThreshold,
			websafeFallbackToken,
		},
		webPoSignalOutput,
	);

	/*
	 * 7. Mint token bound to the video ID
	 */
	return webPoMinter.mintAsWebsafeString(contentBinding);
}

/**
 * Creates the InnerTube client used by the SABR downloader.
 *
 * A caller may supply its own client so cookies/session state can be reused.
 */
export async function createSabrInnertube(): Promise<Innertube> {
	return Innertube.create({
		cache: new UniversalCache(true),
	});
}

/**
 * Make a player request suitable for SABR.
 *
 * Keeping this as a NavigationEndpoint call lets youtubei.js construct the
 * proper InnerTube request and also allows reloadPlaybackContext to be passed
 * back when SabrStream asks for a player response refresh.
 */
async function makePlayerRequest(
	innertube: Innertube,
	videoId: string,
	_reloadPlaybackContext?: ReloadPlaybackContext,
): Promise<any> {
	return innertube.getBasicInfo(videoId, { client: "YTMUSIC" });
}

function getClientInfo(innertube: Innertube) {
	const clientName =
		Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS];

	if (clientName === undefined) {
		throw new Error(`Unknown InnerTube client: ${innertube.session.context.client.clientName}`);
	}

	return {
		clientName: parseInt(String(clientName), 10),
		clientVersion: innertube.session.context.client.clientVersion,
	};
}

/**
 * Best-effort cancellation of a Web ReadableStream.
 *
 * Used to drop the SABR video track (which this factory never exposes to
 * callers) so the server stops pushing video segments and nothing lingers
 * un-drained in memory.
 */
async function safeCancelStream(stream: ReadableStream<Uint8Array> | undefined, reason?: unknown): Promise<void> {
	if (!stream) return;

	try {
		await stream.cancel(reason);
	} catch {
		// Already closed/cancelled/errored - nothing to do.
	}
}

/**
 * Best-effort teardown of a SabrStream instance.
 *
 * `SabrStream#abort()` is the only thing that actually stops the internal
 * request loop, releases the video/audio controllers, and clears the
 * session's internal maps (initialized formats, partial segment queue, SABR
 * contexts, etc). Destroying only the Node.js Readable we hand back to the
 * caller does NOT reach any of this - it only cancels the audio reader.
 * Without calling this, every `createSabrStream()` call leaves a live
 * SabrStream (plus its still-registered `reloadPlayerResponse` listener)
 * behind after the track ends, which is why memory keeps climbing across
 * track changes instead of settling back down.
 */
function safeAbortSabr(sabr: SabrStream): void {
	try {
		sabr.abort();
	} catch {
		// Already aborted/finished - nothing to do.
	}
}

/**
 * Create a SABR audio stream.
 *
 * This preserves the original factory API:
 *   createSabrStream(videoId, innertube, options)
 *
 * Only the audio track is ever exposed to the caller. The video track is
 * cancelled immediately (or simply never requested, if the caller doesn't
 * override `enabledTrackTypes`) so no video segments are buffered for
 * nothing, and the underlying `SabrStream` session is always aborted once
 * the returned Node.js stream ends, errors, or is destroyed - so no SABR
 * session is left running in the background after a track finishes.
 */
export async function createSabrStream(
	videoId: string,
	innertube: Innertube,
	options?: Partial<SabrPlaybackOptions>,
	signal?: AbortSignal,
): Promise<SabrAudioResult> {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	}

	const throwIfAborted = () => {
		if (!signal?.aborted) return;

		throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	};

	// Tracks the SabrStream instance for this call so it can be torn down
	// from the outer catch block if anything fails before/while consuming
	// the returned streams.
	let sabr: SabrStream | undefined;
	let reloadHandler: ((reloadPlaybackContext: ReloadPlaybackContext) => void) | undefined;

	try {
		if (!videoId) {
			throw new Error("videoId is required");
		}

		console.info(`[SABR] Generating PoToken for ${videoId}...`);
		const poToken = await generatePoToken(videoId, signal);

		throwIfAborted();

		console.info(`[SABR] Loading player response...`);
		const videoInfo = await makePlayerRequest(innertube, videoId);

		throwIfAborted();

		const playability = videoInfo.playability_status;

		if (playability?.status && playability.status !== "OK") {
			throw new Error(`Video is not playable: ${playability.status} ` + `(${playability.reason ?? "no reason given"})`);
		}

		const title = videoInfo.video_details?.title ?? videoInfo.basic_info?.title ?? videoId;

		const format = videoInfo.chooseFormat({
			quality: "best",
			type: "audio",
		});

		if (!format) {
			throw new Error("Could not choose an audio format");
		}

		const audioStreamingURL = `${await format.decipher(innertube.session.player)}&pot=${poToken}`;

		if (!audioStreamingURL) {
			throw new Error("Could not decipher audio streaming URL");
		}

		const streamingUrl = videoInfo.streaming_data?.server_abr_streaming_url;

		if (!streamingUrl) {
			throw new Error("This video has no SABR streaming URL. YouTube may have returned a legacy/non-SABR response.");
		}

		const serverAbrStreamingUrl = await innertube.session.player?.decipher(streamingUrl);

		if (!serverAbrStreamingUrl) {
			throw new Error("Could not decipher SABR streaming URL");
		}

		const ustreamerConfig =
			videoInfo.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;

		if (!ustreamerConfig) {
			throw new Error("Could not find video_playback_ustreamer_config");
		}

		const adaptiveFormats = videoInfo.streaming_data?.adaptive_formats ?? [];

		if (!adaptiveFormats.length) {
			throw new Error("Player response contains no adaptive formats");
		}

		const formats: SabrFormat[] = adaptiveFormats.map((format: any) => buildSabrFormat(format));

		sabr = new SabrStream({
			formats,
			serverAbrStreamingUrl,
			videoPlaybackUstreamerConfig: ustreamerConfig,
			poToken,
			clientInfo: getClientInfo(innertube),
		});

		/*
		 * SABR can request a fresh player response when the original response
		 * expires or the server changes playback state.
		 */
		reloadHandler = async (reloadPlaybackContext: ReloadPlaybackContext) => {
			try {
				throwIfAborted();

				console.info(`[SABR] Reloading player response...`);

				// Refresh the player response AND the content-bound WebPO token.
				// Reusing the original token after a protection/session reload can
				// cause SABR media requests to stop part-way through playback.
				const [reloaded, refreshedPoToken] = await Promise.all([
					makePlayerRequest(innertube, videoId, reloadPlaybackContext),
					generatePoToken(videoId, signal),
				]);

				throwIfAborted();

				const newUrl =
					reloaded.streaming_data?.server_abr_streaming_url ?
						await innertube.session.player?.decipher(reloaded.streaming_data.server_abr_streaming_url)
					:	undefined;

				const newConfig =
					reloaded.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;

				const newFormats: SabrFormat[] = (reloaded.streaming_data?.adaptive_formats ?? []).map((format: any) =>
					buildSabrFormat(format),
				);

				// SabrStream exposes setters for all state that may change during
				// a player-response reload.
				sabr?.setPoToken(refreshedPoToken);

				if (newUrl) {
					sabr?.setStreamingURL(newUrl);
				}

				if (newConfig) {
					sabr?.setUstreamerConfig(newConfig);
				}

				if (newFormats.length) {
					sabr?.setServerAbrFormats(newFormats);
				}

				if (!newUrl && !newConfig && !newFormats.length) {
					console.warn("[SABR] Reload response did not contain updated SABR config");
				}
			} catch (error) {
				if (signal?.aborted) {
					return;
				}
				console.error("[SABR] Failed to reload player response:", error);
			}
		};

		sabr.on("reloadPlayerResponse", reloadHandler);

		const playbackOptions: SabrPlaybackOptions = {
			...options,

			// We only ever expose audio from this factory. Defaulting to
			// AUDIO_ONLY (instead of VIDEO_AND_AUDIO) means the server never
			// pushes video segments in the first place, instead of us having to
			// discard them after the fact.
			enabledTrackTypes: options?.enabledTrackTypes ?? EnabledTrackTypes.AUDIO_ONLY,

			// Audio preference defaults.
			audioQuality: options?.audioQuality ?? "medium",

			// Prefer Opus/WebM when the selected client provides it.
			preferWebM: options?.preferWebM ?? true,

			preferOpus: options?.preferOpus ?? true,
		};

		console.info(`[SABR] Starting audio stream: ${title}`);

		const result = await sabr.start(playbackOptions);

		throwIfAborted();

		if (!result.audioStream) {
			throw new Error("SABR did not return an audio stream");
		}

		const audioFormat = result.selectedFormats?.audioFormat;

		if (!audioFormat) {
			throw new Error("SABR did not select an audio format");
		}

		const reader = result.audioStream.getReader();

		let aborted = false;
		let abortHandler: (() => void) | undefined;

		// Local, non-null reference to the SabrStream instance so the
		// generator/cleanup closures below don't have to keep re-checking for
		// undefined (TypeScript also can't narrow `sabr` across closures).
		const sabrSession = sabr;

		const nodeStream = Readable.from(
			(async function* () {
				try {
					while (true) {
						throwIfAborted();

						const { done, value } = await reader.read();

						if (done) break;

						if (signal?.aborted) {
							throwIfAborted();
						}

						yield Buffer.from(value);
					}
				} finally {
					try {
						await reader.cancel();
					} catch {
						// Already closed/cancelled.
					}

					try {
						reader.releaseLock();
					} catch {
						// Ignore.
					}

					// Whether we finished normally, errored, or were aborted, the
					// SabrStream session behind this Readable must always be torn
					// down here. This is what actually stops the internal request
					// loop and releases its resources - without it, the session
					// keeps running (and its `reloadPlayerResponse` listener stays
					// registered) long after playback has moved on.
					safeAbortSabr(sabrSession);
					void safeCancelStream(result.videoStream, "Video track is not used by this factory");

					if (reloadHandler) {
						sabrSession.off("reloadPlayerResponse", reloadHandler);
					}
				}
			})(),
		);

		abortHandler = () => {
			if (aborted) return;

			aborted = true;

			void reader.cancel(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
		};

		signal?.addEventListener("abort", abortHandler, { once: true });

		const cleanup = () => {
			if (abortHandler && signal) {
				signal.removeEventListener("abort", abortHandler);
				abortHandler = undefined;
			}
		};

		nodeStream.once("close", cleanup);
		nodeStream.once("error", cleanup);

		return {
			title,
			stream: nodeStream,
			format: {
				mimeType: audioFormat.mimeType ?? "audio/webm",
				itag: Number(audioFormat.itag ?? 0),
				contentLength: Number(audioFormat.contentLength ?? 0),
			},
		};
	} catch (error) {
		// We failed before handing a stream back to the caller (or before the
		// Readable's own finally block could take over cleanup duty) - make
		// sure the SabrStream session and its listener don't leak here either.
		if (sabr) {
			if (reloadHandler) {
				sabr.off("reloadPlayerResponse", reloadHandler);
			}
			safeAbortSabr(sabr);
		}

		console.error("[SABR]", error);

		throw new Error(`SABR stream creation failed: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

/**
 * Creates an output stream for writing downloaded content.
 */
export function createOutputStream(videoTitle: string, mimeType: string): OutputStream {
	const sanitizedTitle = sanitizeFileName(videoTitle) || "audio";

	const extension = getExtensionFromMimeType(mimeType);

	const fileName = `${sanitizedTitle}.${extension}`;

	const filePath = join(tmpdir(), fileName);

	const stream = createWriteStream(filePath);

	return {
		stream,
		filePath,
	};
}

/**
 * Sanitizes a filename for Windows/Linux/macOS.
 */
export function sanitizeFileName(name: string): string {
	return name
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
		.replace(/\s+/g, "_")
		.slice(0, 128);
}

export function bytesToMB(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(2);
}

function getExtensionFromMimeType(mimeType: string): string {
	const mime = mimeType.split(";")[0].trim().toLowerCase();

	const mimeMap: Record<string, string> = {
		"audio/mp4": "m4a",
		"audio/webm": "webm",
		"audio/ogg": "ogg",
		"audio/wav": "wav",
		"video/mp4": "mp4",
		"video/webm": "webm",
		"video/ogg": "ogv",
	};

	return mimeMap[mime] ?? "bin";
}

/**
 * Default audio-oriented SABR configuration.
 */
export const DEFAULT_SABR_OPTIONS: SabrPlaybackOptions = {
	preferWebM: true,
	preferOpus: true,
	audioQuality: "medium",
	enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
};
