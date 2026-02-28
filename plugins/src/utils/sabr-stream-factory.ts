import { createWriteStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Readable } from "stream";
import { Constants, YTNodes, Platform } from "youtubei.js";
import type Innertube from "youtubei.js";

import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat } from "googlevideo/utils";

import { BG } from "bgutils-js";
import { JSDOM } from "jsdom";
import { webStreamToNodeStream } from "./stream-converter";

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

export interface SabrPlaybackOptions {
	preferWebM?: boolean;
	preferOpus?: boolean;
	videoQuality?: string;
	audioQuality?: string;
	enabledTrackTypes?: any;
}
/**
 * Generates a web PoToken for YouTube authentication
 * This is required for accessing restricted video content
 */
async function generateWebPoToken(contentBinding: string): Promise<{
	visitorData: string;
	placeholderPoToken: string;
	poToken: string;
}> {
	try {
		const requestKey = "O43z0dpjhgX20SCx4KAo";

		if (!contentBinding) throw new Error("Could not get visitor data");

		const dom = new JSDOM();

		Object.assign(globalThis, {
			window: dom.window,
			document: dom.window.document,
		});

		const bgConfig = {
			fetch: (input: any, init: any) => fetch(input, init),
			globalObj: globalThis,
			identifier: contentBinding,
			requestKey,
		};

		const bgChallenge = await BG.Challenge.create(bgConfig);

		if (!bgChallenge) throw new Error("Could not get challenge");

		const interpreterJavascript = bgChallenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;

		if (interpreterJavascript) {
			new Function(interpreterJavascript)();
		} else throw new Error("Could not load VM");

		const poTokenResult = await BG.PoToken.generate({
			program: bgChallenge.program,
			globalName: bgChallenge.globalName,
			bgConfig,
		});

		const placeholderPoToken = BG.PoToken.generatePlaceholder(contentBinding);

		return {
			visitorData: contentBinding,
			placeholderPoToken,
			poToken: poTokenResult.poToken,
		};
	} catch (error) {
		console.warn("PoToken generation failed, continuing without it:", error);
		return {
			visitorData: contentBinding,
			placeholderPoToken: "",
			poToken: "",
		};
	}
}

/**
 * Makes a proper player request to YouTube API
 */
async function makePlayerRequest(innertube: Innertube, videoId: string, reloadPlaybackContext?: any): Promise<any> {
	const watchEndpoint = new YTNodes.NavigationEndpoint({
		watchEndpoint: { videoId },
	});

	const extraArgs: any = {
		playbackContext: {
			adPlaybackContext: { pyv: true },
			contentPlaybackContext: {
				vis: 0,
				splay: false,
				lactMilliseconds: "-1",
				signatureTimestamp: innertube.session.player?.signature_timestamp,
			},
		},
		contentCheckOk: true,
		racyCheckOk: true,
	};

	if (reloadPlaybackContext) {
		extraArgs.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
	}

	return watchEndpoint.call(innertube.actions, {
		...extraArgs,
		parse: true,
	});
}

/**
 * YouTube VM shim
 * This allows the SABR stream to execute YouTube's custom JavaScript for deciphering signatures and generating tokens
 */
Platform.shim.eval = async (data, env) => {
	const properties = [];

	if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
	if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);

	const code = `${data.output}\nreturn { ${properties.join(", ")} }`;
	return new Function(code)();
};

/**
 * Creates a SABR audio stream for YouTube video download
 * This provides better quality and more reliable streaming than standard methods
 */
export async function createSabrStream(
	videoId: string,
	innertube: Innertube,
	options?: SabrPlaybackOptions,
): Promise<SabrAudioResult> {
	try {
		// Generate PoToken for authentication
		const webPo = await generateWebPoToken(videoId);

		// Make initial player request
		const player = await makePlayerRequest(innertube, videoId);

		const title = player.video_details?.title || "unknown";

		const serverAbrStreamingUrl = await innertube.session.player?.decipher(player.streaming_data?.server_abr_streaming_url);

		const ustreamerConfig =
			player.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

		if (!serverAbrStreamingUrl || !ustreamerConfig) {
			throw new Error("Missing SABR streaming config");
		}

		// const sabrFormats = player.streaming_data?.adaptive_formats.map((f: any) => buildSabrFormat(f)) || [];

		// const sabrFormats =
		// 	player.streaming_data?.adaptive_formats?.reduce((acc: any[], f: any) => {
		// 		if (!!f?.audio_quality) {
		// 			acc.push(buildSabrFormat(f));
		// 		}
		// 		return acc;
		// 	}, []) ?? [];
		const allFormats = player.streaming_data?.adaptive_formats.map((f: any) => buildSabrFormat(f)) || [];
		console.log();

		const sabrFormats = allFormats
			.reduce(
				(acc: any[], f: any) => {
					// Kiểm tra nếu là Audio (có audioQuality)
					if (f.audioQuality) {
						if (!acc[0] || f.bitrate > acc[0].bitrate) {
							acc[0] = f;
						}
					}
					// Ngược lại là Video (thường có width/height hoặc không có audioQuality)
					else if (f.width) {
						if (!acc[1] || f.bitrate < acc[1].bitrate) {
							acc[1] = f;
						}
					}
					return acc;
				},
				[null, null],
			) // [0] là best audio, [1] là worst video
			.filter(Boolean);

		console.log(sabrFormats);

		const sabr = new SabrStream({
			formats: sabrFormats,
			serverAbrStreamingUrl,
			videoPlaybackUstreamerConfig: ustreamerConfig,
			poToken: webPo.poToken,
			clientInfo: {
				clientName: parseInt(
					Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS],
				),
				clientVersion: innertube.session.context.client.clientVersion,
			},
		});

		// Handle player response reload events
		sabr.on("reloadPlayerResponse", async (ctx: any) => {
			try {
				const pr = await makePlayerRequest(innertube, videoId, ctx);

				const url = await innertube.session.player?.decipher(pr.streaming_data?.server_abr_streaming_url);

				const config = pr.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

				if (url && config) {
					sabr.setStreamingURL(url);
					sabr.setUstreamerConfig(config);
				}
			} catch (error) {
				console.error("Failed to reload player response:", error);
			}
		});

		// Start the stream with audio preference
		const mergedOptions = { ...DEFAULT_SABR_OPTIONS, ...options };
		const { audioStream, selectedFormats } = await sabr.start({
			audioQuality: mergedOptions?.audioQuality || "medium",
		});

		// Convert Web Stream to Node.js Readable stream with optimized buffer
		const nodeStream = webStreamToNodeStream(audioStream, 32 * 1024); // 32KB buffer for YouTube streams

		return {
			title,
			stream: nodeStream,
			format: {
				mimeType: selectedFormats.audioFormat.mimeType || "audio/webm",
				itag: selectedFormats.audioFormat.itag || 0,
				contentLength: selectedFormats.audioFormat.contentLength || 0,
			},
		};
	} catch (error) {
		throw new Error(`SABR stream creation failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Creates an output stream for writing downloaded content
 */
export function createOutputStream(videoTitle: string, mimeType: string): OutputStream {
	const sanitizedTitle = videoTitle.replace(/[<>:"/\\|?*]/g, "_").substring(0, 100);
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
 * Sanitizes a filename by removing invalid characters
 */
export function sanitizeFileName(name: string): string {
	return name.replace(/[^\w\d]+/g, "_").slice(0, 128);
}

/**
 * Converts bytes to megabytes
 */
export function bytesToMB(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * Gets file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
	const mimeMap: { [key: string]: string } = {
		"audio/mp4": "m4a",
		"audio/webm": "webm",
		"audio/ogg": "ogg",
		"video/mp4": "mp4",
		"video/webm": "webm",
		"video/ogg": "ogv",
	};

	return mimeMap[mimeType] || "bin";
}

/**
 * Default sabr playback options - optimized for memory usage
 * Using MEDIUM quality and WebM/Opus reduces bandwidth by ~30-40%
 */
export const DEFAULT_SABR_OPTIONS: SabrPlaybackOptions = {
	preferWebM: true, // WebM with Opus is more memory-efficient
	preferOpus: true, // Opus codec = smaller bitrate vs AAC
	videoQuality: "360p", // Lower resolution = less processing
	audioQuality: "medium", // Medium quality balances quality vs bandwidth (~96-128kbps vs 256kbps)
	enabledTrackTypes: "VIDEO_AND_AUDIO",
};
