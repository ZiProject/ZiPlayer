import { createCipheriv, createDecipheriv } from "node:crypto";

export class SessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionError";
	}
}

/** Wire kinds (first byte of every message). */
export const KIND = { HANDSHAKE: 1, CONTROL: 2, AUDIO: 3, AUDIO_ENCRYPTED: 4 } as const;

const TAG = 16;
const MAX_COUNTER = 2 ** 48;

/** Accepts each counter at most once inside a sliding window; tolerates reordering, rejects replays. */
export class ReplayWindow {
	private max = -1;
	private readonly seen = new Set<number>();
	constructor(private readonly size = 1024) {}

	accept(counter: number): boolean {
		if (counter <= this.max - this.size || this.seen.has(counter)) return false;
		this.seen.add(counter);
		if (counter > this.max) {
			this.max = counter;
			for (const old of this.seen) if (old <= this.max - this.size) this.seen.delete(old);
		}
		return true;
	}
}

function nonce(direction: number, channel: number, counter: number): Buffer {
	const n = Buffer.alloc(12);
	n[0] = direction;
	n[1] = channel;
	n.writeBigUInt64BE(BigInt(counter), 4);
	return n;
}

function aead(key: Buffer, n: Buffer, aad: Buffer, data: Buffer): Buffer {
	const c = createCipheriv("chacha20-poly1305", key, n, { authTagLength: TAG });
	c.setAAD(aad, { plaintextLength: data.length });
	return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}

function unaead(key: Buffer, n: Buffer, aad: Buffer, sealed: Buffer): Buffer {
	if (sealed.length < TAG) throw new SessionError("Message too short");
	try {
		const d = createDecipheriv("chacha20-poly1305", key, n, { authTagLength: TAG });
		d.setAAD(aad, { plaintextLength: sealed.length - TAG });
		d.setAuthTag(sealed.subarray(sealed.length - TAG));
		return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
	} catch {
		throw new SessionError("Message authentication failed");
	}
}

export interface SecureChannelOptions {
	/** Session lifetime; after this the node performs a fresh handshake (new keys). Default 6 h. */
	maxAgeMs?: number;
}

/**
 * Directional AEAD channel (ChaCha20-Poly1305). Header bytes are authenticated as AAD, nonces are
 * `direction | channel | 64-bit counter` and never reused, and a replay window rejects duplicates.
 *
 * Control frame: `[KIND.CONTROL][sid 8][counter 8][ciphertext+tag]`
 * Audio frame:   `[KIND.AUDIO_ENCRYPTED][sid 8][counter 8][streamId 4][seq 4][flags 1][ciphertext+tag]`
 */
export class SecureChannel {
	private sendCounter = 0;
	private audioSendCounter = 0;
	private readonly controlWindow = new ReplayWindow();
	private readonly audioWindow = new ReplayWindow(4096);
	readonly createdAt = Date.now();
	readonly maxAgeMs: number;
	private readonly sid: Buffer;
	private readonly sendDir: number;
	private readonly recvDir: number;
	closed = false;

	constructor(
		readonly sessionId: string,
		readonly peerId: string,
		initiator: boolean,
		private readonly sendKey: Buffer,
		private readonly recvKey: Buffer,
		options: SecureChannelOptions = {},
	) {
		this.sid = Buffer.from(sessionId, "hex");
		this.sendDir = initiator ? 1 : 2;
		this.recvDir = initiator ? 2 : 1;
		this.maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60 * 1000;
	}

	get expired(): boolean {
		return this.closed || Date.now() - this.createdAt > this.maxAgeMs;
	}

	seal(plaintext: Buffer): Buffer {
		if (this.sendCounter >= MAX_COUNTER) throw new SessionError("Session exhausted; re-handshake required");
		const counter = this.sendCounter++;
		const header = Buffer.alloc(17);
		header[0] = KIND.CONTROL;
		this.sid.copy(header, 1);
		header.writeBigUInt64BE(BigInt(counter), 9);
		return Buffer.concat([header, aead(this.sendKey, nonce(this.sendDir, 0, counter), header, plaintext)]);
	}

	open(frame: Buffer): Buffer {
		if (frame.length < 17 + TAG || frame[0] !== KIND.CONTROL) throw new SessionError("Malformed control frame");
		if (!frame.subarray(1, 9).equals(this.sid)) throw new SessionError("Session id mismatch");
		const counter = Number(frame.readBigUInt64BE(9));
		const header = frame.subarray(0, 17);
		const plaintext = unaead(this.recvKey, nonce(this.recvDir, 0, counter), header, frame.subarray(17));
		// Check the window only AFTER authentication so forged frames cannot burn counters.
		if (!this.controlWindow.accept(counter)) throw new SessionError("Replayed control frame");
		return plaintext;
	}

	sealAudio(streamId: number, seq: number, flags: number, payload: Buffer): Buffer {
		if (this.audioSendCounter >= MAX_COUNTER) throw new SessionError("Session exhausted; re-handshake required");
		const counter = this.audioSendCounter++;
		const header = Buffer.alloc(26);
		header[0] = KIND.AUDIO_ENCRYPTED;
		this.sid.copy(header, 1);
		header.writeBigUInt64BE(BigInt(counter), 9);
		header.writeUInt32BE(streamId >>> 0, 17);
		header.writeUInt32BE(seq >>> 0, 21);
		header[25] = flags & 0xff;
		return Buffer.concat([header, aead(this.sendKey, nonce(this.sendDir, 1, counter), header, payload)]);
	}

	openAudio(frame: Buffer): { streamId: number; seq: number; flags: number; payload: Buffer } {
		if (frame.length < 26 + TAG || frame[0] !== KIND.AUDIO_ENCRYPTED) throw new SessionError("Malformed audio frame");
		if (!frame.subarray(1, 9).equals(this.sid)) throw new SessionError("Session id mismatch");
		const counter = Number(frame.readBigUInt64BE(9));
		const header = frame.subarray(0, 26);
		const payload = unaead(this.recvKey, nonce(this.recvDir, 1, counter), header, frame.subarray(26));
		if (!this.audioWindow.accept(counter)) throw new SessionError("Replayed audio frame");
		return { streamId: header.readUInt32BE(17), seq: header.readUInt32BE(21), flags: header[25], payload };
	}
}
