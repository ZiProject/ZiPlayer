import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecoder, type NativeDecoder } from "@ziji/audio-dsp";
import { NativePCMFilter } from "./NativePCMFilter";

const SAMPLE_RATE = 48_000;
const READ_FRAMES = 16_384;

type DecoderInput = string | Buffer;
type EncodedSource = Readable | DecoderInput;

type ResolvedSource = {
    input: DecoderInput;
    cleanup: () => Promise<void>;
};

async function spoolToTempFile(source: Readable | Response): Promise<ResolvedSource> {
    const dir = await mkdtemp(join(tmpdir(), "zijiplayer-native-audio-"));
    const path = join(dir, "source.audio");

    try {
        const input = source instanceof Response
            ? source.body
                ? Readable.fromWeb(source.body as globalThis.ReadableStream<Uint8Array>)
                : null
            : source;
        if (!input) throw new Error("Native decoder source has no response body");

        await pipeline(input, createWriteStream(path));
        return {
            input: path,
            cleanup: async () => {
                await rm(dir, { recursive: true, force: true });
            },
        };
    } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

async function resolveEncodedSource(source: EncodedSource): Promise<ResolvedSource> {
    if (Buffer.isBuffer(source)) {
        return { input: source, cleanup: async () => {} };
    }

    if (typeof source !== "string") {
        // Keep the Node stream out of the JS heap. miniaudio's file-backed decoder
        // needs synchronous random access, so the stream is first spooled to disk.
        return spoolToTempFile(source);
    }

    // Local files remain file-backed: miniaudio opens/seeks the file directly.
    if (!/^https?:\/\//i.test(source)) {
        return { input: source, cleanup: async () => {} };
    }

    // Node fetch is asynchronous while miniaudio's decoder callbacks are synchronous.
    // Spooling to a private temp file is therefore the safe bridge: no encoded payload
    // is retained as a large JS Buffer, and miniaudio gets normal file-backed seeking.
    const response = await fetch(source);
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Native decoder HTTP request failed: ${response.status} ${response.statusText}`);
    }
    return spoolToTempFile(response);
}

class NativeDecodedReadable extends Readable {
    private readonly decoder: NativeDecoder;
    private readonly cleanup: () => Promise<void>;
    private ended = false;
    private reading = false;
    private cleaned = false;
    private decoderDestroyed = false;

    constructor(input: DecoderInput, positionMs: number, cleanup: () => Promise<void>) {
        super({ read() {} });
        this.cleanup = cleanup;

        let decoder: NativeDecoder;
        try {
            decoder = createDecoder(input);
            if (positionMs > 0) decoder.seek(Math.floor((positionMs / 1000) * SAMPLE_RATE));
        } catch (error) {
            try { decoder?.destroy(); } catch {}
            void cleanup();
            throw error;
        }
        this.decoder = decoder;

        this.on("close", () => {
            this.destroyDecoder();
            void this.runCleanup();
        });
    }

    private destroyDecoder(): void {
        if (this.decoderDestroyed) return;
        this.decoderDestroyed = true;
        try { this.decoder.destroy(); } catch {}
    }

    private async runCleanup(): Promise<void> {
        if (this.cleaned) return;
        this.cleaned = true;
        await this.cleanup().catch(() => {});
    }

    public override _read(): void {
        if (this.reading || this.ended || this.destroyed) return;
        this.reading = true;
        try {
            while (!this.ended && !this.destroyed) {
                const chunk = this.decoder.read(READ_FRAMES);
                if (chunk.length === 0) {
                    this.ended = true;
                    this.destroyDecoder();
                    this.push(null);
                    return;
                }
                if (!this.push(chunk)) return;
            }
        } catch (error) {
            this.ended = true;
            this.destroyDecoder();
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
    const resolved = await resolveEncodedSource(source);
    let decoded: NativeDecodedReadable;
    try {
        decoded = new NativeDecodedReadable(resolved.input, positionMs, resolved.cleanup);
    } catch (error) {
        await resolved.cleanup().catch(() => {});
        throw error;
    }

    let dsp: NativePCMFilter;
    try {
        dsp = new NativePCMFilter(filters);
    } catch (error) {
        decoded.destroy(error as Error);
        throw error;
    }

    // A decoder/source error must terminate the DSP side too. Relying on pipe() alone
    // leaves the destination alive when the source emits an error.
    decoded.once("error", (error) => {
        if (!dsp.destroyed) dsp.destroy(error);
    });
    decoded.once("close", () => {
        if (!dsp.destroyed && decoded.errored) dsp.destroy(decoded.errored);
    });
    dsp.once("close", () => decoded.destroy());
    decoded.pipe(dsp);
    return dsp;
}
