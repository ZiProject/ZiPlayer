import { Readable } from "node:stream";
import { createDecoder, type NativeDecoder } from "@ziji/audio-dsp";
import { NativePCMFilter } from "./NativePCMFilter";

const SAMPLE_RATE = 48_000;
const READ_FRAMES = 16_384;

type DecoderInput = string | Buffer;
type EncodedSource = Readable | DecoderInput;

async function resolveEncodedSource(source: EncodedSource): Promise<DecoderInput> {
    if (Buffer.isBuffer(source)) return source;
    if (typeof source !== "string") {
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks);
    }

    // Local files remain file-backed: miniaudio opens/seeks the file directly.
    // HTTP sources remain memory-backed until a range-backed source is added.
    if (!/^https?:\/\//i.test(source)) return source;

    const response = await fetch(source);
    if (!response.ok) throw new Error(`Native decoder HTTP request failed: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
}

class NativeDecodedReadable extends Readable {
    private readonly decoder: NativeDecoder;
    private ended = false;
    private reading = false;

    constructor(input: DecoderInput, positionMs: number) {
        super({ read() {} });
        this.decoder = createDecoder(input);
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

/** Native encoded source: miniaudio decode/seek -> s16le PCM -> native DSP. */
export async function createNativeDecodedPCM(
    source: EncodedSource,
    filters: ConstructorParameters<typeof NativePCMFilter>[0] = [],
    positionMs = 0,
): Promise<NativePCMFilter> {
    const input = await resolveEncodedSource(source);
    const decoded = new NativeDecodedReadable(input, positionMs);
    const dsp = new NativePCMFilter(filters);
    decoded.pipe(dsp);
    return dsp;
}
