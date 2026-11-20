import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	sign,
	verify,
	type KeyObject,
} from "node:crypto";
import type { NodeIdentity, TrustStore } from "./identity";

/**
 * Three-message authenticated key exchange (SIGMA-I style, built only from node:crypto):
 *
 *   1. hs1  A -> B   ephemeral X25519 key + nonce                      (plaintext, reveals nothing secret)
 *   2. hs2  B -> A   B's ephemeral key + nonce + Ed25519 signature      (signature encrypted under a handshake key)
 *   3. hs3  A -> B   A's Ed25519 signature over the full transcript     (encrypted)
 *
 * Both signatures cover the whole transcript, so each side proves it owns the pinned long-term key AND
 * took part in this exact exchange. Session keys come from HKDF over the ephemeral ECDH secret, which gives
 * forward secrecy. Node identities are pinned in a {@link TrustStore}; unknown nodes are rejected.
 *
 * This is a small custom protocol on standard primitives. Get it reviewed before trusting it with anything
 * valuable, and consider swapping in a Noise XX implementation behind the same interface.
 */

export const PROTOCOL_VERSION = 1;
const LABEL = Buffer.from("zinet/1");

export class HandshakeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HandshakeError";
	}
}

export interface Hs1 {
	t: "hs1";
	v: number;
	net: string;
	from: string;
	to: string;
	sid: string;
	eA: string;
	nA: string;
}
export interface Hs2 {
	t: "hs2";
	sid: string;
	eB: string;
	nB: string;
	enc: string;
}
export interface Hs3 {
	t: "hs3";
	sid: string;
	enc: string;
}

export interface HandshakeResult {
	sessionId: string;
	peerId: string;
	/** Key for frames this node sends. */
	sendKey: Buffer;
	/** Key for frames this node receives. */
	recvKey: Buffer;
	initiator: boolean;
}

export interface HandshakeContext {
	networkId: string;
	selfId: string;
	identity: NodeIdentity;
	trust: TrustStore;
}

const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function rawPublic(key: KeyObject): Buffer {
	return (key.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
}

function importRawPublic(raw: Buffer): KeyObject {
	if (raw.length !== 32) throw new HandshakeError("Invalid ephemeral key length");
	return createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw]), format: "der", type: "spki" });
}

function lp(...parts: Array<string | Buffer>): Buffer {
	const buffers = parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : p));
	const out: Buffer[] = [];
	for (const b of buffers) {
		const len = Buffer.alloc(2);
		len.writeUInt16BE(b.length);
		out.push(len, b);
	}
	return Buffer.concat(out);
}

function b64(buf: Buffer): string {
	return buf.toString("base64");
}
function unb64(value: unknown, label: string, length?: number): Buffer {
	if (typeof value !== "string") throw new HandshakeError(`Missing ${label}`);
	const buf = Buffer.from(value, "base64");
	if (length !== undefined && buf.length !== length) throw new HandshakeError(`Invalid ${label}`);
	return buf;
}

function transcript(hs1: Hs1, eB?: Buffer, nB?: Buffer): Buffer {
	const base = lp(LABEL, hs1.net, hs1.from, hs1.to, hs1.sid, Buffer.from(hs1.eA, "base64"), Buffer.from(hs1.nA, "base64"));
	return eB && nB ? Buffer.concat([base, lp(eB, nB)]) : base;
}

function deriveKeys(dh: Buffer, nA: Buffer, nB: Buffer, th: Buffer) {
	const salt = Buffer.concat([nA, nB]);
	const expand = (label: string) => Buffer.from(hkdfSync("sha256", dh, salt, Buffer.concat([Buffer.from(label), th]), 32));
	return { hs: expand("zinet/hs"), a2b: expand("zinet/a2b"), b2a: expand("zinet/b2a") };
}

function hsNonce(step: 2 | 3): Buffer {
	const n = Buffer.alloc(12);
	n[11] = step;
	return n;
}

function seal(key: Buffer, nonce: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
	const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
	cipher.setAAD(aad, { plaintextLength: plaintext.length });
	const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([ct, cipher.getAuthTag()]);
}

function open(key: Buffer, nonce: Buffer, aad: Buffer, sealed: Buffer): Buffer {
	if (sealed.length < 16) throw new HandshakeError("Handshake payload too short");
	try {
		const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
		decipher.setAAD(aad, { plaintextLength: sealed.length - 16 });
		decipher.setAuthTag(sealed.subarray(sealed.length - 16));
		return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	} catch {
		throw new HandshakeError("Handshake authentication failed");
	}
}

const sigDigest = (tag: string, th: Buffer, extra?: Buffer) =>
	createHash("sha256")
		.update(tag)
		.update(th)
		.update(extra ?? Buffer.alloc(0))
		.digest();

export class HandshakeInitiator {
	private readonly ephemeral = generateKeyPairSync("x25519");
	private readonly hs1: Hs1;
	private done = false;

	constructor(
		private readonly ctx: HandshakeContext,
		private readonly peerId: string,
	) {
		if (!ctx.trust.has(peerId)) throw new HandshakeError(`Peer "${peerId}" is not trusted`);
		this.hs1 = {
			t: "hs1",
			v: PROTOCOL_VERSION,
			net: ctx.networkId,
			from: ctx.selfId,
			to: peerId,
			sid: randomBytes(8).toString("hex"),
			eA: b64(rawPublic(this.ephemeral.publicKey)),
			nA: b64(randomBytes(16)),
		};
	}

	get sessionId(): string {
		return this.hs1.sid;
	}

	hello(): Hs1 {
		return this.hs1;
	}

	/** Verifies B, returns hs3 plus the session keys. */
	finish(hs2: Hs2): { hs3: Hs3; result: HandshakeResult } {
		if (this.done) throw new HandshakeError("Handshake already completed");
		if (hs2.t !== "hs2" || hs2.sid !== this.hs1.sid) throw new HandshakeError("Unexpected handshake reply");
		const eB = unb64(hs2.eB, "eB", 32);
		const nB = unb64(hs2.nB, "nB", 16);
		const th = createHash("sha256")
			.update(transcript(this.hs1, eB, nB))
			.digest();
		const dh = diffieHellman({ privateKey: this.ephemeral.privateKey, publicKey: importRawPublic(eB) });
		const keys = deriveKeys(dh, Buffer.from(this.hs1.nA, "base64"), nB, th);

		const sigB = open(keys.hs, hsNonce(2), th, unb64(hs2.enc, "enc"));
		const peerKey = this.ctx.trust.publicKey(this.peerId);
		if (!peerKey || !verify(null, sigDigest("resp", th), peerKey, sigB)) throw new HandshakeError("Responder signature invalid");

		const sigA = sign(null, sigDigest("init", th, sigB), this.ctx.identity.privateKey);
		const hs3: Hs3 = { t: "hs3", sid: this.hs1.sid, enc: b64(seal(keys.hs, hsNonce(3), th, sigA)) };
		this.done = true;
		return {
			hs3,
			result: { sessionId: this.hs1.sid, peerId: this.peerId, sendKey: keys.a2b, recvKey: keys.b2a, initiator: true },
		};
	}
}

export class HandshakeResponder {
	private readonly th: Buffer;
	private readonly keys: ReturnType<typeof deriveKeys>;
	private readonly sigB: Buffer;
	private done = false;
	readonly hs2: Hs2;

	constructor(
		private readonly ctx: HandshakeContext,
		private readonly hs1: Hs1,
	) {
		if (hs1.t !== "hs1" || hs1.v !== PROTOCOL_VERSION) throw new HandshakeError("Unsupported handshake version");
		if (hs1.net !== ctx.networkId) throw new HandshakeError("Wrong network");
		if (hs1.to !== ctx.selfId) throw new HandshakeError("Handshake not addressed to this node");
		if (!ctx.trust.has(hs1.from)) throw new HandshakeError(`Peer "${hs1.from}" is not trusted`);
		if (!/^[0-9a-f]{16}$/.test(hs1.sid)) throw new HandshakeError("Invalid session id");
		const eA = unb64(hs1.eA, "eA", 32);
		const nA = unb64(hs1.nA, "nA", 16);
		const ephemeral = generateKeyPairSync("x25519");
		const eB = rawPublic(ephemeral.publicKey);
		const nB = randomBytes(16);
		this.th = createHash("sha256")
			.update(transcript(hs1, eB, nB))
			.digest();
		const dh = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: importRawPublic(eA) });
		this.keys = deriveKeys(dh, nA, nB, this.th);
		this.sigB = sign(null, sigDigest("resp", this.th), ctx.identity.privateKey);
		this.hs2 = { t: "hs2", sid: hs1.sid, eB: b64(eB), nB: b64(nB), enc: b64(seal(this.keys.hs, hsNonce(2), this.th, this.sigB)) };
	}

	get peerId(): string {
		return this.hs1.from;
	}

	/** Verifies A's signature and returns the session keys. */
	finish(hs3: Hs3): HandshakeResult {
		if (this.done) throw new HandshakeError("Handshake already completed");
		if (hs3.t !== "hs3" || hs3.sid !== this.hs1.sid) throw new HandshakeError("Unexpected handshake message");
		const sigA = open(this.keys.hs, hsNonce(3), this.th, unb64(hs3.enc, "enc"));
		const peerKey = this.ctx.trust.publicKey(this.hs1.from);
		if (!peerKey || !verify(null, sigDigest("init", this.th, this.sigB), peerKey, sigA)) {
			throw new HandshakeError("Initiator signature invalid");
		}
		this.done = true;
		return { sessionId: this.hs1.sid, peerId: this.hs1.from, sendKey: this.keys.b2a, recvKey: this.keys.a2b, initiator: false };
	}
}
