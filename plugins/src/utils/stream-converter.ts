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
	let cleanedUp = false;
	let cleanupPromise: Promise<void> | undefined;
	let abortHandler: (() => void) | undefined;

	/**
	 * Cancel the underlying Web ReadableStream before releasing the reader.
	 *
	 * Releasing a reader lock does NOT cancel the underlying stream. This is
	 * important when the Node stream is destroyed by StreamManager/player
	 * cleanup: the YouTube request must be cancelled as well.
	 */
	const cleanup = (): Promise<void> => {
		if (cleanupPromise) return cleanupPromise;

		cleanupPromise = (async () => {
			if (cleanedUp) return;
			cleanedUp = true;

			if (abortHandler && signal) {
				signal.removeEventListener("abort", abortHandler);
				abortHandler = undefined;
			}

			try {
				await reader.cancel();
			} catch {
				// The stream may already be closed, errored, or cancelled.
			}

			try {
				reader.releaseLock();
			} catch {
				// Ignore.
			}
		})();

		return cleanupPromise;
	};

	if (signal?.aborted) {
		await cleanup();
		throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	}

	const nodeStream = new Readable({
		highWaterMark,

		async read() {
			if (streamEnded || reading || cleanedUp) {
				return;
			}

			reading = true;

			try {
				if (signal?.aborted) {
					throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
				}

				while (true) {
					if (streamEnded || cleanedUp) return;

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
		if (streamEnded || cleanedUp) return;

		streamEnded = true;

		const reason = signal?.reason ?? new DOMException("The operation was aborted", "AbortError");

		// Cancel first so a pending reader.read() settles, then destroy the
		// Node stream. cleanup() is idempotent and also removes this listener.
		void cleanup().finally(() => {
			if (!nodeStream.destroyed) {
				nodeStream.destroy(reason);
			}
		});
	};

	signal?.addEventListener("abort", abortHandler, { once: true });

	// Node consumers may call destroy() directly (StreamManager does this
	// when replacing/evicting a stream). Always cancel the WebStream too.
	nodeStream.once("close", () => {
		void cleanup();
	});

	nodeStream.once("error", () => {
		void cleanup();
	});

	nodeStream.once("end", () => {
		void cleanup();
	});

	return nodeStream;
}

export function calculateSeekBytes(positionMs: number, bitrateKbps: number = 128): number {
	const bytesPerSecond = (bitrateKbps * 1000) / 8;
	return Math.floor((positionMs / 1000) * bytesPerSecond);
}
