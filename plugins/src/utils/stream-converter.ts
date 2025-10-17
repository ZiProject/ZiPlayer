import { Readable } from "stream";

/**
 * Converts a Web ReadableStream to a Node.js Readable stream
 */
export function webStreamToNodeStream(webStream: ReadableStream): Readable {
	const nodeStream = new Readable({
		read() {
			// This will be handled by the Web Stream reader
		},
	});

	// Create a reader from the Web Stream
	const reader = webStream.getReader();

	// Read chunks and push to Node.js stream
	const pump = async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					nodeStream.push(null); // End the stream
					break;
				}
				nodeStream.push(Buffer.from(value));
			}
		} catch (error) {
			nodeStream.destroy(error as Error);
		}
	};

	// Start pumping data
	pump();

	return nodeStream;
}

/**
 * Converts a Web ReadableStream to a Node.js Readable stream with progress tracking
 */
export function webStreamToNodeStreamWithProgress(
	webStream: ReadableStream,
	progressCallback?: (bytesRead: number) => void,
): Readable {
	const nodeStream = new Readable({
		read() {
			// This will be handled by the Web Stream reader
		},
	});

	let bytesRead = 0;
	const reader = webStream.getReader();

	const pump = async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					nodeStream.push(null); // End the stream
					break;
				}

				const buffer = Buffer.from(value);
				nodeStream.push(buffer);

				bytesRead += buffer.length;
				if (progressCallback) {
					progressCallback(bytesRead);
				}
			}
		} catch (error) {
			nodeStream.destroy(error as Error);
		}
	};

	pump();

	return nodeStream;
}
