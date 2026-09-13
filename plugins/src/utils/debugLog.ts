import { PlayerEventDebug, type PlayerDebugLevel } from "ziplayer";

export type PluginDebugOption = boolean | ((message?: any, ...optionalParams: any[]) => any) | undefined;

/**
 * Builds a `(message?, ...args) => void` debug logger for a standalone plugin.
 *
 * Plugins (unlike extensions) are typically registered once and shared across
 * every guild's `Player`, so they have no single player to bind a
 * {@link PlayerEventDebug} tracer to. Instead this follows the same
 * convention used by `lavalinkExt`'s own local logger: the legacy
 * `options.debug` flag just picks a default PRIORITY -
 *
 * - `true` (or a custom function) -> `"debug"` (visible by default)
 * - `false` / `undefined` -> `"verbose"` (hidden unless explicitly requested)
 *
 * and {@link PlayerEventDebug.resolveLevel} still auto-escalates messages
 * that look like a failure (an `Error`, or text matching "error"/"failed"/
 * "⚠️"/etc.) to at least `"warn"` so problems always surface, even when the
 * plugin's own debug flag is off.
 */
export function createPluginDebugLogger(
	tag: string,
	debugOption: PluginDebugOption,
): (message?: any, ...optionalParams: any[]) => void {
	const customSink = typeof debugOption === "function" ? debugOption : undefined;
	const defaultLevel: PlayerDebugLevel = customSink || debugOption ? "debug" : "verbose";
	const sink = customSink ?? ((message: string, ...args: any[]) => console.log(message, ...args));

	return (message?: any, ...optionalParams: any[]) => {
		const level = PlayerEventDebug.resolveLevel(defaultLevel, message, optionalParams);
		// Without a live player-bound tracer to compare against a running debugLevel,
		// mirror the previous opt-in contract: stay quiet unless explicitly enabled,
		// but never swallow a message that auto-escalated because it looks like a failure.
		if (level === defaultLevel && defaultLevel === "verbose") return;
		const text =
			message === undefined ? ""
			: typeof message === "string" ? message
			: String(message);
		sink(`[${tag}] ${text}`.trimEnd(), ...optionalParams);
	};
}
