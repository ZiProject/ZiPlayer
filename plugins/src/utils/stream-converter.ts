// stream-converter.ts
import { Readable } from "stream";

export async function webStreamToNodeStream(
	webStream: ReadableStream,
	highWaterMark: number = 64 * 1024,
	seekBytes: number = 0,
): Promise<Readable> {
	const reader = webStream.getReader();
	let bytesSkipped = 0;
	let streamEnded = false;

	const nodeStream = new Readable({
		highWaterMark,
		async read() {
			if (streamEnded) {
				this.push(null);
				return;
			}

			try {
				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						streamEnded = true;
						this.push(null);
						break;
					}

					if (!value) continue;

					// Handle seek
					if (seekBytes > 0 && bytesSkipped < seekBytes) {
						const remaining = seekBytes - bytesSkipped;
						if (value.length <= remaining) {
							bytesSkipped += value.length;
							continue;
						} else {
							const partial = value.subarray(remaining);
							bytesSkipped = seekBytes;
							const buffer = Buffer.from(partial);
							if (!this.push(buffer)) {
								// Backpressure
								break;
							}
							return;
						}
					}

					const buffer = Buffer.from(value);
					if (!this.push(buffer)) {
						// Backpressure
						break;
					}
					return;
				}
			} catch (err) {
				console.error("Stream read error:", err);
				streamEnded = true;
				this.destroy(err as Error);
			}
		},
	});

	// Cleanup handlers
	nodeStream.on("close", () => {
		reader.releaseLock();
	});

	nodeStream.on("error", () => {
		reader.releaseLock();
	});

	return nodeStream;
}

export function calculateSeekBytes(positionMs: number, bitrateKbps: number = 128): number {
	const bytesPerSecond = (bitrateKbps * 1000) / 8;
	return Math.floor((positionMs / 1000) * bytesPerSecond);
}
