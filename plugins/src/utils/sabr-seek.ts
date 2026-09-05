import { Readable } from "node:stream";
import { Constants, type Innertube } from "youtubei.js";
import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import type { SabrFormat } from "googlevideo/shared-types";
import type { ReloadPlaybackContext } from "googlevideo/protos";
import { mintYouTubePoToken } from "./youtube-botguard.js";

const WEBM_CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

function findCluster(buffer: Buffer): number {
	return buffer.indexOf(WEBM_CLUSTER);
}

/**
 * Reads the WebM initialization segment from a normal SABR stream.
 * A seeked SABR request can begin directly with a media Cluster, which is not
 * decodable by itself. The bytes before the first Cluster are the EBML/WebM
 * initialization segment and must be prepended to the seeked media.
 */
async function readWebmInitialization(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal?: AbortSignal,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;

	while (total < 1024 * 1024) {
		if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
		const { done, value } = await reader.read();
		if (done) break;

		const chunk = Buffer.from(value);
		chunks.push(chunk);
		total += chunk.length;

		const data = Buffer.concat(chunks, total);
		const clusterOffset = findCluster(data);
		if (clusterOffset >= 0) {
			if (clusterOffset === 0) throw new Error("SABR bootstrap stream did not contain a WebM initialization segment");
			return data.subarray(0, clusterOffset);
		}
	}

	throw new Error("Could not locate the WebM Cluster boundary in SABR bootstrap stream");
}

function createSabrConfig(
	formats: SabrFormat[],
	serverAbrStreamingUrl: string,
	ustreamerConfig: string,
	poToken: string,
	innertube: Innertube,
) {
	const clientName = Constants.CLIENT_NAME_IDS[
		innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS
	];
	if (clientName === undefined) throw new Error("Unknown InnerTube client");

	return {
		formats,
		serverAbrStreamingUrl,
		videoPlaybackUstreamerConfig: ustreamerConfig,
		poToken,
		clientInfo: {
			clientName: parseInt(String(clientName), 10),
			clientVersion: innertube.session.context.client.clientVersion,
		},
	};
}

/**
 * Creates a fresh SABR audio stream whose first SABR request starts at `position`.
 *
 * googlevideo 4.1.x does not expose a public seek API on SabrStream. We therefore
 * override the first request's clientAbrState.playerTimeMs so YouTube returns
 * media around the requested position. A seeked WebM response may omit the
 * initialization bytes, so for non-zero seeks we bootstrap the WebM init segment
 * from a short normal SABR request and prepend it to the seeked media.
 */
export async function createSabrSeekStream(
	videoId: string,
	innertube: Innertube,
	position: number,
	signal?: AbortSignal,
): Promise<Readable> {
	if (!videoId) throw new Error("videoId is required");
	if (!Number.isFinite(position) || position < 0) throw new Error("Invalid SABR seek position");
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");

	const throwIfAborted = () => {
		if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	};

	let sabr: SabrStream | undefined;
	let reloadHandler: ((context: ReloadPlaybackContext) => void) | undefined;

	try {
		const poToken = await mintYouTubePoToken(videoId, signal);
		throwIfAborted();

		const videoInfo: any = await innertube.getBasicInfo(videoId, { client: "YTMUSIC" });
		throwIfAborted();

		if (videoInfo.playability_status?.status && videoInfo.playability_status.status !== "OK") {
			throw new Error(
				`Video is not playable: ${videoInfo.playability_status.status} (${videoInfo.playability_status.reason ?? "no reason given"})`,
			);
		}

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
		const sabrConfig = createSabrConfig(formats, serverAbrStreamingUrl, ustreamerConfig, poToken, innertube);

		let initializationSegment: Buffer | undefined;

		// A non-zero seek can return a media Cluster without the WebM EBML/Tracks
		// initialization segment. Fetch that tiny prefix once from a normal stream.
		if (position > 0) {
			const bootstrapSabr = new SabrStream(sabrConfig);
			const bootstrapResult = await bootstrapSabr.start({
				enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
				audioQuality: "medium",
				preferWebM: true,
				preferOpus: true,
			});
			if (!bootstrapResult.audioStream) throw new Error("SABR bootstrap did not return an audio stream");

			const bootstrapReader = bootstrapResult.audioStream.getReader();
			try {
				initializationSegment = await readWebmInitialization(bootstrapReader, signal);
			} finally {
				try {
					await bootstrapReader.cancel();
				} catch {}
				try {
					bootstrapReader.releaseLock();
				} catch {}
				try {
					await bootstrapResult.videoStream.cancel("Video track is not used");
				} catch {}
				bootstrapSabr.abort();
			}
			throwIfAborted();
		}

		sabr = new SabrStream(sabrConfig);

		reloadHandler = async (reloadContext: ReloadPlaybackContext) => {
			try {
				throwIfAborted();
				const reloaded: any = await innertube.getBasicInfo(videoId, { client: "YTMUSIC" });
				throwIfAborted();

				const newUrl = reloaded.streaming_data?.server_abr_streaming_url
					? await innertube.session.player?.decipher(reloaded.streaming_data.server_abr_streaming_url)
					: undefined;
				const newConfig =
					reloaded.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
				const newFormats: SabrFormat[] = (reloaded.streaming_data?.adaptive_formats ?? []).map((format: any) =>
					buildSabrFormat(format),
				);

				sabr?.setPoToken(await mintYouTubePoToken(videoId, signal));
				if (newUrl) sabr?.setStreamingURL(newUrl);
				if (newConfig) sabr?.setUstreamerConfig(newConfig);
				if (newFormats.length) sabr?.setServerAbrFormats(newFormats);
			} catch (error) {
				if (!signal?.aborted) console.debug("[SABR seek] Player response reload failed:", error);
			}
		};
		sabr.on("reloadPlayerResponse", reloadHandler);

		const sabrInstance = sabr as any;
		const originalBuildRequestBody = sabrInstance.buildRequestBody?.bind(sabr);
		if (typeof originalBuildRequestBody !== "function") {
			throw new Error("googlevideo SabrStream does not expose its request builder");
		}

		let firstRequest = true;
		sabrInstance.buildRequestBody = (abrState: Record<string, any>, ...args: any[]) => {
			if (firstRequest) {
				firstRequest = false;
				abrState.playerTimeMs = String(Math.max(0, Math.floor(position)));
			}
			return originalBuildRequestBody(abrState, ...args);
		};

		const result = await sabr.start({
			enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
			audioQuality: "medium",
			preferWebM: true,
			preferOpus: true,
		});
		throwIfAborted();

		if (!result.audioStream) throw new Error("SABR did not return an audio stream");

		const reader = result.audioStream.getReader();
		const sabrSession = sabr;
		return Readable.from(
			(async function* () {
				try {
					let first = true;
					let pending: Buffer[] = [];
					let pendingLength = 0;

					while (true) {
						throwIfAborted();
						const { done, value } = await reader.read();
						if (done) break;

						const chunk = Buffer.from(value);
						if (!first || !initializationSegment) {
							yield chunk;
							first = false;
							continue;
						}

						pending.push(chunk);
						pendingLength += chunk.length;
						const buffered = Buffer.concat(pending, pendingLength);
						const clusterOffset = findCluster(buffered);

						if (clusterOffset < 0) continue;

						first = false;
						if (clusterOffset === 0) {
							yield initializationSegment;
							yield buffered;
						} else {
							// The target response already supplied its own initialization segment.
							yield buffered;
						}

						pending = [];
						pendingLength = 0;
					}

					if (pendingLength) {
						if (initializationSegment) yield initializationSegment;
						for (const chunk of pending) yield chunk;
					}
				} finally {
					try {
						await reader.cancel();
					} catch {}
					try {
						reader.releaseLock();
					} catch {}
					try {
						sabrSession.abort();
					} catch {}
					try {
						sabrSession.off("reloadPlayerResponse", reloadHandler!);
					} catch {}
					try {
						await result.videoStream.cancel("Video track is not used");
					} catch {}
				}
			})(),
		);
	} catch (error) {
		if (sabr) {
			if (reloadHandler) sabr.off("reloadPlayerResponse", reloadHandler);
			try {
				sabr.abort();
			} catch {}
		}
		throw new Error(`SABR seek failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
