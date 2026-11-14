import type { NetNode } from "../NetNode";

export interface RemoteVoiceChannel {
	id: string;
	guildId: string;
	type: 2;
	guild: { id: string; voiceAdapterCreator: (methods: any) => any };
}

interface Registered {
	methods: any;
	owner: string;
}

/**
 * Executor side of a voice hand-off. Builds a fake guild voice channel whose gateway adapter talks to the
 * owner over the network, so `player.connect(channel)` runs the normal @discordjs/voice machinery
 * (UDP, encryption, DAVE) on this node while the owner keeps the real Discord gateway.
 */
export class RemoteVoiceHub {
	private readonly adapters = new Map<string, Registered>();
	private readonly early = new Map<string, Array<{ kind: "state" | "server"; data: any }>>();

	constructor(private readonly node: NetNode) {}

	createChannel(guildId: string, channelId: string, ownerId: string): RemoteVoiceChannel {
		const adapterCreator = (methods: any) => {
			this.adapters.set(guildId, { methods, owner: ownerId });
			for (const e of this.early.get(guildId) ?? []) this.deliver(methods, e.kind, e.data);
			this.early.delete(guildId);
			return {
				sendPayload: (payload: unknown) => {
					this.node.notify(ownerId, "voice.payload", { guildId, payload }).catch(() => {});
					return true;
				},
				destroy: () => {
					if (this.adapters.get(guildId)?.methods === methods) this.adapters.delete(guildId);
				},
			};
		};
		return { id: channelId, guildId, type: 2, guild: { id: guildId, voiceAdapterCreator: adapterCreator } };
	}

	/** Feed a voice event relayed from the owner. Events arriving before the adapter exists are queued. */
	feed(guildId: string, from: string, kind: "state" | "server", data: any): void {
		const reg = this.adapters.get(guildId);
		if (reg) {
			if (reg.owner !== from) return;
			return this.deliver(reg.methods, kind, data);
		}
		const q = this.early.get(guildId) ?? [];
		if (q.length < 8) q.push({ kind, data });
		this.early.set(guildId, q);
	}

	owns(guildId: string): boolean {
		return this.adapters.has(guildId);
	}

	forget(guildId: string): void {
		this.adapters.delete(guildId);
		this.early.delete(guildId);
	}

	private deliver(methods: any, kind: "state" | "server", data: any) {
		if (kind === "state") methods.onVoiceStateUpdate(data);
		else methods.onVoiceServerUpdate(data);
	}
}

/** JSON-safe copy of a track (drops streams, functions and circular references such as Discord user objects). */
export function serializeTrack(track: any): any {
	const seen = new WeakSet<object>();
	return JSON.parse(
		JSON.stringify(track, (_key, value) => {
			if (typeof value === "function") return undefined;
			if (value && typeof value === "object") {
				if (seen.has(value)) return undefined;
				seen.add(value);
				if (typeof (value as any).pipe === "function") return undefined;
			}
			return typeof value === "bigint" ? value.toString() : value;
		}),
	);
}
