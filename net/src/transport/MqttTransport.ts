import { topicMatches, type MessageHandler, type PublishOptions, type Transport } from "./Transport";

export interface MqttTransportOptions {
	/** e.g. `mqtts://broker.example.com:8883`. Use TLS: node ids and message sizes are visible otherwise. */
	url: string;
	username?: string;
	password?: string;
	clientId?: string;
	/** Extra options passed straight to `mqtt.connect` (TLS certs, keepalive...). */
	connectOptions?: Record<string, unknown>;
	connectTimeoutMs?: number;
	/** MQTT protocol level. Default 5; use 4 (3.1.1) for brokers without v5 support. Nothing here depends on v5-only features. */
	protocolVersion?: 3 | 4 | 5;
}

/** MQTT v5 transport. Requires the optional peer dependency `mqtt`. */
export class MqttTransport implements Transport {
	private client: any = null;
	private will?: { topic: string; payload: Uint8Array; options?: PublishOptions };
	private readonly handlers = new Map<string, Set<MessageHandler>>();

	constructor(private readonly options: MqttTransportOptions) {}

	setLastWill(topic: string, payload: Uint8Array, options?: PublishOptions): void {
		this.will = { topic, payload, options };
	}

	async connect(): Promise<void> {
		let mqtt: any;
		try {
			mqtt = require("mqtt");
		} catch {
			throw new Error('MqttTransport requires the "mqtt" package: npm install mqtt');
		}
		const opts: Record<string, unknown> = {
			protocolVersion: this.options.protocolVersion ?? 5,
			clean: true,
			reconnectPeriod: 2000,
			username: this.options.username,
			password: this.options.password,
			clientId: this.options.clientId,
			...this.options.connectOptions,
		};
		if (this.will) {
			opts.will = {
				topic: this.will.topic,
				payload: Buffer.from(this.will.payload),
				qos: this.will.options?.qos ?? 1,
				retain: this.will.options?.retain ?? false,
			};
		}
		const client = mqtt.connect(this.options.url, opts);
		this.client = client;
		client.on("message", (topic: string, payload: Buffer) => {
			for (const [filter, set] of this.handlers) {
				if (!topicMatches(filter, topic)) continue;
				for (const handler of set) handler(topic, payload);
			}
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("MQTT connect timed out")), this.options.connectTimeoutMs ?? 10_000);
			client.once("connect", () => {
				clearTimeout(timer);
				resolve();
			});
			client.once("error", (error: Error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		// Clean sessions drop subscriptions on reconnect, so subscribe again.
		client.on("connect", () => {
			for (const filter of this.handlers.keys()) client.subscribe(filter, { qos: 1 });
		});
	}

	async close(): Promise<void> {
		const client = this.client;
		this.client = null;
		this.handlers.clear();
		if (client) await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
	}

	publish(topic: string, payload: Uint8Array, options?: PublishOptions): Promise<void> {
		const client = this.client;
		if (!client) return Promise.reject(new Error("MqttTransport is not connected"));
		return new Promise((resolve, reject) =>
			client.publish(
				topic,
				Buffer.from(payload),
				{ qos: options?.qos ?? 1, retain: options?.retain ?? false },
				(error?: Error) => (error ? reject(error) : resolve()),
			),
		);
	}

	async subscribe(filter: string, handler: MessageHandler): Promise<() => void> {
		const client = this.client;
		if (!client) throw new Error("MqttTransport is not connected");
		let set = this.handlers.get(filter);
		const first = !set;
		if (!set) this.handlers.set(filter, (set = new Set()));
		set.add(handler);
		if (first) {
			await new Promise<void>((resolve, reject) =>
				client.subscribe(filter, { qos: 1 }, (error?: Error) => (error ? reject(error) : resolve())),
			);
		}
		return () => {
			set!.delete(handler);
			if (set!.size === 0) {
				this.handlers.delete(filter);
				this.client?.unsubscribe(filter);
			}
		};
	}
}
