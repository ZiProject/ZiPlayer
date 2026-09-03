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

export interface SabrVideoResult {
	title: string;
	stream: Readable;
	format: {
		mimeType: string;
		itag: number;
		contentLength: number;
	};
}

Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

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
	if (!Reflect.has(globalThis, "navigator")) Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
	const challenge = await getChallenge({ fetchFunction: fetch, requestKey });
	const interpreterJavascript = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
	if (!interpreterJavascript) throw new Error("BotGuard interpreter javascript is not available");
	new Function(interpreterJavascript)();
	const botGuardClient = await BotGuardClient.create({
		program: challenge.program,
		globalName: challenge.globalName,
		globalObject: globalThis,
	});
	const webPoSignalOutput: WebPoSignalOutput = [];
	const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });
	const response = await fetch(buildURL("GenerateIT", true), {
		method: "POST",
		headers: getHeaders(),
		body: JSON.stringify([requestKey, botguardResponse]),
		signal,
	});
	if (!response.ok) throw new Error(`GenerateIT failed: HTTP ${response.status}`);
	const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = (await response.json()) as [
		string,
		number,
		number,
		string,
	];
	if (!integrityToken) throw new Error("GenerateIT returned an empty integrity token");
	const webPoMinter = await WebPoMinter.create(
		{ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
		webPoSignalOutput,
	);
	return webPoMinter.mintAsWebsafeString(contentBinding);
}

export async function createSabrInnertube(): Promise<Innertube> {
	return Innertube.create({ cache: new UniversalCache(true) });
}

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
	if (clientName === undefined) throw new Error(`Unknown InnerTube client: ${innertube.session.context.client.clientName}`);
	return { clientName: parseInt(String(clientName), 10), clientVersion: innertube.session.context.client.clientVersion };
}

async function safeCancelStream(stream: ReadableStream<Uint8Array> | undefined, reason?: unknown): Promise<void> {
	if (!stream) return;
	try {
		await stream.cancel(reason);
	} catch {}
}

function safeAbortSabr(sabr: SabrStream): void {
	try {
		sabr.abort();
	} catch {}
}

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
	let sabr: SabrStream | undefined;
	let reloadHandler: ((reloadPlaybackContext: ReloadPlaybackContext) => void) | undefined;
	try {
		if (!videoId) throw new Error("videoId is required");
		const poToken = await generatePoToken(videoId, signal);
		throwIfAborted();
		const videoInfo = await makePlayerRequest(innertube, videoId);
		throwIfAborted();
		if (videoInfo.playability_status?.status && videoInfo.playability_status.status !== "OK")
			throw new Error(
				`Video is not playable: ${videoInfo.playability_status.status} (${videoInfo.playability_status.reason ?? "no reason given"})`,
			);
		const title = videoInfo.video_details?.title ?? videoInfo.basic_info?.title ?? videoId;
		const streamingUrl = videoInfo.streaming_data?.server_abr_streaming_url;
		if (!streamingUrl)
			throw new Error("This video has no SABR streaming URL. YouTube may have returned a legacy/non-SABR response.");
		const serverAbrStreamingUrl = await innertube.session.player?.decipher(streamingUrl);
		if (!serverAbrStreamingUrl) throw new Error("Could not decipher SABR streaming URL");
		const ustreamerConfig =
			videoInfo.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
		if (!ustreamerConfig) throw new Error("Could not find video_playback_ustreamer_config");
		const adaptiveFormats = videoInfo.streaming_data?.adaptive_formats ?? [];
		if (!adaptiveFormats.length) throw new Error("Player response contains no adaptive formats");
		const formats: SabrFormat[] = adaptiveFormats.map((format: any) => buildSabrFormat(format));
		sabr = new SabrStream({
			formats,
			serverAbrStreamingUrl,
			videoPlaybackUstreamerConfig: ustreamerConfig,
			poToken,
			clientInfo: getClientInfo(innertube),
		});
		reloadHandler = async (reloadPlaybackContext: ReloadPlaybackContext) => {
			try {
				throwIfAborted();
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
				sabr?.setPoToken(refreshedPoToken);
				if (newUrl) sabr?.setStreamingURL(newUrl);
				if (newConfig) sabr?.setUstreamerConfig(newConfig);
				if (newFormats.length) sabr?.setServerAbrFormats(newFormats);
			} catch (error) {
				if (!signal?.aborted) console.error("[SABR] Failed to reload player response:", error);
			}
		};
		sabr.on("reloadPlayerResponse", reloadHandler);
		const result = await sabr.start({
			...options,
			enabledTrackTypes: options?.enabledTrackTypes ?? EnabledTrackTypes.AUDIO_ONLY,
			audioQuality: options?.audioQuality ?? "medium",
			preferWebM: options?.preferWebM ?? true,
			preferOpus: options?.preferOpus ?? true,
		});
		throwIfAborted();
		if (!result.audioStream) throw new Error("SABR did not return an audio stream");
		const audioFormat = result.selectedFormats?.audioFormat;
		if (!audioFormat) throw new Error("SABR did not select an audio format");
		const reader = result.audioStream.getReader();
		const sabrSession = sabr;
		const nodeStream = Readable.from(
			(async function* () {
				try {
					while (true) {
						throwIfAborted();
						const { done, value } = await reader.read();
						if (done) break;
						yield Buffer.from(value);
					}
				} finally {
					try {
						await reader.cancel();
					} catch {}
					try {
						reader.releaseLock();
					} catch {}
					safeAbortSabr(sabrSession);
					void safeCancelStream(result.videoStream, "Video track is not used");
					if (reloadHandler) sabrSession.off("reloadPlayerResponse", reloadHandler);
				}
			})(),
		);
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
		if (sabr) {
			if (reloadHandler) sabr.off("reloadPlayerResponse", reloadHandler);
			safeAbortSabr(sabr);
		}
		throw new Error(`SABR stream creation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/**
 * Creates a single downloadable video stream containing both SABR video and audio.
 * SABR exposes the tracks separately, so ffmpeg is used here only to mux them.
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
	let sabr: SabrStream | undefined;
	let reloadHandler: ((ctx: ReloadPlaybackContext) => void) | undefined;
	try {
		const poToken = await generatePoToken(videoId, signal);
		throwIfAborted();
		const videoInfo = await makePlayerRequest(innertube, videoId);
		throwIfAborted();
		if (videoInfo.playability_status?.status && videoInfo.playability_status.status !== "OK")
			throw new Error(`Video is not playable: ${videoInfo.playability_status.status}`);
		const title = videoInfo.video_details?.title ?? videoInfo.basic_info?.title ?? videoId;
		const streamingUrl = videoInfo.streaming_data?.server_abr_streaming_url;
		if (!streamingUrl) throw new Error("This video has no SABR streaming URL");
		const serverAbrStreamingUrl = await innertube.session.player?.decipher(streamingUrl);
		if (!serverAbrStreamingUrl) throw new Error("Could not decipher SABR streaming URL");
		const ustreamerConfig =
			videoInfo.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
		if (!ustreamerConfig) throw new Error("Could not find video_playback_ustreamer_config");
		const adaptiveFormats = videoInfo.streaming_data?.adaptive_formats ?? [];
		if (!adaptiveFormats.length) throw new Error("Player response contains no adaptive formats");
		const formats: SabrFormat[] = adaptiveFormats.map((format: any) => buildSabrFormat(format));
		sabr = new SabrStream({
			formats,
			serverAbrStreamingUrl,
			videoPlaybackUstreamerConfig: ustreamerConfig,
			poToken,
			clientInfo: getClientInfo(innertube),
		});
		reloadHandler = async (ctx: ReloadPlaybackContext) => {
			try {
				throwIfAborted();
				const [reloaded, token] = await Promise.all([
					makePlayerRequest(innertube, videoId, ctx),
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
				sabr?.setPoToken(token);
				if (newUrl) sabr?.setStreamingURL(newUrl);
				if (newConfig) sabr?.setUstreamerConfig(newConfig);
				if (newFormats.length) sabr?.setServerAbrFormats(newFormats);
			} catch (error) {
				if (!signal?.aborted) console.error("[SABR] Video reload failed:", error);
			}
		};
		sabr.on("reloadPlayerResponse", reloadHandler);
		const result = await sabr.start({
			...options,
			enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
			preferWebM: options?.preferWebM ?? false,
			preferOpus: options?.preferOpus ?? false,
		});
		throwIfAborted();
		if (!result.videoStream) throw new Error("SABR did not return a video stream");
		if (!result.audioStream) throw new Error("SABR did not return an audio stream");
		const videoFormat = result.selectedFormats?.videoFormat;
		const audioFormat = result.selectedFormats?.audioFormat;
		if (!videoFormat) throw new Error("SABR did not select a video format");
		if (!audioFormat) throw new Error("SABR did not select an audio format");

		const { spawn } = await import("node:child_process");
		const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
		const videoMime = String(videoFormat.mimeType ?? "video/mp4").toLowerCase().split(";")[0];
		const audioMime = String(audioFormat.mimeType ?? "audio/mp4").toLowerCase().split(";")[0];
		const inputFormat = (mimeType: string) => mimeType === "video/webm" || mimeType === "audio/webm" ? "webm" : "mp4";
		const videoInputFormat = inputFormat(videoMime);
		const audioInputFormat = inputFormat(audioMime);
		const mp4Compatible =
			/^(video\/mp4|video\/quicktime)$/.test(videoMime) && audioMime === "audio/mp4";
		const outputFormat = mp4Compatible ? "mp4" : videoMime === "video/webm" && audioMime === "audio/webm" ? "webm" : "matroska";
		const outputMimeType = outputFormat === "mp4" ? "video/mp4" : outputFormat === "webm" ? "video/webm" : "video/x-matroska";
		const outputArgs =
			outputFormat === "mp4"
				? ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]
			: ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-f", outputFormat, "pipe:1"];
		const ffmpeg = spawn(
			ffmpegPath,
			["-hide_banner", "-loglevel", "error", "-f", videoInputFormat, "-i", "pipe:3", "-f", audioInputFormat, "-i", "pipe:4", ...outputArgs],
			{ stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
		);
		const videoInput = ffmpeg.stdio[3] as NodeJS.WritableStream;
		const audioInput = ffmpeg.stdio[4] as NodeJS.WritableStream;
		if (!ffmpeg.stdout || !videoInput || !audioInput) throw new Error("Could not create ffmpeg pipes");

		const videoSource = Readable.fromWeb(result.videoStream as any);
		const audioSource = Readable.fromWeb(result.audioStream as any);
		const cleanup = () => {
			try { videoSource.destroy(); } catch {}
			try { audioSource.destroy(); } catch {}
			try { videoInput.destroy(); } catch {}
			try { audioInput.destroy(); } catch {}
			if (ffmpeg.exitCode === null) {
				try { ffmpeg.kill("SIGKILL"); } catch {}
			}
			safeAbortSabr(sabrSession);
			if (reloadHandler) sabrSession.off("reloadPlayerResponse", reloadHandler);
		};
		const sabrSession = sabr;
		let ffmpegError: Error | undefined;
		ffmpeg.once("error", (error) => {
			ffmpegError = error;
		});
		videoSource.on("error", (error) => ffmpeg.stdin?.destroy(error));
		audioSource.on("error", (error) => ffmpeg.stdin?.destroy(error));
		videoSource.pipe(videoInput as any);
		audioSource.pipe(audioInput as any);
		videoSource.once("end", () => videoInput.end());
		audioSource.once("end", () => audioInput.end());

		const nodeStream = Readable.from(
			(async function* () {
				try {
					for await (const chunk of ffmpeg.stdout!) {
						throwIfAborted();
						yield Buffer.from(chunk);
					}
					await new Promise<void>((resolve, reject) => {
						if (ffmpegError) return reject(ffmpegError);
						if (ffmpeg.exitCode !== null) return ffmpeg.exitCode === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${ffmpeg.exitCode}`));
						ffmpeg.once("close", (code) => code === 0 ? resolve() : reject(ffmpegError ?? new Error(`ffmpeg exited with code ${code}`)));
					});
				} finally {
					cleanup();
				}
			})(),
		);
		nodeStream.on("close", cleanup);
		return {
			title,
			stream: nodeStream,
			format: {
				mimeType: outputMimeType,
				itag: Number(videoFormat.itag ?? 0),
				contentLength: Number(videoFormat.contentLength ?? 0) + Number(audioFormat.contentLength ?? 0),
			},
		};
	} catch (error) {
		if (sabr) {
			if (reloadHandler) sabr.off("reloadPlayerResponse", reloadHandler);
			safeAbortSabr(sabr);
		}
		throw new Error(`SABR video stream creation failed: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

export function createOutputStream(videoTitle: string, mimeType: string): OutputStream {
	const sanitizedTitle = sanitizeFileName(videoTitle) || "audio";
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