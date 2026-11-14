import { KIND } from "../crypto/session";

/** Plain (unencrypted) audio frame: `[KIND.AUDIO][sid 8][streamId 4][seq 4][flags 1][payload]`. */
export const AUDIO_FLAG_EOS = 0x01;
export const AUDIO_HEADER_BYTES = 18;

export interface AudioFrame {
	streamId: number;
	seq: number;
	flags: number;
	payload: Buffer;
}

export function encodePlainAudio(sessionId: string, frame: AudioFrame): Buffer {
	const header = Buffer.alloc(AUDIO_HEADER_BYTES);
	header[0] = KIND.AUDIO;
	Buffer.from(sessionId, "hex").copy(header, 1);
	header.writeUInt32BE(frame.streamId >>> 0, 9);
	header.writeUInt32BE(frame.seq >>> 0, 13);
	header[17] = frame.flags & 0xff;
	return Buffer.concat([header, frame.payload]);
}

export function decodePlainAudio(buf: Buffer): { sessionId: string; frame: AudioFrame } {
	if (buf.length < AUDIO_HEADER_BYTES || buf[0] !== KIND.AUDIO) throw new Error("Malformed audio frame");
	return {
		sessionId: buf.subarray(1, 9).toString("hex"),
		frame: {
			streamId: buf.readUInt32BE(9),
			seq: buf.readUInt32BE(13),
			flags: buf[17],
			payload: buf.subarray(AUDIO_HEADER_BYTES),
		},
	};
}

export function sessionIdOf(buf: Buffer): string | null {
	if (buf.length < 9) return null;
	return buf.subarray(1, 9).toString("hex");
}

/** Topic layout. Everything lives under `zi/v1/<network>`. */
export const topics = {
	presence: (net: string, node: string) => `zi/v1/${net}/presence/${node}`,
	presenceAll: (net: string) => `zi/v1/${net}/presence/+`,
	inbox: (net: string, node: string) => `zi/v1/${net}/node/${node}/in`,
	audio: (net: string, node: string) => `zi/v1/${net}/node/${node}/au`,
};
