"use strict";

/** Builds a 16-bit PCM WAV header for `dataBytes` bytes of interleaved samples. */
function wavHeader({ dataBytes, sampleRate, channels }) {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataBytes, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * channels * 2, 28);
	header.writeUInt16LE(channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataBytes, 40);
	return header;
}

function sineSamples({ startFrame, frames, sampleRate, channels, amplitude, frequency }) {
	const body = Buffer.alloc(frames * channels * 2);
	for (let i = 0; i < frames; i++) {
		const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * (startFrame + i)) / sampleRate));
		for (let c = 0; c < channels; c++) body.writeInt16LE(value, (i * channels + c) * 2);
	}
	return body;
}

/** A complete in-memory sine WAV file. */
function makeWav({ seconds = 0.5, sampleRate = 44100, channels = 1, amplitude = 0.5, frequency = 440 } = {}) {
	const frames = Math.round(seconds * sampleRate);
	const body = sineSamples({ startFrame: 0, frames, sampleRate, channels, amplitude, frequency });
	return Buffer.concat([wavHeader({ dataBytes: body.length, sampleRate, channels }), body]);
}

/**
 * Streams a sine WAV in `chunkBytes` pieces without holding the whole file in memory.
 * `stats.pulled` counts chunks the consumer asked for, `stats.returned` becomes true once the
 * generator is finalized, `hangAfter` stalls the source forever and `errorAfter` makes it throw.
 */
function wavSource({
	seconds,
	sampleRate = 44100,
	channels = 1,
	amplitude = 0.5,
	frequency = 440,
	chunkBytes = 16384,
	stats = {},
	hangAfter,
	errorAfter,
}) {
	const totalFrames = Math.round(seconds * sampleRate);
	const framesPerChunk = Math.max(1, Math.floor(chunkBytes / (channels * 2)));
	stats.pulled = 0;
	stats.returned = false;
	return (async function* () {
		try {
			yield wavHeader({ dataBytes: totalFrames * channels * 2, sampleRate, channels });
			for (let frame = 0; frame < totalFrames; ) {
				if (hangAfter != null && stats.pulled >= hangAfter) await new Promise(() => {});
				if (errorAfter != null && stats.pulled >= errorAfter) throw new Error("ECONNRESET");
				const frames = Math.min(framesPerChunk, totalFrames - frame);
				const chunk = sineSamples({ startFrame: frame, frames, sampleRate, channels, amplitude, frequency });
				frame += frames;
				stats.pulled++;
				yield chunk;
			}
		} finally {
			stats.returned = true;
		}
	})();
}

/** Decodes interleaved s16le PCM into per-channel Float32 arrays and basic waveform measurements. */
function analyzePcm16(buffer, { sampleRate, channels }) {
	const frames = Math.floor(buffer.length / (channels * 2));
	const left = new Float32Array(frames);
	const right = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		left[i] = buffer.readInt16LE(i * channels * 2) / 32768;
		right[i] = buffer.readInt16LE((i * channels + (channels - 1)) * 2) / 32768;
	}
	let peak = 0;
	let crossings = 0;
	let maxChannelDiff = 0;
	for (let i = 0; i < frames; i++) {
		peak = Math.max(peak, Math.abs(left[i]));
		maxChannelDiff = Math.max(maxChannelDiff, Math.abs(left[i] - right[i]));
		if (i > 0 && left[i - 1] < 0 && left[i] >= 0) crossings++;
	}
	const duration = frames / sampleRate;
	return { frames, peak, frequency: duration > 0 ? crossings / duration : 0, maxChannelDiff, left, right };
}

module.exports = { makeWav, wavSource, wavHeader, analyzePcm16 };
