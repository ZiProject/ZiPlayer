import { Readable, Transform } from "node:stream";
import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";
import prism from "prism-media";

/**
 * Validates the RFC 6716 Opus packet framing structure:
 * - Checks length bounds and TOC byte
 * - Validates Code 0 (1 frame), Code 1 (2 equal-sized frames),
 *   Code 2 (2 different-sized frames with encoded length),
 *   and Code 3 (arbitrary frames with CBR/VBR/padding framing).
 */
export function validateOpusPacketFraming(packet: Uint8Array | Buffer): boolean {
	if (!packet || packet.length < 1) return false;
	const toc = packet[0];
	const c = toc & 0x03;

	switch (c) {
		case 0: {
			// Code 0: 1 frame. The rest of the packet is the frame payload.
			return true;
		}
		case 1: {
			// Code 1: 2 frames of equal compressed size.
			// The remaining bytes must be evenly divisible by 2.
			const payloadLength = packet.length - 1;
			return payloadLength % 2 === 0;
		}
		case 2: {
			// Code 2: 2 frames of different compressed sizes.
			// Next 1 or 2 bytes encode the size of the first frame (RFC 6716 Section 3.2.1).
			if (packet.length < 2) return false;
			let offset = 1;
			const b1 = packet[offset++];
			let len1: number;
			if (b1 <= 251) {
				len1 = b1;
			} else {
				if (offset >= packet.length) return false;
				const b2 = packet[offset++];
				len1 = b2 * 4 + b1;
			}
			return offset + len1 <= packet.length;
		}
		case 3: {
			// Code 3: Arbitrary number of frames.
			if (packet.length < 2) return false;
			const frameByte = packet[1];
			const isVbr = (frameByte & 0x80) !== 0;
			const hasPadding = (frameByte & 0x40) !== 0;
			const frameCount = frameByte & 0x3f;
			if (frameCount === 0 || frameCount > 48) return false;

			let offset = 2;
			let paddingLen = 0;
			if (hasPadding) {
				let padByte = 255;
				while (padByte === 255) {
					if (offset >= packet.length) return false;
					padByte = packet[offset++];
					paddingLen += padByte === 255 ? 254 : padByte;
				}
			}

			const availablePayload = packet.length - offset - paddingLen;
			if (availablePayload < 0) return false;

			if (!isVbr) {
				// CBR: All frameCount frames have equal size
				return availablePayload % frameCount === 0;
			}

			// VBR: First frameCount - 1 frames have their lengths encoded
			let sumLengths = 0;
			for (let i = 0; i < frameCount - 1; i++) {
				if (offset >= packet.length - paddingLen) return false;
				const b1 = packet[offset++];
				let frameLen: number;
				if (b1 <= 251) {
					frameLen = b1;
				} else {
					if (offset >= packet.length - paddingLen) return false;
					const b2 = packet[offset++];
					frameLen = b2 * 4 + b1;
				}
				sumLengths += frameLen;
			}
			return sumLengths <= packet.length - offset - paddingLen;
		}
		default:
			return false;
	}
}

/**
 * Parses the Opus Table of Contents (TOC) byte (RFC 6716 Section 3.1)
 * to calculate the exact packet duration in milliseconds.
 */
export function getOpusPacketDurationMs(packet: Uint8Array | Buffer): number {
	if (!packet || packet.length === 0) return 0;
	if (!validateOpusPacketFraming(packet)) return 0;
	const toc = packet[0];
	const config = (toc >> 3) & 0x1f;
	const c = toc & 0x03;

	let frameDurationMs: number;
	switch (config) {
		case 0:
		case 4:
		case 8:
		case 12:
		case 14:
			frameDurationMs = 10;
			break;
		case 1:
		case 5:
		case 9:
		case 13:
		case 15:
			frameDurationMs = 20;
			break;
		case 2:
		case 6:
		case 10:
			frameDurationMs = 40;
			break;
		case 3:
		case 7:
		case 11:
			frameDurationMs = 60;
			break;
		case 16:
		case 20:
		case 24:
		case 28:
			frameDurationMs = 2.5;
			break;
		case 17:
		case 21:
		case 25:
		case 29:
			frameDurationMs = 5;
			break;
		case 18:
		case 22:
		case 26:
		case 30:
			frameDurationMs = 10;
			break;
		case 19:
		case 23:
		case 27:
		case 31:
		default:
			frameDurationMs = 20;
			break;
	}

	let frameCount: number;
	switch (c) {
		case 0:
			frameCount = 1;
			break;
		case 1:
		case 2:
			frameCount = 2;
			break;
		case 3:
			if (packet.length < 2) return 0;
			frameCount = packet[1] & 0x3f;
			if (frameCount === 0 || frameCount > 48) return 0;
			break;
		default:
			frameCount = 1;
			break;
	}

	const totalDurationMs = frameDurationMs * frameCount;
	if (totalDurationMs <= 0 || totalDurationMs > 120) return 0;
	return totalDurationMs;
}

/**
 * Validates whether an Opus packet matches the required duration (default 20ms).
 */
export function validateOpusPacketDuration(packet: Uint8Array | Buffer, expectedDurationMs = 20): boolean {
	const duration = getOpusPacketDurationMs(packet);
	if (duration <= 0) return false;
	return Math.abs(duration - expectedDurationMs) < 0.001;
}

export interface CreateOpusAudioResourceOptions {
	metadata?: unknown;
	silencePaddingFrames?: number;
	validateDuration?: boolean;
	expectedDurationMs?: number;
}

/**
 * Creates an AudioResource with StreamType.Opus from an object-mode Readable or Buffer array.
 *
 * Guarantees zero FFmpeg subprocesses and zero transformers:
 * The Opus packets flow directly:
 * Readable<Buffer> -> AudioResource(StreamType.Opus) -> AudioPlayer -> subscribers
 */
export function createOpusAudioResource(
	source: Readable | Buffer[] | Iterable<Buffer>,
	options: CreateOpusAudioResourceOptions = {},
): AudioResource {
	let stream: Readable;
	const validateDuration = options.validateDuration ?? true;
	const expectedDurationMs = options.expectedDurationMs ?? 20;

	if (Array.isArray(source) || (typeof (source as any)?.[Symbol.iterator] === "function" && !(source instanceof Readable))) {
		const packets = Array.from(source as Iterable<Buffer>);
		let index = 0;
		stream = new Readable({
			objectMode: true,
			read() {
				if (index >= packets.length) {
					this.push(null);
					return;
				}
				const packet = packets[index++];
				if (!packet || !(packet instanceof Uint8Array || Buffer.isBuffer(packet)) || packet.length === 0) {
					this.destroy(new Error("Invalid Opus packet: packet must be a non-empty Buffer or Uint8Array"));
					return;
				}
				if (validateDuration && !validateOpusPacketDuration(packet, expectedDurationMs)) {
					const actual = getOpusPacketDurationMs(packet);
					this.destroy(new Error(`Incompatible Opus packet duration: expected ${expectedDurationMs}ms, got ${actual}ms`));
					return;
				}
				this.push(packet);
			},
		});
	} else if (source instanceof Readable) {
		if (!source.readableObjectMode) {
			throw new TypeError(
				"Opus stream must be an object-mode Readable emitting discrete Opus packets. Raw byte streams do not guarantee packet boundaries; use demuxOggOpusToPackets() or demuxWebmOpusToPackets() to demux container streams first.",
			);
		}
		if (validateDuration) {
			const validator = new Transform({
				objectMode: true,
				transform(chunk, _encoding, callback) {
					if (!chunk || !(chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) || chunk.length === 0) {
						callback(new Error("Invalid Opus packet: packet must be a non-empty Buffer or Uint8Array"));
						return;
					}
					if (!validateOpusPacketDuration(chunk, expectedDurationMs)) {
						const actual = getOpusPacketDurationMs(chunk);
						callback(new Error(`Incompatible Opus packet duration: expected ${expectedDurationMs}ms, got ${actual}ms`));
						return;
					}
					callback(null, chunk);
				},
			});
			source.on("error", (err) => validator.destroy(err));
			stream = source.pipe(validator);
		} else {
			stream = source;
		}
	} else {
		throw new TypeError("source must be a Readable stream or an iterable of Buffer packets");
	}

	return createAudioResource(stream, {
		inputType: StreamType.Opus,
		metadata: options.metadata ?? null,
		silencePaddingFrames: options.silencePaddingFrames ?? 5,
	});
}

/**
 * Demuxes an Ogg Opus stream into raw Opus packets using prism-media's in-process demuxer.
 * Zero FFmpeg processes spawned.
 */
export function demuxOggOpusToPackets(stream: Readable): Readable {
	const demuxer = new prism.opus.OggDemuxer();
	stream.on("error", (err) => demuxer.destroy(err));
	return stream.pipe(demuxer);
}

export function demuxWebmOpusToPackets(stream: Readable): Readable {
	const demuxer = new prism.opus.WebmDemuxer();
	stream.on("error", (err) => demuxer.destroy(err));
	return stream.pipe(demuxer);
}
