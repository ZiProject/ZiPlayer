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
	pendingLeaves: Map<string, NodeJS.Timeout> = new Map();

	constructor(client: Client, config: AutoLeaveConfig) {
		super();
		this.client = client;
		this.config = { ...this.config, ...config };
		this.pendingLeaves = new Map();
	}

	active(alas: any): boolean {
		// Wire the player the first time we see it
		if (alas?.player && !this.player) this.player = alas.player as Player;
		const player = this.player;
		if (!player) return false;
		if (this.config.leaveAfterSeconds === undefined || this.config.leaveAfterSeconds <= 0) {
			return false;
		}
		// Avoid double-wiring
		const anyP = player as any;
		if (anyP.__autoLeaveWired) return true;
		anyP.__autoLeaveWired = true;

		this.client.on("voiceStateUpdate", (oldState, newState) => {
			// Check if the update is for the same guild as the player

			if (newState.guild.id !== player.guildId) return;

			const nonBotMembers = newState.channel?.members.filter((m) => !m.user.bot);
			// If there is a pending leave timeout and someone joined, clear it
			if (nonBotMembers && nonBotMembers.size === 0) {
				// No non-bot members left, leave the voice channel
				if (this.config.pauseOnEmpty && (this.config?.leaveAfterSeconds ?? 0) > 0 && !player.isPaused) {
					player.emit(
						"debug",
						`[AutoLeaveExt] Scheduling leave in ${this.config.leaveAfterSeconds} seconds for guild=${player.guildId} due to empty voice channel.`,
					);
					const timeout = setTimeout(
						() => {
							player.emit("debug", `[AutoLeaveExt] Leaving voice channel in guild=${player.guildId} due to empty voice channel.`);
							player.destroy();
							this.pendingLeaves.delete(player.guildId);
						},
						(this.config.leaveAfterSeconds ?? 0) * 1000,
					);
					this.pendingLeaves.set(player.guildId, timeout);
				}
			} else {
				// There are still non-bot members, clear any pending leave timeout
				const pendingTimeout = this.pendingLeaves.get(player.guildId);
				if (pendingTimeout) {
					player.emit(
						"debug",
						`[AutoLeaveExt] Clearing pending leave timeout for guild=${player.guildId} as members have joined.`,
					);
					clearTimeout(pendingTimeout);
					this.pendingLeaves.delete(player.guildId);
				}
			}
		});
		//clear timeout if someone joins

		return true;
	}
	onDestroy(context: ExtensionContext): void | Promise<void> {
		// Clean up any resources if necessary
		this.pendingLeaves.clear();
		return;
	}
}
