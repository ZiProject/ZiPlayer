import { Readable } from "stream";

export async function webStreamToNodeStream(webStream: ReadableStream, highWaterMark: number = 64 * 1024): Promise<Readable> {
	const reader = webStream.getReader();
	const chunks: Uint8Array[] = [];

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) break;
			if (value) chunks.push(value);
		}

		// Gộp tất cả chunks
		const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

		// Trả về Node.js Readable stream
		return Readable.from(buffer, {
			highWaterMark,
		});
	} catch (err) {
		reader.releaseLock();
		throw err;
	}
}
