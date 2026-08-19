// stream-converter.ts
import { Readable } from "stream";

export async function webStreamToNodeStream(
	webStream: ReadableStream,
	highWaterMark: number = 64 * 1024,
	seekBytes: number = 0,
	signal?: AbortSignal,
): Promise<Readable> {
	const reader = webStream.getReader();

	let bytesSkipped = 0;
	let streamEnded = false;
	let reading = false;
	let abortHandler: (() => void) | undefined;

	const cleanup = async () => {
		if (abortHandler && signal) {
			signal.removeEventListener("abort", abortHandler);
			abortHandler = undefined;
		}

		try {
			await reader.cancel();
		} catch {
			// Stream may already be closed.
		}

		try {
			reader.releaseLock();
		} catch {
			// Ignore.
		}
	};

	if (signal?.aborted) {
		await cleanup();
		throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	}

	const nodeStream = new Readable({
		highWaterMark,

		async read() {
			if (streamEnded || reading) {
				return;
			}

			reading = true;

			try {
				if (signal?.aborted) {
					throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
				}

				while (true) {
					if (signal?.aborted) {
						throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
					}

					const { done, value } = await reader.read();

					if (done) {
						streamEnded = true;
						this.push(null);
						break;
					}

					if (!value) continue;

					if (seekBytes > 0 && bytesSkipped < seekBytes) {
						const remaining = seekBytes - bytesSkipped;

						if (value.length <= remaining) {
							bytesSkipped += value.length;
							continue;
						}

						const partial = value.subarray(remaining);
						bytesSkipped = seekBytes;

						const buffer = Buffer.from(partial);

						if (!this.push(buffer)) {
							break;
						}

						return;
					}

					const buffer = Buffer.from(value);

					if (!this.push(buffer)) {
						break;
					}

					return;
				}
			} catch (err) {
				streamEnded = true;

				if (!this.destroyed) {
					this.destroy(err as Error);
				}
			} finally {
				reading = false;
			}
		},
	});

	abortHandler = () => {
		if (streamEnded) return;

		streamEnded = true;

		// This is important:
		// cancel() causes the pending reader.read() to settle.
		void reader
			.cancel(signal?.reason)
			.catch(() => {})
			.finally(() => {
				if (!nodeStream.destroyed) {
					nodeStream.destroy(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
				}
			});
	};

	signal?.addEventListener("abort", abortHandler, { once: true });

	const cleanupNodeStream = () => {
		if (abortHandler && signal) {
			signal.removeEventListener("abort", abortHandler);
			abortHandler = undefined;
		}

		try {
			reader.releaseLock();
		} catch {
			// Ignore.
		}
	};

	nodeStream.once("close", cleanupNodeStream);
	nodeStream.once("error", cleanupNodeStream);

	return nodeStream;
}

export function calculateSeekBytes(positionMs: number, bitrateKbps: number = 128): number {
	const bytesPerSecond = (bitrateKbps * 1000) / 8;
	return Math.floor((positionMs / 1000) * bytesPerSecond);
}
