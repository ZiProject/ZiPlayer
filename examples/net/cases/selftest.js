"use strict";

module.exports = function createSelfTestCase({
	id,
	cfg,
	zi,
	manager,
	net,
	st,
	peers,
	ask,
	getPlayer,
	findTracks,
	waitStart,
	peerStatus,
	specFor,
	sleep,
	searchableSources,
}) {
	return async function selftest(message, argument) {
		const player = await getPlayer(message);
		// Start from a clean slate so prior playback cannot hide new stream pulls.
		await player.stop().catch(() => {});
		player.queue.clear?.();
		await sleep(1500);
		const lines = [];
		let failures = 0;
		const response = await message.reply("🧪 selftest running…");
		const flush = () => response.edit(lines.join("\n").slice(0, 1990) || "…").catch(() => {});
		const check = (name, passed, detail = "") => {
			if (!passed) failures++;
			lines.push(`${passed ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
			return flush();
		};
		const searchable = (node) => node.sources.filter((source) => searchableSources.includes(source));
		const localSource = searchable({ sources: zi.localSources() })[0];
		const foreignNode = peers.find((node) => searchable(node).some((source) => !zi.localSources().includes(source)));
		const foreignSource = foreignNode && searchable(foreignNode).find((source) => !zi.localSources().includes(source));

		try {
			for (const peer of peers) {
				const status = await peerStatus(peer.id).catch((error) => ({ error: error.message }));
				const expected = peer.sources.slice().sort().join(",");
				await check(
					`${peer.id} authenticated, plugins [${expected}]`,
					!status.error && status.sources.slice().sort().join(",") === expected,
					status.error || `got [${status.sources?.join(",")}]`,
				);
			}
			if (!foreignNode || !localSource) {
				await check("needs a searchable plugin on the bot and a different one on a provider", false, "adjust NODES");
			} else {
				const found = (await findTracks(`${foreignSource}:${specFor(foreignSource)}`, 3)).tracks;
				const foreignTrack = found[0];
				const resolvedBefore = (await peerStatus(foreignNode.id)).resolved;
				const bytesBefore = st.bytesIn;
				const since = Date.now();
				await player.play(net.markTrack({ ...foreignTrack }, foreignNode.id), { requestedBy: message.author.id });
				const started = await waitStart(message.guildId, since).catch(() => false);
				await sleep(500);
				await check(`stream: audio pulled from ${foreignNode.id}`, st.bytesIn > bytesBefore, `${st.bytesIn - bytesBefore} bytes`);
				await check(
					`stream: ${foreignNode.id} resolved it with its own ${foreignSource} plugin`,
					(await peerStatus(foreignNode.id)).resolved === resolvedBefore + 1,
				);
				await check("stream: trackStart on the bot", started === true);
				await player.stop();

				const localTrack = (await findTracks(`${localSource}:${specFor(localSource)}`, 1)).tracks[0];
				const list = (track, count, tag) =>
					Array.from({ length: count }, (_, index) => ({ ...track, id: `${track.id}#${tag}${index}` }));
				let plan = await zi.routeTracks(player, list(localTrack, 6, "a"), { handoffThreshold: cfg.handoffThreshold });
				await check("route: all local → local", plan.mode === "local", plan.mode);

				const mixed = [...list(localTrack, 9, "b"), ...list(foreignTrack, 1, "bf")];
				plan = await zi.routeTracks(player, mixed, { handoffThreshold: cfg.handoffThreshold });
				await check(
					"route: 1 foreign of 10 → relay",
					plan.mode === "relay" && mixed[9].metadata?.net?.owner === foreignNode.id,
					`${plan.mode}, owner ${mixed[9].metadata?.net?.owner}`,
				);

				plan = await zi.routeTracks(player, [...list(foreignTrack, 20, "c"), ...list(localTrack, 1, "cl")], {
					handoffThreshold: cfg.handoffThreshold,
				});
				await check(
					`route: 20 foreign of 21 → handoff to ${foreignNode.id}`,
					plan.mode === "handoff" && plan.applied,
					plan.error?.message || plan.mode,
				);
				if (plan.applied) {
					const executorStatus = await peerStatus(foreignNode.id);
					await check(`${foreignNode.id} executes this guild's voice`, executorStatus.executing.includes(message.guildId));
					const startedAt = Date.now();
					await player.play({ ...foreignTrack }, { requestedBy: message.author.id });
					const executorStarted = await (async () => {
						const end = Date.now() + 25_000;
						while (Date.now() < end) {
							if (
								(await peerStatus(foreignNode.id)).events.some(
									(event) => event.at >= startedAt && event.type === "trackStart" && event.guildId === message.guildId,
								)
							)
								return true;
							await sleep(500);
						}
						return false;
					})();
					await check(`track started on the executor ${foreignNode.id}, driven by the bot`, executorStarted);
					await player.stop().catch(() => {});
					await zi.reclaimVoice(player);
					await check("reclaim: voice is back on the bot", Boolean(player.connection) && !zi.delegationFor(message.guildId));
				}

				if (argument === "failover") {
					if (!cfg.allowRemoteKill) await check("failover needs ALLOW_REMOTE_KILL=1", false);
					else {
						await player.stop().catch(() => {});
						const failoverPlan = await zi.routeTracks(player, [...list(foreignTrack, 20, "f"), ...list(localTrack, 1, "fl")], {
							handoffThreshold: cfg.handoffThreshold,
						});
						if (!failoverPlan.applied) await check("failover: handoff established", false, failoverPlan.error?.message);
						else {
							await ask(foreignNode.id, "test.kill", undefined, 5000).catch(() => {});
							const end = Date.now() + 20_000;
							while (Date.now() < end && (zi.delegationFor(message.guildId) || !player.connection)) await sleep(250);
							await check(
								`failover: bot reclaimed the voice after ${foreignNode.id} crashed`,
								!zi.delegationFor(message.guildId) && Boolean(player.connection),
								`restart ${foreignNode.id} afterwards`,
							);
						}
					}
				}
			}
		} catch (error) {
			await check("selftest aborted", false, error.message);
		}

		lines.push(failures ? `\n**${failures} check(s) failed**` : "\n**all checks passed**");
		await flush();
	};
};
