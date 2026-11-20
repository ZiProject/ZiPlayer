import { topicMatches, type MessageHandler, type PublishOptions, type Transport } from "./Transport";

interface Subscription {
	client: MemoryTransport;
	filter: string;
	handler: MessageHandler;
}

/** In-process broker for tests and single-process setups. Mimics retained messages and last-will. */
export class MemoryBroker {
	readonly subscriptions = new Set<Subscription>();
	readonly retained = new Map<string, Uint8Array>();
	/** Messages delivered, so tests can assert what an untrusted broker would see. */
	readonly log: Array<{ topic: string; payload: Uint8Array }> = [];
	/** Optional tamper hook: return null to drop, or a replacement payload. */
	intercept?: (topic: string, payload: Uint8Array) => Uint8Array | null;

	deliver(topic: string, payload: Uint8Array, options?: PublishOptions): void {
		const out = this.intercept ? this.intercept(topic, payload) : payload;
		if (!out) return;
		this.log.push({ topic, payload: out });
		if (options?.retain) {
			if (out.length === 0) this.retained.delete(topic);
			else this.retained.set(topic, out);
		}
		for (const sub of [...this.subscriptions]) {
			if (topicMatches(sub.filter, topic)) queueMicrotask(() => sub.handler(topic, out));
		}
	}

	transport(): MemoryTransport {
		return new MemoryTransport(this);
	}
}

export class MemoryTransport implements Transport {
	private will?: { topic: string; payload: Uint8Array; options?: PublishOptions };
	private connected = false;
	private readonly owned = new Set<Subscription>();

	constructor(private readonly broker: MemoryBroker) {}

	setLastWill(topic: string, payload: Uint8Array, options?: PublishOptions): void {
		this.will = { topic, payload, options };
	}

	async connect(): Promise<void> {
		this.connected = true;
	}

	/** Graceful close: the last will is NOT published. */
	async close(): Promise<void> {
		this.connected = false;
		for (const sub of this.owned) this.broker.subscriptions.delete(sub);
		this.owned.clear();
	}

	/** Simulates a crash: drops subscriptions and publishes the last will. */
	async kill(): Promise<void> {
		const will = this.will;
		await this.close();
		if (will) this.broker.deliver(will.topic, will.payload, will.options);
	}

	async publish(topic: string, payload: Uint8Array, options?: PublishOptions): Promise<void> {
		if (!this.connected) throw new Error("MemoryTransport is not connected");
		this.broker.deliver(topic, payload, options);
	}

	async subscribe(filter: string, handler: MessageHandler): Promise<() => void> {
		if (!this.connected) throw new Error("MemoryTransport is not connected");
		const sub: Subscription = { client: this, filter, handler };
		this.broker.subscriptions.add(sub);
		this.owned.add(sub);
		for (const [topic, payload] of this.broker.retained) {
			if (topicMatches(filter, topic)) queueMicrotask(() => handler(topic, payload));
		}
		return () => {
			this.broker.subscriptions.delete(sub);
			this.owned.delete(sub);
		};
	}
}
