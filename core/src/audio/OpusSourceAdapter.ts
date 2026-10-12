import { Readable, Transform } from "node:stream";
import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";
import prism from "prism-media";

/**
 * Parses the Opus Table of Contents (TOC) byte (RFC 6716 Section 3.1)
 * to calculate the exact packet duration in milliseconds.
 */
export function getOpusPacketDurationMs(packet: Uint8Array | Buffer): number {
	if (!packet || packet.length === 0) return 0;
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
