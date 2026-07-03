/**
 * Utility function to add timeout to a promise
 * @param promise The promise to add timeout to
 * @param timeoutMs Timeout in milliseconds
 * @param message Error message when timeout occurs
 * @returns Promise that rejects if timeout is reached
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeoutId: NodeJS.Timeout;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
	});
}
