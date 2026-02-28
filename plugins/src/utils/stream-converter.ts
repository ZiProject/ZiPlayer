import { Readable } from "stream";

export function webStreamToNodeStream(webStream: ReadableStream, highWaterMark: number = 64 * 1024): Readable {
	const reader = webStream.getReader();

	return new Readable({
		highWaterMark: highWaterMark ?? 64 * 1024,
		async read() {
			try {
				const { done, value } = await reader.read();
				if (done) {
					this.push(null);
				} else {
					this.push(value);
				}
			} catch (err) {
				this.destroy(err as Error);
			}
		},
	});
}
