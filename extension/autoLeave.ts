import { Client } from "discord.js";
import { BaseExtension, ExtensionContext, Player, PlayerManager, Track } from "ziplayer";
type AutoLeaveConfig = {
	leaveAfterSeconds?: number;
	pauseOnEmpty?: boolean;
};
export class AutoLeaveExt extends BaseExtension {
	name = "autoLeaveExtension";
	version = "1.0.0";
	player: Player | null = null;
	client: Client;
	config: AutoLeaveConfig = {
		leaveAfterSeconds: 0,
		pauseOnEmpty: true,
	};
	constructor(client: Client, config: AutoLeaveConfig) {
		super();
		this.client = client;
	}

	active(alas: any): boolean {
		// Wire the player the first time we see it
		if (alas?.player && !this.player) this.player = alas.player as Player;
		const player = this.player;
		if (!player) return false;

		// Avoid double-wiring
		const anyP = player as any;
		if (anyP.__autoLeaveWired) return true;
		anyP.__autoLeaveWired = true;

		this.client.on("voiceStateUpdate", (oldState, newState) => {
			// Check if the update is for the same guild as the player

			if (newState.guild.id !== player.guildId) return;

			const nonBotMembers = newState.channel?.members.filter((m) => !m.user.bot);
			if (nonBotMembers && nonBotMembers.size === 0) {
				// No non-bot members left, leave the voice channel
				if (this.config.pauseOnEmpty) {
					player.emit("debug", `[AutoLeaveExt] Left voice channel in guild=${player.guildId} due to no non-bot members.`);
					player.destroy();
				}
			}
		});

		return true;
	}
	onDestroy(context: ExtensionContext): void | Promise<void> {
		// Clean up any resources if necessary
		return;
	}
}
