import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Long-term Ed25519 identity of a node. Used only to sign handshake transcripts. */
export interface NodeIdentity {
	privateKey: KeyObject;
	publicKey: KeyObject;
}

export interface GeneratedIdentity {
	identity: NodeIdentity;
	privateKeyPem: string;
	publicKeyPem: string;
}

export function generateIdentity(): GeneratedIdentity {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		identity: { privateKey, publicKey },
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

export function loadIdentity(privateKeyPem: string | KeyObject): NodeIdentity {
	const privateKey = typeof privateKeyPem === "string" ? createPrivateKey(privateKeyPem) : privateKeyPem;
	if (privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("Node identity must be an Ed25519 key");
	return { privateKey, publicKey: createPublicKey(privateKey) };
}

/**
 * Loads the node identity from `keyFile`, or creates and stores a new one (mode 0600, plus `<file>.pub`)
 * when the file does not exist yet.
 */
export function loadOrCreateIdentity(keyFile: string): GeneratedIdentity & { created: boolean } {
	if (existsSync(keyFile)) {
		const privateKeyPem = readFileSync(keyFile, "utf8");
		const identity = loadIdentity(privateKeyPem);
		return {
			identity,
			privateKeyPem,
			publicKeyPem: identity.publicKey.export({ type: "spki", format: "pem" }).toString(),
			created: false,
		};
	}
	const generated = generateIdentity();
	mkdirSync(dirname(keyFile), { recursive: true });
	writeFileSync(keyFile, generated.privateKeyPem, { mode: 0o600 });
	try {
		chmodSync(keyFile, 0o600);
	} catch {}
	writeFileSync(`${keyFile}.pub`, generated.publicKeyPem);
	return { ...generated, created: true };
}

export function parsePublicKey(key: string | KeyObject): KeyObject {
	const publicKey = typeof key === "string" ? createPublicKey(key) : key;
	if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("Trusted peer key must be an Ed25519 public key");
	return publicKey;
}

/** Short human-comparable fingerprint of a public key (SHA-256 of its DER encoding). */
export function fingerprint(key: KeyObject): string {
	return createHash("sha256")
		.update(key.export({ type: "spki", format: "der" }))
		.digest("hex");
}

export type NetRole = "provide-stream" | "provide-search" | "accept-voice" | "delegate-voice" | "*";

export interface TrustedPeer {
	nodeId: string;
	/** Ed25519 public key (PEM or KeyObject). Pinned: a different key for this nodeId is rejected. */
	publicKey: string | KeyObject;
	/**
	 * What this peer is allowed to ask of us. Defaults to `["*"]` because listing a peer here is already an
	 * explicit decision; narrow it for least privilege.
	 */
	roles?: NetRole[];
}

export class TrustStore {
	private readonly peers = new Map<string, { publicKey: KeyObject; roles: Set<string> }>();

	constructor(peers: TrustedPeer[] = []) {
		for (const peer of peers) this.add(peer);
	}

	add(peer: TrustedPeer): void {
		if (!peer.nodeId) throw new TypeError("Trusted peer needs a nodeId");
		this.peers.set(peer.nodeId, { publicKey: parsePublicKey(peer.publicKey), roles: new Set(peer.roles ?? ["*"]) });
	}

	remove(nodeId: string): boolean {
		return this.peers.delete(nodeId);
	}

	has(nodeId: string): boolean {
		return this.peers.has(nodeId);
	}

	publicKey(nodeId: string): KeyObject | undefined {
		return this.peers.get(nodeId)?.publicKey;
	}

	hasRole(nodeId: string, role: NetRole): boolean {
		const roles = this.peers.get(nodeId)?.roles;
		return Boolean(roles && (roles.has("*") || roles.has(role)));
	}

	ids(): string[] {
		return [...this.peers.keys()];
	}
}
