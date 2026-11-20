/**
 * Debug trace of everything a {@link NetNode} puts on (or takes from) the broker.
 *
 * `node.on("debug", (event) => ...)` receives {@link NetDebugEvent}s on three layers:
 *
 * - `wire`: the exact MQTT message the broker sees: topic, qos, retain, size and the first bytes in hex.
 *   Control frames are ciphertext here, so this is what an attacker with broker access can read.
 * - `message`: the same traffic one level up, before it is encrypted / after it is decrypted: message type,
 *   request id, and body (sensitive keys redacted). This is "what net sends".
 * - `info`: free-form notes from routing code (for example which node a search was sent to).
 */
export type NetDebugLayer = "wire" | "message" | "info";
export type NetDebugKind = "presence" | "handshake" | "control" | "audio" | "audio-encrypted" | "unknown";

export interface NetDebugEvent {
	at: number;
	/** Node that emitted the event. */
	node: string;
	layer: NetDebugLayer;
	/** `out` = sent by this node, `in` = received, `info` = not a message. */
	dir: "out" | "in" | "info";
	kind?: NetDebugKind;
	/** wire: MQTT topic. */
	topic?: string;
	/** The other node, when known (recipient for `out`, sender for decrypted `in` messages). */
	peer?: string;
	qos?: number;
	retain?: boolean;
	/** Size of the MQTT payload (wire) or of the frame (message). */
	bytes?: number;
	/** wire: first bytes of the payload in hex. */
	hex?: string;
	/** True when the payload on the wire is ciphertext. */
	encrypted?: boolean;
	sessionId?: string;
	/** message: request/notify type (`net.search`, `voice.event`...), `reply` for replies, `hs1`/`hs2`/`hs3` for handshakes. */
	type?: string;
	/** message: request id. */
	id?: number;
	/** message: id of the request this replies to. */
	re?: number;
	/** message: decoded body (redacted copy). */
	body?: unknown;
	/** audio frames. */
	streamId?: number;
	seq?: number;
	flags?: number;
	/** info: text. */
	note?: string;
	/** wire: the publish failed. */
	error?: string;
}

const SENSITIVE_KEY = /token|secret|password|passwd|private|session_?id|authorization|cookie/i;
const MAX_DEPTH = 6;
const MAX_STRING = 300;
const MAX_ARRAY = 20;

/** Copy of `value` that is safe to print: sensitive keys hidden, long strings and arrays shortened. */
export function redact(value: unknown, depth = 0): unknown {
	if (typeof value === "string")
		return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
	if (value === null || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
	if (depth >= MAX_DEPTH) return "[…]";
	if (Array.isArray(value)) {
		const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
		return value.length > MAX_ARRAY ? [...head, `…(+${value.length - MAX_ARRAY} items)`] : head;
	}
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(v, depth + 1);
	}
	return out;
}

export function hexPreview(buf: Uint8Array, max = 24): string {
	const head = Buffer.from(buf.subarray(0, max)).toString("hex");
	return buf.length > max ? `${head}…` : head;
}

/** One-line, human readable rendering of a debug event. */
export function formatNetDebug(e: NetDebugEvent): string {
	const arrow =
		e.dir === "out" ? "→"
		: e.dir === "in" ? "←"
		: "•";
	if (e.layer === "info") return `[net:${e.node}] ${arrow} ${e.note ?? ""}`;
	if (e.layer === "wire") {
		const flags = `${e.qos !== undefined ? ` qos${e.qos}` : ""}${e.retain ? " retain" : ""}`;
		const detail =
			e.body !== undefined ? ` ${JSON.stringify(e.body)}`
			: e.type ? ` ${e.type}`
			: "";
		return (
			`[net:${e.node}] ${arrow} MQTT ${e.dir === "out" ? "PUBLISH" : "MESSAGE"} ${e.topic}${flags} ${e.bytes}B ` +
			`${e.kind}${e.encrypted ? "(encrypted)" : ""}${detail}${e.hex ? ` [${e.hex}]` : ""}${e.error ? ` FAILED: ${e.error}` : ""}`
		);
	}
	if (e.kind === "audio" || e.kind === "audio-encrypted") {
		return `[net:${e.node}] ${arrow} audio ${e.dir === "out" ? "to" : "from"} ${e.peer ?? "?"} stream#${e.streamId} seq ${e.seq} ${e.bytes}B${e.flags ? ` flags ${e.flags}` : ""}`;
	}
	const who = e.peer ? ` ${e.dir === "out" ? "to" : "from"} ${e.peer}` : "";
	const ref =
		e.re !== undefined ? ` re#${e.re}`
		: e.id !== undefined ? ` #${e.id}`
		: "";
	const body = e.body !== undefined ? ` ${JSON.stringify(e.body)}` : "";
	return `[net:${e.node}] ${arrow} ${e.kind ?? "msg"}${who} ${e.type ?? ""}${ref}${e.bytes !== undefined ? ` ${e.bytes}B` : ""}${body}`;
}
