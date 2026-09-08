import { Transform, type TransformCallback } from "node:stream";
import { createDSP, type AudioDSP } from "@ziji/audio-dsp";
import type { AudioFilter } from "../types";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2; // s16le stereo

/**
 * Native miniaudio-backed DSP for streams that are already raw s16le PCM.
 * Encoded sources still require a decoder before they can enter this path.
 */
export class NativePCMFilter extends Transform {
	private readonly dsp: AudioDSP;
	private pending = Buffer.alloc(0);

	constructor(filters: AudioFilter[] = []) {
		super();
		this.dsp = createDSP({ sampleRate: SAMPLE_RATE, channels: CHANNELS, format: "s16" });
		this.setFilters(filters);
	}

	public setFilters(filters: AudioFilter[]): void {
		this.dsp.clearBiquad();
		this.dsp.clearEQ();
		this.dsp.clearLimiter();
		this.dsp.clearCompressor();
		this.dsp.setVolume(1);
		this.dsp.setMute(false);
		this.dsp.setPan(0);

		for (const filter of filters) {
			switch (filter.name) {
				case "bassboost":
					this.dsp.setBiquad({ type: "lowShelf", frequency: 110, q: 0.707, gain: 10 });
					break;
				case "trebleboost":
					this.dsp.setBiquad({ type: "highShelf", frequency: 3000, q: 0.707, gain: 10 });
					break;
				case "lowpass":
					this.dsp.addBiquad(`native:${filter.name}`, { type: "lowPass", frequency: 3000, q: 0.707 });
					break;
				case "highpass":
					this.dsp.addBiquad(`native:${filter.name}`, { type: "highPass", frequency: 200, q: 0.707 });
					break;
				case "bandpass":
					this.dsp.addBiquad(`native:${filter.name}`, { type: "bandPass", frequency: 1000, q: 1 });
					break;
				case "equalizer":
					this.dsp.addEQ(`native:${filter.name}`, [{ type: "peaking", frequency: 1000, q: 0.707, gain: 5 }]);
					break;
				case "limiter":
					this.dsp.setLimiter({ threshold: -1, release: 50 });
					break;
				case "compressor":
					this.dsp.setCompressor({ threshold: -18, ratio: 4, attack: 10, release: 100 });
					break;
			}
		}
		this.dsp.setFilterOrder(
			filters
				.filter((filter) => ["lowpass", "highpass", "bandpass", "equalizer"].includes(filter.name))
				.map((filter) => `native:${filter.name}`),
		);
		this.dsp.resetState();
	}

	public resetState(): void {
		this.dsp.resetState();
	}

	public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
		try {
			const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
			const completeLength = data.length - (data.length % BYTES_PER_FRAME);
			if (completeLength > 0) this.push(this.dsp.process(data.subarray(0, completeLength)));
			this.pending = completeLength === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(completeLength));
			callback();
		} catch (error) {
			callback(error as Error);
		}
	}

	public override _flush(callback: TransformCallback): void {
		if (this.pending.length !== 0) {
			callback(new Error("Native PCM stream ended with a partial s16le stereo frame"));
			return;
		}
		callback();
	}

	public override destroy(error?: Error): this {
		try {
			this.dsp.destroy();
		} catch {}
		return super.destroy(error);
	}
}

export function canUseNativePCM(filters: AudioFilter[]): boolean {
	const supported = new Set(["bassboost", "trebleboost", "lowpass", "highpass", "bandpass", "equalizer", "limiter", "compressor"]);
	return filters.every((filter) => supported.has(filter.name));
}
