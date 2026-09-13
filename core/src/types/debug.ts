/**
 * PRIORITY levels understood by {@link PlayerEventDebug} (see
 * `core/src/controller/PlayerEventDebug.ts`). Lower priority number = more
 * severe / always shown; see `DEBUG_PRIORITY` for the numeric ordering.
 */
export type PlayerDebugLevel = "off" | "error" | "warn" | "info" | "debug" | "verbose" | "time";

/**
 * Sink invoked by {@link PlayerEventDebug} once a message has cleared its priority check.
 * Kept variadic (rather than a single `value` payload) so every call site - controllers,
 * plugins, extensions - can forward extra args through untouched.
 */
export type PlayerEventDebugLogger = (message: string, ...args: any[]) => void;
