/**
 * What the node that owns the Discord gateway connection must provide. The owner receives the
 * bot's VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE and relays them to the node that does the audio.
 */
export interface GatewayLike {
	/** The bot's user id. */
	userId: string;
	/** Subscribes to the bot's voice events. `data` is the inner `d` of the gateway payload. */
	onVoiceUpdate(listener: (guildId: string, kind: "state" | "server", data: any) => void): () => void;
	/** Sends a raw gateway payload (only op 4 is ever relayed) on the right shard. */
	send(guildId: string, payload: unknown): void;
	/** Optional: resolve a channel object so the owner can reconnect locally on reclaim/failure. */
	resolveChannel?(guildId: string, channelId: string): any;
}

/** Gateway adapter for a discord.js v14 `Client`. */
export function discordJsGateway(client: any): GatewayLike {
	const voiceServers = new Map<string, any>();
	client.on("raw", (packet: any) => {
		if (packet?.t === "VOICE_SERVER_UPDATE" && packet.d?.guild_id) {
			voiceServers.set(String(packet.d.guild_id), packet.d);
		}
	});

	return {
		get userId() {
			return client.user?.id as string;
		},
		onVoiceUpdate(listener) {
			const handler = (packet: any) => {
				if (!packet?.d) return;
				if (packet.t === "VOICE_STATE_UPDATE" && packet.d.user_id === client.user?.id) {
					listener(String(packet.d.guild_id), "state", packet.d);
				} else if (packet.t === "VOICE_SERVER_UPDATE") {
					listener(String(packet.d.guild_id), "server", packet.d);
				}
			};
			client.on("raw", handler);
			// A hand-off may begin after the owner's initial join already delivered this gateway event.
			for (const [guildId, data] of voiceServers) listener(guildId, "server", data);
			return () => client.off("raw", handler);
		},
		send(guildId, payload) {
			const guild = client.guilds.cache.get(guildId);
			if (!guild) throw new Error(`Guild ${guildId} not cached`);
			guild.shard.send(payload);
		},
		resolveChannel(_guildId, channelId) {
			return client.channels.cache.get(channelId);
		},
	};
}
