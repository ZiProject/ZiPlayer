import { DocsPage } from "@/components/DocsPage";

const code = `const player = await manager.create(guildId, {
  leaveOnEnd: true,
  leaveTimeout: 30_000,
});

await player.connect(voiceChannel);
await player.play(query, userId);
player.pause();
player.resume();
player.setVolume(75);
player.destroy();`;

export default function PlayerDocs() {
	return (
		<DocsPage
			title='Player and'
			accent='Manager'
			description='The public facade for guild playback, lifecycle control, volume, and cleanup.'
			sections={[
				{
					title: "PlayerManager",
					description: "Create, retrieve, and destroy guild-scoped players from one process-wide manager.",
					bullets: [
						"One manager per process",
						"Plugin-first source resolution",
						"Shared defaults for every player",
						"Explicit cleanup with destroy()",
					],
				},
				{
					title: "Playback lifecycle",
					description: "Connect first, then use the player facade for everyday playback operations.",
					code,
				},
				{
					title: "Production guidance",
					description: "Treat the public API as the stable contract and keep controller internals inside core extensions.",
					bullets: [
						"Await connect and play",
						"Handle playerError and connectionError",
						"Use leaveTimeout to release idle voice connections",
						"Destroy players that are no longer needed",
					],
				},
			]}
			next={{ label: "Explore Queue", href: "/docs/queue" }}
		/>
	);
}
