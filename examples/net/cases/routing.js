"use strict";

function formatOwners(owners, localNodeId) {
	return Object.entries(
		owners.reduce((counts, owner) => ((counts[owner ?? localNodeId] = (counts[owner ?? localNodeId] || 0) + 1), counts), {}),
	)
		.map(([nodeId, count]) => `${nodeId}×${count}`)
		.join(", ");
}

module.exports = function createRoutingCase({ id, cfg, zi, getPlayer, findTracks, waitStart }) {
	return async function route(message, argument) {
		const parts = argument.split(/\s+/);
		const count = /^\d+$/.test(parts[parts.length - 1] ?? "") ? Number(parts.pop()) : 20;
		const query = parts.join(" ");
		if (!query) return void (await message.reply("Usage: `route yt:<query> [count]`"));
		const player = await getPlayer(message);
		const { tracks: found, node } = await findTracks(query, Math.min(count, 25));
		const tracks = Array.from({ length: count }, (_, index) => ({
			...found[index % found.length],
			id: `${found[index % found.length].id}#${index}`,
		}));
		const plan = await zi.routeTracks(player, tracks, { handoffThreshold: cfg.handoffThreshold });
		let reply = `**${plan.mode}**${plan.executor ? ` → ${plan.executor}` : ""} · tracks resolved on: ${formatOwners(plan.owners, id)} · applied: ${plan.applied}${plan.error ? ` (${plan.error.message})` : ""}`;
		if (plan.applied || plan.mode === "local") {
			const since = Date.now();
			await player.play(tracks[0], { requestedBy: message.author.id });
			player.queue.addMultiple(tracks.slice(1));
			const started = await waitStart(message.guildId, since).catch((error) => error.message);
			reply += ` · ${started === true ? "▶️ started" : `⚠️ ${started === false ? "no trackStart" : started}`} (source node: ${node})`;
		}
		await message.reply(reply);
	};
};
