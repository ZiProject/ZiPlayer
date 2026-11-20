"use strict";

module.exports = function createVoiceHandoffCases({ zi, getPlayer }) {
	return {
		async handoff(message, nodeId) {
			if (!nodeId) return void (await message.reply("Usage: `handoff <node>`"));
			const player = await getPlayer(message);
			if (player.isPlaying) await player.stop();
			await zi.delegateVoice(player, nodeId.trim());
			await message.reply(`🔀 voice handed to **${nodeId.trim()}** (this bot keeps the gateway and the queue)`);
		},

		async reclaim(message) {
			const player = await getPlayer(message, { connect: false });
			if (!zi.delegationFor(message.guildId)) return void (await message.reply("Voice is not delegated."));
			await zi.reclaimVoice(player);
			await message.reply("🔙 voice is back on this bot");
		},
	};
};
