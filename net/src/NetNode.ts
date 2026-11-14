import { EventEmitter } from "node:events";
import { HandshakeError, HandshakeInitiator, HandshakeResponder, type Hs1, type Hs2, type Hs3 } from "./crypto/handshake";
import {
	fingerprint,
	loadIdentity,
	loadOrCreateIdentity,
	parsePublicKey,
	TrustStore,
	type NetRole,
	type NodeIdentity,
	type TrustedPeer,
} from "./crypto/identity";
import { KIND, SecureChannel, SessionError } from "./crypto/session";
import { decodePlainAudio, encodePlainAudio, sessionIdOf, topics, type AudioFrame } from "./protocol/frames";
import type { Transport } from "./transport/Transport";

export interface NetNodeOptions {
	/** Unique id of this node. No `/`, `+` or `#`. */
	nodeId: string;
	/** Isolates independent clusters sharing one broker. */
	networkId?: string;
	/** Ed25519 identity: PEM private key or a loaded identity. Omit it and give `keyFile` to load-or-create one. */
	identity?: string | NodeIdentity;
	/** Where to keep the node's private key. If the file does not exist a new key is created there. */
	keyFile?: string;
	/** Pinned peers. Anyone not listed is rejected during the handshake. */
	trust?: TrustStore | TrustedPeer[];
	transport: Transport;
	/** Encrypt audio frames too. Default `false`: Opus/WebM audio is sent in clear, control data is always encrypted. */
	encryptAudio?: boolean;
	/** MQTT QoS for audio frames (default 1 so container streams never lose bytes). */
	audioQos?: 0 | 1;
	requestTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	sessionMaxAgeMs?: number;
	debug?: (message: string, ...args: unknown[]) => void;
}

export interface RequestContext {
	from: string;
	session: SecureChannel;
}

export type RequestHandler = (body: any, context: RequestContext) => unknown | Promise<unknown>;

interface Pending {
	peerId: string;
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class NetError extends Error {
	constructor(
		message: string,
		readonly code: string = "NET_ERROR",
	) {
		super(message);
		this.name = "NetError";
	}
}

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * One ZiPlayer process on the network. Owns the transport, authenticates peers with the 3-message
 * handshake, and exposes encrypted request/notify messaging plus (optionally encrypted) audio frames.
 *
 * Events: `peerOnline(id)`, `peerOffline(id)`, `sessionOpen(id)`, `sessionClose(id)`.
 */
export class NetNode extends EventEmitter {
	readonly nodeId: string;
	readonly networkId: string;
	readonly trust: TrustStore;
	/** This node's public key, announced in its presence message so operators can pair nodes. */
	readonly publicKeyPem: string;
	readonly fingerprint: string;
	private readonly discovered = new Map<string, { nodeId: string; publicKey: string; fingerprint: string }>();
	private readonly identity: NodeIdentity;
	private readonly transport: Transport;
	private readonly options: NetNodeOptions;
	private readonly bySid = new Map<string, SecureChannel>();
	private readonly byPeer = new Map<string, SecureChannel>();
	private readonly initiating = new Map<string, Promise<SecureChannel>>();
	private readonly initiators = new Map<
		string,
		{ hs: HandshakeInitiator; resolve: (c: SecureChannel) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private readonly responders = new Map<string, { hs: HandshakeResponder; timer: NodeJS.Timeout }>();
	private readonly handlers = new Map<string, { handler: RequestHandler; role?: NetRole }>();
	private readonly pending = new Map<number, Pending>();
	private readonly online = new Set<string>();
	private audioHandler?: (peerId: string, frame: AudioFrame) => void;
	private nextId = 1;
	private unsubs: Array<() => void> = [];
	private started = false;

	constructor(options: NetNodeOptions) {
		super();
		if (!ID_RE.test(options.nodeId)) throw new TypeError("nodeId must match [A-Za-z0-9._:-]{1,64}");
		this.options = options;
		this.nodeId = options.nodeId;
		this.networkId = options.networkId ?? "default";
		if (!ID_RE.test(this.networkId)) throw new TypeError("networkId must match [A-Za-z0-9._:-]{1,64}");
		if (options.identity)
			this.identity = typeof options.identity === "string" ? loadIdentity(options.identity) : options.identity;
		else if (options.keyFile) this.identity = loadOrCreateIdentity(options.keyFile).identity;
		else throw new TypeError("NetNode needs an `identity` or a `keyFile`");
		this.publicKeyPem = this.identity.publicKey.export({ type: "spki", format: "pem" }).toString();
		this.fingerprint = fingerprint(this.identity.publicKey);
		this.trust = options.trust instanceof TrustStore ? options.trust : new TrustStore(options.trust ?? []);
		this.transport = options.transport;
	}

	private debug(message: string, ...args: unknown[]) {
		this.options.debug?.(`[net:${this.nodeId}] ${message}`, ...args);
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.started) return;
		const enc = (v: unknown) => Buffer.from(JSON.stringify(v));
		const presenceTopic = topics.presence(this.networkId, this.nodeId);
		this.transport.setLastWill?.(presenceTopic, enc({ online: false, nodeId: this.nodeId }), { qos: 1, retain: true });
		await this.transport.connect();
		this.started = true;
		this.unsubs.push(
			await this.transport.subscribe(topics.inbox(this.networkId, this.nodeId), (_t, p) => this.onInbox(Buffer.from(p))),
			await this.transport.subscribe(topics.audio(this.networkId, this.nodeId), (_t, p) => this.onAudioFrame(Buffer.from(p))),
			await this.transport.subscribe(topics.presenceAll(this.networkId), (t, p) => this.onPresence(t, Buffer.from(p))),
		);
		await this.transport.publish(
			presenceTopic,
			enc({ online: true, nodeId: this.nodeId, ts: Date.now(), pub: this.publicKeyPem }),
			{ qos: 1, retain: true },
		);
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		try {
			await this.transport.publish(
				topics.presence(this.networkId, this.nodeId),
				Buffer.from(JSON.stringify({ online: false, nodeId: this.nodeId })),
				{ qos: 1, retain: true },
			);
		} catch {}
		for (const u of this.unsubs.splice(0)) u();
		for (const peerId of [...this.byPeer.keys()]) this.closeSessions(peerId, "node stopped");
		for (const s of this.initiators.values()) {
			clearTimeout(s.timer);
			s.reject(new NetError("node stopped", "STOPPED"));
		}
		this.initiators.clear();
		this.initiating.clear();
		for (const r of this.responders.values()) clearTimeout(r.timer);
		this.responders.clear();
		await this.transport.close();
	}

	/** Nodes seen on the network that are not trusted yet. Compare `fingerprint` out-of-band before accepting. */
	discoveredPeers(): Array<{ nodeId: string; fingerprint: string; publicKey: string }> {
		return [...this.discovered.values()];
	}

	/**
	 * Trusts a discovered node. `expectedFingerprint` must match the key it announced, so a swapped key is refused.
	 * Both sides have to accept each other before they can talk.
	 */
	acceptPeer(nodeId: string, expectedFingerprint: string, roles?: NetRole[]): void {
		const found = this.discovered.get(nodeId);
		if (!found) throw new NetError(`Node "${nodeId}" has not been discovered`, "UNKNOWN_PEER");
		if (found.fingerprint !== expectedFingerprint.toLowerCase().replace(/[^0-9a-f]/g, "")) {
			throw new NetError("Fingerprint mismatch", "FINGERPRINT_MISMATCH");
		}
		this.trust.add({ nodeId, publicKey: found.publicKey, roles });
		this.discovered.delete(nodeId);
		this.online.add(nodeId);
		this.emit("peerOnline", nodeId);
	}

	isOnline(peerId: string): boolean {
		return this.online.has(peerId);
	}

	onlinePeers(): string[] {
		return [...this.online];
	}

	// ── messaging API ────────────────────────────────────────────────────────

	/** Registers a handler for a message type. `role` is checked against the caller's trust entry. */
	handle(type: string, handler: RequestHandler, options?: { role?: NetRole }): () => void {
		this.handlers.set(type, { handler, role: options?.role });
		return () => this.handlers.delete(type);
	}

	async request<T = any>(
		peerId: string,
		type: string,
		body?: unknown,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T> {
		const session = await this.ensureSession(peerId);
		const id = this.nextId++;
		const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs ?? 15_000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new NetError(`Request "${type}" to ${peerId} timed out`, "TIMEOUT"));
			}, timeoutMs);
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new NetError("Request aborted", "ABORTED"));
			};
			if (options?.signal) {
				if (options.signal.aborted) return onAbort();
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending.set(id, { peerId, resolve, reject, timer });
			this.sendControl(session, { id, type, body }).catch((error) => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	async notify(peerId: string, type: string, body?: unknown): Promise<void> {
		const session = await this.ensureSession(peerId);
		await this.sendControl(session, { type, body });
	}

	onAudio(handler: (peerId: string, frame: AudioFrame) => void): void {
		this.audioHandler = handler;
	}

	async sendAudio(peerId: string, frame: AudioFrame): Promise<void> {
		const session = await this.ensureSession(peerId);
		const data =
			this.options.encryptAudio ?
				session.sealAudio(frame.streamId, frame.seq, frame.flags, frame.payload)
			:	encodePlainAudio(session.sessionId, frame);
		await this.transport.publish(topics.audio(this.networkId, peerId), data, { qos: this.options.audioQos ?? 1 });
	}

	// ── sessions ─────────────────────────────────────────────────────────────

	async ensureSession(peerId: string): Promise<SecureChannel> {
		if (!this.started) throw new NetError("node not started", "NOT_STARTED");
		const existing = this.byPeer.get(peerId);
		if (existing && !existing.expired) return existing;
		const inflight = this.initiating.get(peerId);
		if (inflight) return inflight;
		const promise = this.startHandshake(peerId).finally(() => this.initiating.delete(peerId));
		this.initiating.set(peerId, promise);
		return promise;
	}

	hasSession(peerId: string): boolean {
		const s = this.byPeer.get(peerId);
		return Boolean(s && !s.expired);
	}

	private startHandshake(peerId: string): Promise<SecureChannel> {
		return new Promise<SecureChannel>((resolve, reject) => {
			let hs: HandshakeInitiator;
			try {
				hs = new HandshakeInitiator(this.ctx(), peerId);
			} catch (error) {
				return reject(error);
			}
			const sid = hs.sessionId;
			const timer = setTimeout(() => {
				this.initiators.delete(sid);
				reject(new NetError(`Handshake with ${peerId} timed out`, "HANDSHAKE_TIMEOUT"));
			}, this.options.handshakeTimeoutMs ?? 10_000);
			this.initiators.set(sid, { hs, resolve, reject, timer });
			this.publishHandshake(peerId, hs.hello()).catch((error) => {
				clearTimeout(timer);
				this.initiators.delete(sid);
				reject(error);
			});
		});
	}

	private ctx() {
		return { networkId: this.networkId, selfId: this.nodeId, identity: this.identity, trust: this.trust };
	}

	private publishHandshake(peerId: string, message: Hs1 | Hs2 | Hs3) {
		const data = Buffer.concat([Buffer.from([KIND.HANDSHAKE]), Buffer.from(JSON.stringify(message))]);
		return this.transport.publish(topics.inbox(this.networkId, peerId), data, { qos: 1 });
	}

	private install(channel: SecureChannel) {
		const old = this.byPeer.get(channel.peerId);
		this.bySid.set(channel.sessionId, channel);
		this.byPeer.set(channel.peerId, channel);
		if (old && old !== channel) {
			// Keep the old one receivable briefly: in-flight frames may still use it.
			setTimeout(() => {
				this.bySid.delete(old.sessionId);
				old.closed = true;
			}, 5_000).unref?.();
		}
		this.debug(`session ${channel.sessionId} open with ${channel.peerId}`);
		this.emit("sessionOpen", channel.peerId);
	}

	private closeSessions(peerId: string, reason: string) {
		for (const [sid, s] of this.bySid) {
			if (s.peerId !== peerId) continue;
			s.closed = true;
			this.bySid.delete(sid);
		}
		if (this.byPeer.delete(peerId)) this.emit("sessionClose", peerId);
		for (const [id, p] of this.pending) {
			if (p.peerId !== peerId) continue;
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.reject(new NetError(`Session with ${peerId} closed: ${reason}`, "SESSION_CLOSED"));
		}
	}

	// ── inbound ──────────────────────────────────────────────────────────────

	private onPresence(topic: string, payload: Buffer) {
		const peerId = topic.split("/").pop()!;
		if (peerId === this.nodeId) return;
		let online = false;
		let pub: unknown;
		try {
			const parsed = JSON.parse(payload.toString("utf8"));
			online = parsed.online === true;
			pub = parsed.pub;
		} catch {
			return;
		}
		if (!this.trust.has(peerId)) {
			// Unknown node: remember its announced key so an operator can verify the fingerprint and accept it.
			if (online && typeof pub === "string" && pub.length < 2048 && !this.discovered.has(peerId)) {
				try {
					const fp = fingerprint(parsePublicKey(pub));
					this.discovered.set(peerId, { nodeId: peerId, publicKey: pub, fingerprint: fp });
					this.emit("peerDiscovered", { nodeId: peerId, fingerprint: fp, publicKey: pub });
				} catch {}
			}
			return;
		}
		if (online) {
			if (!this.online.has(peerId)) {
				this.online.add(peerId);
				this.emit("peerOnline", peerId);
			}
		} else if (this.online.delete(peerId)) {
			this.closeSessions(peerId, "peer offline");
			this.emit("peerOffline", peerId);
		}
	}

	private onInbox(buf: Buffer) {
		if (buf.length < 2) return;
		try {
			if (buf[0] === KIND.HANDSHAKE) this.onHandshake(JSON.parse(buf.subarray(1).toString("utf8")));
			else if (buf[0] === KIND.CONTROL) void this.onControl(buf);
		} catch (error) {
			this.debug(`dropped inbound message: ${(error as Error).message}`);
		}
	}

	private onHandshake(message: Hs1 | Hs2 | Hs3) {
		if (!message || typeof message !== "object") return;
		if (message.t === "hs1") {
			if (this.responders.size >= 64) return;
			let responder: HandshakeResponder;
			try {
				responder = new HandshakeResponder(this.ctx(), message);
			} catch (error) {
				this.debug(`rejected handshake: ${(error as Error).message}`);
				return;
			}
			const sid = message.sid;
			const timer = setTimeout(() => this.responders.delete(sid), this.options.handshakeTimeoutMs ?? 10_000);
			timer.unref?.();
			this.responders.set(sid, { hs: responder, timer });
			this.publishHandshake(responder.peerId, responder.hs2).catch((e) => this.debug(`hs2 publish failed: ${e.message}`));
		} else if (message.t === "hs2") {
			const entry = this.initiators.get(message.sid);
			if (!entry) return;
			this.initiators.delete(message.sid);
			clearTimeout(entry.timer);
			try {
				const { hs3, result } = entry.hs.finish(message);
				const channel = new SecureChannel(result.sessionId, result.peerId, true, result.sendKey, result.recvKey, {
					maxAgeMs: this.options.sessionMaxAgeMs,
				});
				// Install before sending hs3 so a fast reply is not dropped.
				this.install(channel);
				this.publishHandshake(result.peerId, hs3).then(
					() => entry.resolve(channel),
					(e) => entry.reject(e),
				);
			} catch (error) {
				entry.reject(error instanceof Error ? error : new HandshakeError(String(error)));
			}
		} else if (message.t === "hs3") {
			const entry = this.responders.get(message.sid);
			if (!entry) return;
			this.responders.delete(message.sid);
			clearTimeout(entry.timer);
			try {
				const result = entry.hs.finish(message);
				this.install(
					new SecureChannel(result.sessionId, result.peerId, false, result.sendKey, result.recvKey, {
						maxAgeMs: this.options.sessionMaxAgeMs,
					}),
				);
			} catch (error) {
				this.debug(`handshake failed: ${(error as Error).message}`);
			}
		}
	}

	private async sendControl(session: SecureChannel, message: Record<string, unknown>) {
		const frame = session.seal(Buffer.from(JSON.stringify(message)));
		await this.transport.publish(topics.inbox(this.networkId, session.peerId), frame, { qos: 1 });
	}

	private async onControl(buf: Buffer) {
		const sid = sessionIdOf(buf);
		const session = sid ? this.bySid.get(sid) : undefined;
		if (!session) return;
		let message: { id?: number; re?: number; type?: string; body?: any; err?: { message: string; code?: string } };
		try {
			message = JSON.parse(session.open(buf).toString("utf8"));
		} catch (error) {
			if (error instanceof SessionError) this.debug(`dropped control frame: ${error.message}`);
			return;
		}
		if (message.re !== undefined) {
			const p = this.pending.get(message.re);
			if (!p || p.peerId !== session.peerId) return;
			clearTimeout(p.timer);
			this.pending.delete(message.re);
			if (message.err) p.reject(new NetError(message.err.message, message.err.code ?? "REMOTE_ERROR"));
			else p.resolve(message.body);
			return;
		}
		if (typeof message.type !== "string") return;
		const entry = this.handlers.get(message.type);
		const reply = (payload: Record<string, unknown>) => {
			if (message.id === undefined) return;
			this.sendControl(session, { re: message.id, ...payload }).catch(() => {});
		};
		if (!entry) return reply({ err: { message: `No handler for "${message.type}"`, code: "NO_HANDLER" } });
		if (entry.role && !this.trust.hasRole(session.peerId, entry.role)) {
			return reply({ err: { message: `Peer lacks role "${entry.role}"`, code: "FORBIDDEN" } });
		}
		try {
			reply({ body: await entry.handler(message.body, { from: session.peerId, session }) });
		} catch (error) {
			reply({ err: { message: (error as Error).message, code: (error as any).code } });
		}
	}

	private onAudioFrame(buf: Buffer) {
		try {
			const sid = sessionIdOf(buf);
			const session = sid ? this.bySid.get(sid) : undefined;
			if (!session || !this.audioHandler) return;
			if (buf[0] === KIND.AUDIO_ENCRYPTED) {
				this.audioHandler(session.peerId, session.openAudio(buf));
			} else if (buf[0] === KIND.AUDIO) {
				if (this.options.encryptAudio) return; // refuse downgrade
				this.audioHandler(session.peerId, decodePlainAudio(buf).frame);
			}
		} catch (error) {
			this.debug(`dropped audio frame: ${(error as Error).message}`);
		}
	}
}
