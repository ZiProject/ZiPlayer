import { createWriteStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Import type declarations
import type { SabrPlaybackOptions, StreamResult } from "../types/googlevideo";

// Re-export types for external use
export type { StreamResult, SabrPlaybackOptions };

export interface OutputStream {
	stream: NodeJS.WritableStream;
	filePath: string;
}

/**
 * Creates a sabr stream for YouTube video download
 */
export async function createSabrStream(videoId: string, options: SabrPlaybackOptions): Promise<{ streamResults: StreamResult }> {
	try {
		// Dynamic import to avoid build-time errors
		const sabrModule = require("googlevideo/sabr-stream") as any;
		const createSabrStreamImpl = sabrModule.createSabrStream;

		const streamResults = await createSabrStreamImpl(videoId, options);

		return { streamResults };
	} catch (error) {
		// Fallback implementation if sabr download is not available
		throw new Error(`Sabr download not available: ${error}`);
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
 * Creates a stream sink for piping data with progress tracking
 */
export function createStreamSink(format: any, outputStream: NodeJS.WritableStream, progressBar: any) {
	return new WritableStream({
		start() {
			// Initialize progress tracking
		},
		write(chunk) {
			outputStream.write(chunk);
			if (progressBar) {
				progressBar.increment(chunk.length);
			}
		},
		close() {
			outputStream.end();
		},
	});
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
 * Default sabr playback options
 */
export const DEFAULT_SABR_OPTIONS: SabrPlaybackOptions = {
	preferWebM: true,
	preferOpus: true,
	videoQuality: "720p",
	audioQuality: "AUDIO_QUALITY_MEDIUM",
	enabledTrackTypes: "VIDEO_AND_AUDIO",
};
