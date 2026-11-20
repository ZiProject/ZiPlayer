export interface PublishOptions {
	qos?: 0 | 1 | 2;
	retain?: boolean;
}

export type MessageHandler = (topic: string, payload: Uint8Array) => void;

/**
 * Minimal pub/sub transport used by {@link NetNode}. MQTT is the first implementation; any other
 * carrier (WebSocket, TCP, NATS...) only has to implement this interface, because encryption and
 * authentication live above it.
 */
export interface Transport {
	/** Registers a last-will message, published by the broker if this client disappears. Call before `connect()`. */
	setLastWill?(topic: string, payload: Uint8Array, options?: PublishOptions): void;
	connect(): Promise<void>;
	close(): Promise<void>;
	publish(topic: string, payload: Uint8Array, options?: PublishOptions): Promise<void>;
	/** Subscribes to a topic filter (`+` and `#` wildcards allowed). Returns an unsubscribe function. */
	subscribe(filter: string, handler: MessageHandler): Promise<() => void>;
}

/** MQTT-style topic filter matching (`+` single level, `#` multi level). */
export function topicMatches(filter: string, topic: string): boolean {
	const f = filter.split("/");
	const t = topic.split("/");
	for (let i = 0; i < f.length; i++) {
		if (f[i] === "#") return true;
		if (i >= t.length) return false;
		if (f[i] !== "+" && f[i] !== t[i]) return false;
	}
	return f.length === t.length;
}
