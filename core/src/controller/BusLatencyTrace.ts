import type { PlayerDebugLevel, BusLatencyKind, BusLatencyRecord } from "../types";

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** Pure latency recorder. It creates BusLatencyRecord values and optionally emits them to a sink. */
export class BusLatencyTrace {
	private level: PlayerDebugLevel;
	private readonly onRecord?: (record: BusLatencyRecord) => void;

	public constructor(
		arg1?: PlayerDebugLevel | ((record: BusLatencyRecord) => void),
		arg2?: PlayerDebugLevel | ((record: BusLatencyRecord) => void),
	) {
		if (typeof arg1 === "function") {
			this.onRecord = arg1;
			this.level = (typeof arg2 === "string" ? arg2 : "off") as PlayerDebugLevel;
		} else {
			this.level = (arg1 ?? "off") as PlayerDebugLevel;
			this.onRecord = typeof arg2 === "function" ? arg2 : undefined;
		}
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

	public measure<T>(kind: BusLatencyKind, type: string, operation: () => T): T {
		const start = this.start();
		try {
			return operation();
		} finally {
			this.record(kind, type, start);
		}
	}

	public async measureAsync<T>(kind: BusLatencyKind, type: string, operation: () => Promise<T>): Promise<T> {
		const start = this.start();
		try {
			return await operation();
		} finally {
			this.record(kind, type, start);
		}
	}

	public record(
		kind: BusLatencyKind,
		type: string,
		start: number,
		meta: Omit<BusLatencyRecord, "kind" | "type" | "durationUs" | "timestamp"> = {},
	): number {
		const durationUs = Math.max(0, (nowMs() - start) * 1000);
		if (this.enabled) {
			const record: BusLatencyRecord = {
				kind,
				type,
				durationUs,
				timestamp: Date.now(),
				...meta,
			};
			this.onRecord?.(record);
		}
		return durationUs;
	}
}
