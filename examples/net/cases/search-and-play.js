"use strict";

module.exports = function createSearchAndPlayCases({ id, net, zi, st, findTracks, getPlayer, waitStart }) {
	return {
		async search(message, query) {
			if (!query) return void (await message.reply("Usage: `search <query>` or `search yt:<query>`"));
			const { tracks, node, result } = await findTracks(query, 5);
			const lines = tracks.map(
				(track, index) =>
					`${index + 1}. **${track.title}** (${track.source}) · found on **${track.metadata?.net?.owner ?? id}**${track.duration ? ` · ${track.duration}s` : ""}`,
			);
			await message.reply(
				`${result.playlist ? `📃 playlist **${result.playlist.name}**\n` : ""}${lines.join("\n")}\n_(answered by ${node === id ? "this bot" : node})_`.slice(
					0,
					1990,
				),
			);
		},

		async play(message, query) {
			if (!query) return void (await message.reply("Usage: `play <query>` or `play yt:<query>`"));
			const player = await getPlayer(message);
			const { tracks, node } = await findTracks(query, 1);
			const track = tracks[0];
			if (node !== id) net.markTrack(track, node);
			const since = Date.now();
			const bytes0 = st.bytesIn;
			await player.play(track, { requestedBy: message.author.id });
			const delegation = zi.delegationFor(message.guildId);
			const started = await waitStart(message.guildId, since).catch((error) => error.message);
			const where = delegation ? `played by **${delegation.executor}**` : "played here";
			const from =
				node === id ? "found and resolved locally" : (
					`audio streamed from **${node}**${st.bytesIn > bytes0 ? ` (${st.bytesIn - bytes0} bytes)` : ""}`
				);
			await message.reply(
				`${started === true ? "▶️" : "⚠️"} **${track.title}** (${track.source}) · ${from} · ${where}${started === true ? "" : ` · not confirmed: ${started === false ? "no trackStart in 25s" : started}`}`,
			);
		},
	};
};
