/** Normalizes any thrown value into an `Error` instance. */
export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** True when `error` is an `AbortError` (DOMException is an Error in supported Node versions). */
export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Creates the error used when an operation is cancelled through an `AbortSignal`. */
export function createAbortError(message = "Operation was aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

/**
 * Races `promise` against `signal`: rejects with `createError()` as soon as the
 * signal aborts, otherwise settles exactly like `promise`. The abort listener is
 * always removed once either side settles.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, createError: () => Error = createAbortError): Promise<T> {
	if (signal.aborted) return Promise.reject(createError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(createError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
