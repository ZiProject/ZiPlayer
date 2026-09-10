import type { PlayerDebugLevel, PlayerEventDebugLogger, PlayerBusLatencyKind, PlayerBusLatencyRecord } from "../types";

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** Optional high-resolution timing sink for PlayerBus. Disabled unless debug level is `time`. */
export class PlayerBusLatencyTrace {
	private level: PlayerDebugLevel;

	public constructor(
		private readonly logger?: PlayerEventDebugLogger,
		level: PlayerDebugLevel = "off",
	) {
		this.level = level;
	}

	public get debugLevel(): PlayerDebugLevel {
		return this.level;
	}

	public setDebugLevel(level: PlayerDebugLevel): void {
		this.level = level;
	}

	public get enabled(): boolean {
		return this.level === "time";
	}

	public start(): number {
		return nowMs();
	}

	public record(
		kind: PlayerBusLatencyKind,
		type: string,
		start: number,
		meta: Omit<PlayerBusLatencyRecord, "kind" | "type" | "durationUs" | "timestamp"> = {},
	): number {
		const durationUs = Math.max(0, (nowMs() - start) * 1000);
		if (this.enabled) {
			const record: PlayerBusLatencyRecord = {
				kind,
				type,
				durationUs,
				timestamp: Date.now(),
				...meta,
			};
			this.logger?.(`[PlayerBusLatency] ${formatRecord(record)}`, record);
		}
		return durationUs;
	}
}

function formatRecord(record: PlayerBusLatencyRecord): string {
	const parts = [`kind=${record.kind}`, `type=${record.type}`, `duration=${formatUs(record.durationUs)}`];
	if (record.handler) parts.push(`handler=${record.handler}`);
	if (record.requestId) parts.push(`request=${record.requestId}`);
	if (record.sessionId) parts.push(`session=${record.sessionId}`);
	if (record.source) parts.push(`source=${record.source}`);
	return parts.join(" ");
}

function formatUs(value: number): string {
	if (value < 1000) return `${value.toFixed(1)}µs`;
	return `${(value / 1000).toFixed(2)}ms`;
}
