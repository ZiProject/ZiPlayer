import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";
import { Readable } from "stream";
import axios from "axios";
import { parseBuffer } from "music-metadata";

/**
 * Configuration options for the AttachmentsPlugin.
 */
export interface AttachmentsPluginOptions {
	/** Maximum file size in bytes (default: 25MB) */
	maxFileSize?: number;
	/** Allowed audio file extensions */
	allowedExtensions?: string[];
	/** Whether to enable debug logging */
	debug?: boolean;
}

/**
 * A plugin for handling Discord attachment URLs and local audio files.
 *
 * This plugin provides support for:
 * - Discord attachment URLs (cdn.discordapp.com, media.discordapp.net)
 * - Direct audio file URLs
 * - Local file paths (if accessible)
 * - Various audio formats (mp3, wav, ogg, m4a, flac, etc.)
 * - File size validation
 * - Audio metadata analysis (duration, title, artist, album, etc.)
 * - Stream extraction from URLs
 *
 * @example
 * const attachmentsPlugin = new AttachmentsPlugin({
 *   maxFileSize: 25 * 1024 * 1024, // 25MB
 *   allowedExtensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac']
 * });
 *
 * // Add to PlayerManager
 * const manager = new PlayerManager({
 *   plugins: [attachmentsPlugin]
 * });
 *
 * // Search for attachment content
 * const result = await attachmentsPlugin.search(
 *   "https://cdn.discordapp.com/attachments/123/456/audio.mp3",
 *   "user123"
 * );
 * const stream = await attachmentsPlugin.getStream(result.tracks[0]);
 *
 * @since 1.0.0
 */
export class AttachmentsPlugin extends BasePlugin {
	name = "attachments";
	version = "1.0.0";

	private opts: AttachmentsPluginOptions;
	private readonly defaultAllowedExtensions = ["mp3", "wav", "ogg", "m4a", "flac", "aac", "wma", "opus", "webm"];

	/**
	 * Creates a new AttachmentsPlugin instance.
	 *
	 * @param opts - Configuration options for the attachments plugin
	 * @param opts.maxFileSize - Maximum file size in bytes (default: 25MB)
	 * @param opts.allowedExtensions - Allowed audio file extensions (default: common audio formats)
	 * @param opts.debug - Whether to enable debug logging (default: false)
	 *
	 * @example
	 * // Basic attachments plugin
	 * const attachmentsPlugin = new AttachmentsPlugin();
	 *
	 * // Custom configuration
	 * const customPlugin = new AttachmentsPlugin({
	 *   maxFileSize: 50 * 1024 * 1024, // 50MB
	 *   allowedExtensions: ['mp3', 'wav', 'ogg'],
	 *   debug: true
	 * });
	 */
	constructor(opts?: AttachmentsPluginOptions) {
		super();
		this.opts = {
			maxFileSize: opts?.maxFileSize || 25 * 1024 * 1024, // 25MB default
			allowedExtensions: opts?.allowedExtensions || this.defaultAllowedExtensions,
			debug: opts?.debug || false,
		};
	}

	/**
	 * Determines if this plugin can handle the given query.
	 *
	 * @param query - The URL or file path to check
	 * @returns `true` if the query is a Discord attachment URL or audio file URL, `false` otherwise
	 *
	 * @example
	 * plugin.canHandle("https://cdn.discordapp.com/attachments/123/456/audio.mp3"); // true
	 * plugin.canHandle("https://example.com/song.wav"); // true
	 * plugin.canHandle("youtube.com/watch?v=123"); // false
	 */
	canHandle(query: string): boolean {
		if (!query) return false;

		const q = query.trim();

		// Check if it's a URL
		if (q.startsWith("http://") || q.startsWith("https://")) {
			try {
				const url = new URL(q);

				// Discord attachment URLs
				if (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net") {
					return this.isAudioFile(q);
				}

				// Any other URL - check if it's an audio file
				return this.isAudioFile(q);
			} catch {
				return false;
			}
		}

		// Check if it's a local file path (basic check)
		if (q.includes("/") || q.includes("\\")) {
			return this.isAudioFile(q);
		}

		return false;
	}

	/**
	 * Validates if a URL is a valid Discord attachment URL or audio file URL.
	 *
	 * @param url - The URL to validate
	 * @returns `true` if the URL is valid and points to an audio file, `false` otherwise
	 *
	 * @example
	 * plugin.validate("https://cdn.discordapp.com/attachments/123/456/audio.mp3"); // true
	 * plugin.validate("https://example.com/song.wav"); // true
	 * plugin.validate("https://example.com/image.jpg"); // false
	 */
	validate(url: string): boolean {
		return this.canHandle(url) && this.isAudioFile(url);
	}

	/**
	 * Creates a track from an attachment URL or file path.
	 *
	 * This method handles both Discord attachment URLs and direct audio file URLs.
	 * It extracts metadata from the URL and creates a track that can be played.
	 *
	 * @param query - The attachment URL or file path
	 * @param requestedBy - The user ID who requested the track
	 * @returns A SearchResult containing a single track
	 *
	 * @example
	 * // Discord attachment
	 * const result = await plugin.search(
	 *   "https://cdn.discordapp.com/attachments/123/456/audio.mp3",
	 *   "user123"
	 * );
	 *
	 * // Direct audio file URL
	 * const result2 = await plugin.search(
	 *   "https://example.com/song.wav",
	 *   "user123"
	 * );
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		if (!this.canHandle(query)) {
			return { tracks: [] };
		}

		try {
			const filename = this.extractFilename(query);
			const fileExtension = this.getFileExtension(filename);
			let title = filename || `Audio File (${fileExtension})`;

			// Get file size if it's a URL
			let fileSize = 0;
			let duration = 0;
			let audioMetadata: any = {};

			if (query.startsWith("http://") || query.startsWith("https://")) {
				try {
					const headResponse = await axios.head(query, { timeout: 5000 });
					const contentLength = headResponse.headers["content-length"];
					if (contentLength) {
						fileSize = parseInt(contentLength, 10);

						// Check file size limit
						if (fileSize > this.opts.maxFileSize!) {
							throw new Error(`File too large: ${this.formatBytes(fileSize)} (max: ${this.formatBytes(this.opts.maxFileSize!)})`);
						}
					}
				} catch (error) {
					this.debug("Could not get file size:", error);
				}

				// Analyze audio metadata to get duration and other info
				try {
					const analysisResult = await this.analyzeAudioMetadata(query);
					duration = analysisResult.duration;
					audioMetadata = analysisResult.metadata || {};

					// Use metadata title if available
					if (audioMetadata.title && audioMetadata.title.trim()) {
						const artist = audioMetadata.artist ? ` - ${audioMetadata.artist}` : "";
						const album = audioMetadata.album ? ` (${audioMetadata.album})` : "";
						const finalTitle = `${audioMetadata.title}${artist}${album}`;
						if (finalTitle.trim()) {
							title = finalTitle;
						}
					}
				} catch (error) {
					this.debug("Could not analyze audio metadata:", error);
				}
			}

			const track: Track = {
				id: this.generateTrackId(query),
				title,
				url: query,
				duration,
				requestedBy,
				source: this.name,
				metadata: {
					filename,
					extension: fileExtension,
					fileSize,
					isDiscordAttachment: this.isDiscordAttachment(query),
					...audioMetadata, // Include all audio metadata
				},
			};

			return { tracks: [track] };
		} catch (error) {
			this.debug("Error creating track:", error);
			return { tracks: [] };
		}
	}

	/**
	 * Retrieves the audio stream from an attachment URL or file path.
	 *
	 * This method downloads the audio file from the URL and returns it as a stream.
	 * It handles various audio formats and provides proper error handling.
	 *
	 * @param track - The Track object to get the stream for
	 * @returns A StreamInfo object containing the audio stream
	 * @throws {Error} If the URL is invalid, file is too large, or download fails
	 *
	 * @example
	 * const track = {
	 *   id: "attachment-123",
	 *   title: "audio.mp3",
	 *   url: "https://cdn.discordapp.com/attachments/123/456/audio.mp3",
	 *   ...
	 * };
	 * const streamInfo = await plugin.getStream(track);
	 * console.log(streamInfo.type); // "arbitrary"
	 * console.log(streamInfo.stream); // Readable stream
	 */
	async getStream(track: Track): Promise<StreamInfo> {
		if (track.source !== this.name) {
			throw new Error("Track is not from AttachmentsPlugin");
		}

		const url = track.url;
		if (!url) {
			throw new Error("No URL provided for track");
		}

		try {
			this.debug("Downloading audio from:", url);

			// Download the file
			const response = await axios.get(url, {
				responseType: "stream",
				timeout: 30000, // 30 second timeout
				maxContentLength: this.opts.maxFileSize,
			});

			const stream = response.data as Readable;
			const contentType = response.headers["content-type"] || "";
			const contentLength = response.headers["content-length"];

			this.debug("Download successful:", {
				contentType,
				contentLength: contentLength ? parseInt(contentLength, 10) : "unknown",
			});

			// Determine stream type based on content type or file extension
			const streamType = this.getStreamType(contentType, track.metadata?.extension);

			return {
				stream,
				type: streamType,
				metadata: {
					...track.metadata,
					contentType,
					contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
				},
			};
		} catch (error: any) {
			if (error.code === "ECONNABORTED") {
				throw new Error(`Download timeout for ${url}`);
			}
			if (error.response?.status === 404) {
				throw new Error(`File not found: ${url}`);
			}
			if (error.response?.status === 403) {
				throw new Error(`Access denied: ${url}`);
			}
			if (error.message?.includes("maxContentLength")) {
				throw new Error(`File too large: ${url}`);
			}
			throw new Error(`Failed to download audio: ${error.message || error}`);
		}
	}

	/**
	 * Provides a fallback by attempting to re-download the file.
	 *
	 * @param track - The Track object to get a fallback stream for
	 * @returns A StreamInfo object containing the fallback audio stream
	 * @throws {Error} If fallback download fails
	 */
	async getFallback(track: Track): Promise<StreamInfo> {
		this.debug("Attempting fallback for track:", track.title);
		return await this.getStream(track);
	}

	/**
	 * Checks if a file path or URL is an audio file based on extension.
	 */
	private isAudioFile(path: string): boolean {
		const extension = this.getFileExtension(path);
		return this.opts.allowedExtensions!.includes(extension.toLowerCase());
	}

	/**
	 * Extracts the file extension from a path or URL.
	 */
	private getFileExtension(path: string): string {
		const lastDot = path.lastIndexOf(".");
		if (lastDot === -1) return "";

		const extension = path.slice(lastDot + 1);
		// Remove query parameters if present
		const questionMark = extension.indexOf("?");
		return questionMark === -1 ? extension : extension.slice(0, questionMark);
	}

	/**
	 * Extracts filename from a URL or path.
	 */
	private extractFilename(path: string): string {
		try {
			if (path.startsWith("http://") || path.startsWith("https://")) {
				const url = new URL(path);
				const pathname = url.pathname;
				const lastSlash = pathname.lastIndexOf("/");
				return lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
			}

			// Local file path
			const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
			return lastSlash === -1 ? path : path.slice(lastSlash + 1);
		} catch {
			return "Unknown File";
		}
	}

	/**
	 * Checks if a URL is a Discord attachment URL.
	 */
	private isDiscordAttachment(url: string): boolean {
		try {
			const urlObj = new URL(url);
			return urlObj.hostname === "cdn.discordapp.com" || urlObj.hostname === "media.discordapp.net";
		} catch {
			return false;
		}
	}

	/**
	 * Generates a unique track ID for a given URL.
	 */
	private generateTrackId(url: string): string {
		// Create a hash-like ID from the URL
		const hash = this.simpleHash(url);
		return `attachment-${hash}-${Date.now()}`;
	}

	/**
	 * Simple hash function for generating IDs.
	 */
	private simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash).toString(36);
	}

	/**
	 * Determines the appropriate stream type based on content type and file extension.
	 */
	private getStreamType(contentType: string, extension?: string): StreamInfo["type"] {
		const type = contentType.toLowerCase();
		const ext = extension?.toLowerCase() || "";

		// Check content type first
		if (type.includes("webm") && type.includes("opus")) return "webm/opus";
		if (type.includes("ogg") && type.includes("opus")) return "ogg/opus";

		// Fallback to extension
		if (ext === "webm") return "webm/opus";
		if (ext === "ogg") return "ogg/opus";

		// Default to arbitrary for all other types (mp3, wav, flac, mp4, etc.)
		return "arbitrary";
	}

	/**
	 * Formats bytes into a human-readable string.
	 */
	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 Bytes";
		const k = 1024;
		const sizes = ["Bytes", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
	}

	/**
	 * Analyzes audio metadata to extract duration and other information.
	 *
	 * @param url - The URL to analyze
	 * @returns Promise containing duration in seconds and metadata
	 */
	private async analyzeAudioMetadata(url: string): Promise<{ duration: number; metadata?: any }> {
		try {
			this.debug("Analyzing audio metadata for:", url);

			// Download a small portion of the file to analyze metadata
			const response = await axios.get(url, {
				responseType: "arraybuffer",
				timeout: 10000, // 10 second timeout for metadata analysis
				maxContentLength: 1024 * 1024, // Only download first 1MB for metadata
				headers: {
					Range: "bytes=0-1048575", // Request first 1MB
				},
			});

			const buffer = Buffer.from(response.data);
			const metadata = await parseBuffer(buffer);

			const duration = metadata.format.duration || 0;
			this.debug("Audio metadata analysis result:", {
				duration: `${duration}s`,
				format: metadata.format.container,
				codec: metadata.format.codec,
				bitrate: metadata.format.bitrate,
			});

			return {
				duration: Math.round(duration),
				metadata: {
					format: metadata.format.container,
					codec: metadata.format.codec,
					bitrate: metadata.format.bitrate,
					sampleRate: metadata.format.sampleRate,
					channels: metadata.format.numberOfChannels,
					title: metadata.common.title,
					artist: metadata.common.artist,
					album: metadata.common.album,
					year: metadata.common.year,
					genre: metadata.common.genre,
				},
			};
		} catch (error: any) {
			this.debug("Failed to analyze audio metadata:", error.message);

			// Fallback: try without Range header for some servers that don't support it
			try {
				const response = await axios.get(url, {
					responseType: "arraybuffer",
					timeout: 10000,
					maxContentLength: 1024 * 1024, // 1MB limit
				});

				const buffer = Buffer.from(response.data);
				const metadata = await parseBuffer(buffer);

				const duration = metadata.format.duration || 0;
				this.debug("Audio metadata analysis (fallback) result:", {
					duration: `${duration}s`,
					format: metadata.format.container,
				});

				return {
					duration: Math.round(duration),
					metadata: {
						format: metadata.format.container,
						codec: metadata.format.codec,
						bitrate: metadata.format.bitrate,
					},
				};
			} catch (fallbackError: any) {
				this.debug("Fallback metadata analysis also failed:", fallbackError.message);
				return { duration: 0 };
			}
		}
	}

	/**
	 * Debug logging helper.
	 */
	private debug(message: string, ...args: any[]): void {
		if (this.opts.debug) {
			console.log(`[AttachmentsPlugin] ${message}`, ...args);
		}
	}
}
