import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { createDecoder, type NativeDecoder } from "@ziji/audio-dsp";
import { NativePCMFilter } from "./NativePCMFilter";

const SAMPLE_RATE = 48_000;
const READ_FRAMES = 16_384;

type EncodedSource = Readable | string | Buffer;

async function readEncodedSource(source: EncodedSource): Promise<Buffer> {
    if (Buffer.isBuffer(source)) return source;
    if (typeof source === "string") {
        if (/^https?:\/\//i.test(source)) {
            const response = await fetch(source);
            if (!response.ok) throw new Error(`Native decoder HTTP request failed: ${response.status} ${response.statusText}`);
            return Buffer.from(await response.arrayBuffer());
        }
        return readFile(source);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

class NativeDecodedReadable extends Readable {
    private readonly decoder: NativeDecoder;
    private ended = false;
    private reading = false;

    constructor(encoded: Buffer, positionMs: number) {
        super({ read() {} });
        this.decoder = createDecoder(encoded);
        if (positionMs > 0) this.decoder.seek(Math.floor((positionMs / 1000) * SAMPLE_RATE));
        this.on("close", () => this.decoder.destroy());
    }

    public override _read(): void {
        if (this.reading || this.ended) return;
        this.reading = true;
        try {
            while (!this.ended) {
                const chunk = this.decoder.read(READ_FRAMES);
                if (chunk.length === 0) {
                    this.ended = true;
                    this.decoder.destroy();
                    this.push(null);
                    return;
                }
                if (!this.push(chunk)) return;
            }
        } catch (error) {
            this.ended = true;
            this.decoder.destroy();
            this.destroy(error as Error);
        } finally {
            this.reading = false;
        }
    }
}

/**
 * First native encoded-source path. The encoded source is buffered once, then
 * miniaudio owns codec decode + PCM seek and NativePCMFilter owns DSP state.
 * This intentionally keeps the decoder/source boundary simple; a callback-backed
 * ma_decoder source can replace the buffering step later without changing the DSP API.
 */
export async function createNativeDecodedPCM(
    source: EncodedSource,
    filters: Parameters<typeof NativePCMFilter>[0] = [],
    positionMs = 0,
): Promise<Readable> {
    const encoded = await readEncodedSource(source);
    const decoded = new NativeDecodedReadable(encoded, positionMs);
    const dsp = new NativePCMFilter(filters);
    decoded.pipe(dsp);
    return dsp;
}
