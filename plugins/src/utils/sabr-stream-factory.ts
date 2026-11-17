import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import zlib from "node:zlib";

import { Constants, type IPlayerResponse, Platform, YTNodes, type Types, type Context } from "youtubei.js";
import { SabrStream, type SabrPlaybackOptions, type PlayabilityStatus } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes, base64ToU8, concatenateChunks } from "googlevideo/utils";
import { UmpReader } from "googlevideo/ump";
import {
	UMPPartId,
	OnesieInnertubeRequest,
	OnesieHeader,
	OnesieProxyStatus,
	OnesieInnertubeResponse,
	OnesieRequest,
	CompressionType,
	OnesieHeaderType,
	type ReloadPlaybackContext,
} from "googlevideo/protos";
import type { SabrFormat } from "googlevideo/shared-types";

import type { Innertube } from "youtubei.js";
import { mintYouTubePoToken, mintYouTubePoTokenBytes } from "./youtube-botguard.js";
import { webStreamToNodeStream } from "./stream-converter.js";

Platform.shim.eval = async (data: Types.BuildScriptResult) => {
	return new Function(data.output)();
};

export interface OutputStream {
	stream: WriteStream;
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
	author?: string;
	duration?: number;
}

export interface SabrVideoResult {
	title: string;
	stream: Readable;
	format: {
		mimeType: string;
		itag: number;
		contentLength: number;
	};
	author?: string;
	duration?: number;
}

/**
 * Standard YouTube player request with signature timestamp and web client context.
 */
export async function makePlayerRequest(
	innertube: Innertube,
	input: string | YTNodes.NavigationEndpoint,
	reloadPlaybackContext?: ReloadPlaybackContext,
	client: string = "WEB",
): Promise<any> {
	const watchEndpoint = typeof input === "string" ? new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId: input } }) : input;

	const extraArgs: Record<string, any> = {
		playbackContext: {
			contentPlaybackContext: {
				vis: 0,
				splay: false,
				signatureTimestamp: innertube.session.player?.signature_timestamp,
			},
		},
		contentCheckOk: true,
		racyCheckOk: true,
		client,
	};

	if (reloadPlaybackContext) {
		extraArgs.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
	}

	return await watchEndpoint.call(innertube.actions, { ...extraArgs, parse: true });
}

type TVClientConfig = {
	clientKeyData: Uint8Array;
	encryptedClientKey: Uint8Array;
	onesieUstreamerConfig: Uint8Array;
	baseUrl: string;
};

async function getYouTubeTVClientConfig(signal?: AbortSignal): Promise<TVClientConfig> {
	const tvConfigResponse = await fetch("https://www.youtube.com/tv_config?action_get_config=true&client=lb4&theme=cl", {
		method: "GET",
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
		},
	});

	const tvConfig = await tvConfigResponse.text();
	if (!tvConfig.startsWith(")]}'")) {
		throw new Error("Invalid response from YouTube TV config endpoint");
	}

	const tvConfigJson = JSON.parse(tvConfig.slice(4));
	const webPlayerContextConfig = tvConfigJson.webPlayerContextConfig.WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH;
	const onesieHotConfig = webPlayerContextConfig.onesieHotConfig;

	return {
		clientKeyData: base64ToU8(onesieHotConfig.clientKey),
		encryptedClientKey: base64ToU8(onesieHotConfig.encryptedClientKey),
		onesieUstreamerConfig: base64ToU8(onesieHotConfig.onesieUstreamerConfig),
		baseUrl: onesieHotConfig.baseUrl,
	};
}

async function encryptRequest(clientKey: Uint8Array, data: Uint8Array) {
	const aesKeyData = clientKey.slice(0, 16);
	const hmacKeyData = clientKey.slice(16, 32);
	const iv = crypto.getRandomValues(new Uint8Array(16));

	const aesKey = await crypto.subtle.importKey("raw", aesKeyData, { name: "AES-CTR", length: 128 }, false, ["encrypt"]);

	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 128 }, aesKey, data as any),
	);

	const hmacKey = await crypto.subtle.importKey("raw", hmacKeyData, { name: "HMAC", hash: { name: "SHA-256" } }, false, ["sign"]);

	const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new Uint8Array([...encrypted, ...iv])));

	return { encrypted, hmac, iv };
}

/**
 * Fallback: Fetches player response using UMP Onesie request (/initplayback)
 * when normal player endpoints fail or are blocked.
 */
export async function getOnesiePlayerResponse(innertube: Innertube, videoId: string, signal?: AbortSignal): Promise<any> {
	const redirectorResponse = await fetch(
		`https://redirector.googlevideo.com/initplayback?source=youtube&itag=0&pvi=0&pai=0&owc=yes&cmo:sensitive_content=yes&alr=yes&id=${Math.round(Math.random() * 1e5)}`,
		{ method: "GET", signal },
	);
	const redirectorResponseUrl = await redirectorResponse.text();

	if (!redirectorResponseUrl.startsWith("https://")) {
		throw new Error("Invalid redirector response");
	}

	const clientConfig = await getYouTubeTVClientConfig(signal);
	const clonedContext: Context = structuredClone(innertube.session.context);

	const playerRequestJson = {
		context: clonedContext,
		playbackContext: {
			contentPlaybackContext: {
				vis: 0,
				splay: false,
				lactMilliseconds: "-1",
				signatureTimestamp: innertube.session.player?.signature_timestamp,
			},
		},
		videoId,
	};

	const onesieInnertubeRequest = OnesieInnertubeRequest.encode({
		url: "https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8",
		headers: [
			{ name: "Content-Type", value: "application/json" },
			{ name: "User-Agent", value: clonedContext.client.userAgent },
			{ name: "X-Goog-Visitor-Id", value: clonedContext.client.visitorData },
		],
		body: JSON.stringify(playerRequestJson),
		proxiedByTrustedBandaid: true,
		skipResponseEncryption: true,
	}).finish();

	const { encrypted, hmac, iv } = await encryptRequest(clientConfig.clientKeyData, onesieInnertubeRequest);

	const clientNameId = Constants.CLIENT_NAME_IDS[clonedContext.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS];

	const body = OnesieRequest.encode({
		urls: [],
		innertubeRequest: {
			enableCompression: true,
			encryptedClientKey: clientConfig.encryptedClientKey,
			enableAdPlacementsPreroll: false,
			encryptedOnesieInnertubeRequest: encrypted,
			hmac,
			iv,
			useJsonformatterToParsePlayerResponse: false,
			serializeResponseAsJson: true,
		},
		streamerContext: {
			sabrContexts: [],
			unsentSabrContexts: [],
			playbackCookie: undefined,
			clientInfo: {
				clientName: clientNameId ? parseInt(String(clientNameId), 10) : 1,
				clientVersion: clonedContext.client.clientVersion,
			},
		},
		bufferedRanges: [],
		onesieUstreamerConfig: clientConfig.onesieUstreamerConfig,
	}).finish();

	const videoIdBytes = base64ToU8(videoId);
	const encodedVideoId = Array.from(videoIdBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const url = `${redirectorResponseUrl.split("/initplayback")[0]}${clientConfig.baseUrl}&id=${encodedVideoId}&cmo:sensitive_content=yes&opr=1&osts=0&por=1&rn=0`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "*/*",
			"content-type": "application/octet-stream",
		},
		referrer: "https://www.youtube.com/",
		body: body as any,
		signal,
	});

	let lastHeader: OnesieHeader | undefined;
	let playerResponseHeader: OnesieHeader | undefined;
	let playerResponseData: Uint8Array | undefined;

	const umpReader = new UmpReader({
		onPart: (type, data) => {
			switch (type) {
				case UMPPartId.ONESIE_HEADER:
					lastHeader = OnesieHeader.decode(concatenateChunks(data.chunks));
					break;
				case UMPPartId.ONESIE_DATA:
					if (lastHeader?.type === OnesieHeaderType.ONESIE_PLAYER_RESPONSE) {
						playerResponseHeader = lastHeader;
						playerResponseData = concatenateChunks(data.chunks);
					}
					lastHeader = undefined;
					break;
			}
		},
	});

	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing Onesie response body");

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		await umpReader.feed(value);
	}

	if (!playerResponseHeader || !playerResponseData) {
		throw new Error("Missing Onesie Player Response");
	}

	let decryptedData = playerResponseData;
	if (playerResponseHeader.cryptoParams?.compressionType === CompressionType.GZIP) {
		decryptedData = new Uint8Array(zlib.gunzipSync(decryptedData));
	}

	const onesieInnertubeResponse = OnesieInnertubeResponse.decode(decryptedData);
	if (onesieInnertubeResponse.onesieProxyStatus !== OnesieProxyStatus.OK) {
		throw new Error("Onesie proxy status not OK");
	}

	const rawJson = JSON.parse(new TextDecoder().decode(onesieInnertubeResponse.body));
	return rawJson;
}

/**
 * Resolves player response trying makePlayerRequest first, then fallback clients, then Onesie UMP.
 */
async function resolvePlayerResponse(innertube: Innertube, videoId: string, signal?: AbortSignal): Promise<any> {
	try {
		const res = await makePlayerRequest(innertube, videoId);
		if (res?.streaming_data?.server_abr_streaming_url || res?.streaming_data?.adaptive_formats?.length) {
			return res;
		}
	} catch {}

	try {
		const res = await innertube.getBasicInfo(videoId, { client: "YTMUSIC" });
		if (res?.streaming_data?.server_abr_streaming_url || res?.streaming_data?.adaptive_formats?.length) {
			return res;
		}
	} catch {}

	try {
		const res = await innertube.getInfo(videoId, { client: "TV" as any });
		if (res?.streaming_data?.server_abr_streaming_url || res?.streaming_data?.adaptive_formats?.length) {
			return res;
		}
	} catch {}

	// Fallback to UMP Onesie request
	return await getOnesiePlayerResponse(innertube, videoId, signal);
}

function getClientInfo(innertube: Innertube) {
	const rawName = innertube.session.context.client.clientName;
	const clientNameId = Constants.CLIENT_NAME_IDS[rawName as keyof typeof Constants.CLIENT_NAME_IDS];
	const clientName = clientNameId !== undefined ? parseInt(String(clientNameId), 10) : 1;
	const clientVersion = innertube.session.context.client.clientVersion;
	return { clientName, clientVersion };
}

/**
 * Creates a SABR audio stream (defaults to Opus/WebM itag 251, fallback AAC/MP4 itag 140).
 */
export async function createSabrStream(
	videoId: string,
	innertube: Innertube,
	options?: Partial<SabrPlaybackOptions>,
	signal?: AbortSignal,
): Promise<SabrAudioResult> {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	const throwIfAborted = () => {
		if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	};

	let sabrStream: SabrStream | undefined;

	try {
		throwIfAborted();
		const playerResponse = await resolvePlayerResponse(innertube, videoId, signal);
		throwIfAborted();

		if (playerResponse.playability_status?.status && playerResponse.playability_status.status !== "OK") {
			throw new Error(`Video is not playable: ${playerResponse.playability_status.status}`);
		}

		const rawStreamingUrl = playerResponse.streaming_data?.server_abr_streaming_url;
		if (!rawStreamingUrl) {
			throw new Error("Missing server_abr_streaming_url in YouTube response");
		}

		const serverAbrStreamingUrl = await innertube.session.player?.decipher(rawStreamingUrl);
		const videoPlaybackUstreamerConfig =
			playerResponse.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
		if (!serverAbrStreamingUrl || !videoPlaybackUstreamerConfig) {
			throw new Error("Missing streaming info for SABR playback");
		}

		const sabrFormats: SabrFormat[] = (playerResponse.streaming_data?.adaptive_formats ?? []).map((f: any) => buildSabrFormat(f));
		if (!sabrFormats.length) {
			throw new Error("No adaptive formats available for SABR stream");
		}

		const heartbeatParams = playerResponse.heartbeat_params;
		const initialPoToken = await mintYouTubePoToken(videoId, signal);
		throwIfAborted();

		sabrStream = new SabrStream({
			videoId,
			formats: sabrFormats,
			serverAbrStreamingUrl,
			videoPlaybackUstreamerConfig,
			poToken: initialPoToken,
			heartbeatParams: {
				heartbeatToken: heartbeatParams?.heartbeat_token,
				heartbeatServerData: heartbeatParams?.heartbeat_server_data,
				intervalMilliseconds: heartbeatParams?.interval_milliseconds,
			},
			clientInfo: getClientInfo(innertube),
			callbacks: {
				onMintPoToken: () => mintYouTubePoTokenBytes(videoId, signal),
				onReloadPlayerResponse: async (playbackContext) => {
					const reloadRes = await makePlayerRequest(innertube, videoId, playbackContext);
					const newUrl =
						reloadRes.streaming_data?.server_abr_streaming_url ?
							await innertube.session.player?.decipher(reloadRes.streaming_data.server_abr_streaming_url)
						:	undefined;
					const newConfig =
						reloadRes.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
					if (!newUrl || !newConfig) {
						throw new Error("Missing serverAbrStreamingUrl or videoPlaybackUstreamerConfig in reloaded player response");
					}
					return {
						videoPlaybackUstreamerConfig: newConfig,
						serverAbrStreamingUrl: newUrl,
					};
				},
				onCheckHeartbeat: async (innertubeRequestBody) => {
					try {
						const heartbeatResponse = await innertube.actions.execute("/player/heartbeat", {
							...innertubeRequestBody,
							parse: true,
						});

						if (!heartbeatResponse.playability_status) {
							return { status: "OK" as PlayabilityStatus };
						}

						const status = (heartbeatResponse.playability_status?.status ?? "OK") as PlayabilityStatus;
						const pollDelayMs = heartbeatResponse.poll_delay_ms;
						const liveStreamability = heartbeatResponse.playability_status_memo?.getType(YTNodes.LiveStreamability).first();
						const displayEndscreen = !!liveStreamability?.display_endscreen;
						const offlineSlate = liveStreamability?.offline_slate;
						const broadcastId = liveStreamability?.broadcast_id;

						return {
							status,
							displayEndscreen,
							offlineSlatePresent: !!offlineSlate,
							offlineSlateButtonsPresent: !!offlineSlate?.action_buttons?.length,
							broadcastId,
							pollDelayMs,
							heartbeatServerData: heartbeatResponse.heartbeat_server_data ?? innertubeRequestBody.heartbeatServerData,
						};
					} catch {
						return { status: "OK" as PlayabilityStatus };
					}
				},
			},
		});

		const isLive = Boolean(playerResponse.video_details?.is_live);
		const playbackOptions: SabrPlaybackOptions = {
			audioPreferences: {
				container: isLive ? "mp4" : undefined,
				preferredAudioCodec: isLive ? "aac" : "opus",
				dynamicRangeCompression: false,
				voiceBoost: false,
				...options?.audioPreferences,
			},
			enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
			isPostLiveDvr: Boolean(playerResponse.video_details?.is_post_live_dvr),
			...options,
		};

		const { audioStream, selectedFormats } = sabrStream.start(playbackOptions);
		throwIfAborted();

		if (!audioStream || !selectedFormats.audioFormat) {
			throw new Error("SABR did not return an audio stream or format");
		}

		const currentSabr = sabrStream;
		const nodeStream = await webStreamToNodeStream(audioStream, 64 * 1024, 0, signal);

		const cleanup = () => {
			try {
				currentSabr.abort();
			} catch {}
		};
		nodeStream.once("close", cleanup);
		nodeStream.once("error", cleanup);
		nodeStream.once("end", cleanup);

		const title = playerResponse.video_details?.title ?? playerResponse.basic_info?.title ?? videoId;
		const author = playerResponse.video_details?.author ?? playerResponse.basic_info?.author;
		const duration = Number(playerResponse.video_details?.duration ?? playerResponse.basic_info?.duration ?? NaN);

		return {
			title,
			stream: nodeStream,
			format: {
				mimeType: selectedFormats.audioFormat.mimeType ?? "audio/webm",
				itag: Number(selectedFormats.audioFormat.itag ?? 0),
				contentLength: Number(selectedFormats.audioFormat.contentLength ?? 0),
			},
			author,
			duration,
		};
	} catch (error) {
		if (sabrStream) {
			try {
				sabrStream.abort();
			} catch {}
		}
		throw error;
	}
}

/**
 * Creates a SABR video stream (defaults to MP4 H264 itag 137, 1080p).
 * Drains audio in background so SABR track buffer never stalls the video output.
 */
export async function createSabrVideoStream(
	videoId: string,
	innertube: Innertube,
	options?: Partial<SabrPlaybackOptions>,
	signal?: AbortSignal,
): Promise<SabrVideoResult> {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	const throwIfAborted = () => {
		if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	};

	let sabrStream: SabrStream | undefined;

	try {
		throwIfAborted();
		const playerResponse = await resolvePlayerResponse(innertube, videoId, signal);
		throwIfAborted();

		if (playerResponse.playability_status?.status && playerResponse.playability_status.status !== "OK") {
			throw new Error(`Video is not playable: ${playerResponse.playability_status.status}`);
		}

		const rawStreamingUrl = playerResponse.streaming_data?.server_abr_streaming_url;
		if (!rawStreamingUrl) {
			throw new Error("Missing server_abr_streaming_url in YouTube response");
		}

		const serverAbrStreamingUrl = await innertube.session.player?.decipher(rawStreamingUrl);
		const videoPlaybackUstreamerConfig =
			playerResponse.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
		if (!serverAbrStreamingUrl || !videoPlaybackUstreamerConfig) {
			throw new Error("Missing streaming info for SABR playback");
		}

		const sabrFormats: SabrFormat[] = (playerResponse.streaming_data?.adaptive_formats ?? []).map((f: any) => buildSabrFormat(f));
		if (!sabrFormats.length) {
			throw new Error("No adaptive formats available for SABR stream");
		}

		const heartbeatParams = playerResponse.heartbeat_params;
		const initialPoToken = await mintYouTubePoToken(videoId, signal);
		throwIfAborted();

		sabrStream = new SabrStream({
			videoId,
			formats: sabrFormats,
			serverAbrStreamingUrl,
			videoPlaybackUstreamerConfig,
			poToken: initialPoToken,
			heartbeatParams: {
				heartbeatToken: heartbeatParams?.heartbeat_token,
				heartbeatServerData: heartbeatParams?.heartbeat_server_data,
				intervalMilliseconds: heartbeatParams?.interval_milliseconds,
			},
			clientInfo: getClientInfo(innertube),
			callbacks: {
				onMintPoToken: () => mintYouTubePoTokenBytes(videoId, signal),
				onReloadPlayerResponse: async (playbackContext) => {
					const reloadRes = await makePlayerRequest(innertube, videoId, playbackContext);
					const newUrl =
						reloadRes.streaming_data?.server_abr_streaming_url ?
							await innertube.session.player?.decipher(reloadRes.streaming_data.server_abr_streaming_url)
						:	undefined;
					const newConfig =
						reloadRes.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
					if (!newUrl || !newConfig) {
						throw new Error("Missing serverAbrStreamingUrl or videoPlaybackUstreamerConfig in reloaded player response");
					}
					return {
						videoPlaybackUstreamerConfig: newConfig,
						serverAbrStreamingUrl: newUrl,
					};
				},
				onCheckHeartbeat: async (innertubeRequestBody) => {
					try {
						const heartbeatResponse = await innertube.actions.execute("/player/heartbeat", {
							...innertubeRequestBody,
							parse: true,
						});

						if (!heartbeatResponse.playability_status) {
							return { status: "OK" as PlayabilityStatus };
						}

						const status = (heartbeatResponse.playability_status?.status ?? "OK") as PlayabilityStatus;
						const pollDelayMs = heartbeatResponse.poll_delay_ms;
						const liveStreamability = heartbeatResponse.playability_status_memo?.getType(YTNodes.LiveStreamability).first();
						const displayEndscreen = !!liveStreamability?.display_endscreen;
						const offlineSlate = liveStreamability?.offline_slate;
						const broadcastId = liveStreamability?.broadcast_id;

						return {
							status,
							displayEndscreen,
							offlineSlatePresent: !!offlineSlate,
							offlineSlateButtonsPresent: !!offlineSlate?.action_buttons?.length,
							broadcastId,
							pollDelayMs,
							heartbeatServerData: heartbeatResponse.heartbeat_server_data ?? innertubeRequestBody.heartbeatServerData,
						};
					} catch {
						return { status: "OK" as PlayabilityStatus };
					}
				},
			},
		});

		const isLive = Boolean(playerResponse.video_details?.is_live);
		const playbackOptions: SabrPlaybackOptions = {
			videoPreferences: {
				container: "webm",
				quality: isLive ? "720p" : "1080p",
				preferredVideoCodec: "vp9",
				...options?.videoPreferences,
			},
			audioPreferences: {
				container: isLive ? "mp4" : undefined,
				preferredAudioCodec: isLive ? "aac" : "opus",
				dynamicRangeCompression: false,
				voiceBoost: false,
				...options?.audioPreferences,
			},
			enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
			isPostLiveDvr: Boolean(playerResponse.video_details?.is_post_live_dvr),
			...options,
		};

		const { videoStream, audioStream, selectedFormats } = sabrStream.start(playbackOptions);
		throwIfAborted();

		if (!videoStream || !selectedFormats.videoFormat) {
			throw new Error("SABR did not return a video stream or format");
		}

		// Drain audio stream in background so video stream never stalls from full audio buffer
		(async () => {
			try {
				const reader = audioStream.getReader();
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
			} catch {}
		})();

		const currentSabr = sabrStream;
		const nodeStream = await webStreamToNodeStream(videoStream, 512 * 1024, 0, signal);

		const cleanup = () => {
			try {
				currentSabr.abort();
			} catch {}
		};
		nodeStream.once("close", cleanup);
		nodeStream.once("error", cleanup);
		nodeStream.once("end", cleanup);

		const title = playerResponse.video_details?.title ?? playerResponse.basic_info?.title ?? videoId;
		const author = playerResponse.video_details?.author ?? playerResponse.basic_info?.author;
		const duration = Number(playerResponse.video_details?.duration ?? playerResponse.basic_info?.duration ?? NaN);

		return {
			title,
			stream: nodeStream,
			format: {
				mimeType: selectedFormats.videoFormat.mimeType ?? "video/mp4",
				itag: Number(selectedFormats.videoFormat.itag ?? 0),
				contentLength: Number(selectedFormats.videoFormat.contentLength ?? 0),
			},
			author,
			duration,
		};
	} catch (error) {
		if (sabrStream) {
			try {
				sabrStream.abort();
			} catch {}
		}
		throw error;
	}
}

export function createOutputStream(videoTitle: string, mimeType: string): OutputStream {
	const sanitizedTitle = sanitizeFileName(videoTitle) || "media";
	const extension = getExtensionFromMimeType(mimeType);
	const fileName = `${sanitizedTitle}.${extension}`;
	const filePath = join(tmpdir(), fileName);
	const stream = createWriteStream(filePath);
	return { stream, filePath };
}

function sanitizeFileName(name: string): string {
	return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function getExtensionFromMimeType(mimeType: string): string {
	const normalized = mimeType.toLowerCase().split(";")[0];
	return (
		(
			{
				"audio/mpeg": "mp3",
				"audio/mp4": "m4a",
				"audio/webm": "webm",
				"audio/ogg": "ogg",
				"video/mp4": "mp4",
				"video/webm": "webm",
			} as Record<string, string>
		)[normalized] ?? "bin"
	);
}
