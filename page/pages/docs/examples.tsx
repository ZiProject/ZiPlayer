import { DocsPage } from "@/components/DocsPage";

const code = `const player = await manager.create(message.guild.id);
await player.connect(message.member.voice.channel);
await player.play(query, message.author.id);

player.on("playerError", async (error) => {
  console.error(error);
  if (!player.queue.isEmpty) player.queue.skip();
});`;

export default function ExamplesDocs() {
	return (
		<DocsPage
			title='Practical'
			accent='Examples'
			description='Small, production-minded patterns for building Discord music bots with the ZiPlayer facade.'
			sections={[
				{
					title: "Basic command flow",
					description: "Create the guild player, connect to the member voice channel, and start playback.",
					code,
				},
				{
					title: "Recommended structure",
					description: "Keep Discord command handling at the edge and keep playback policy inside a small service.",
					bullets: [
						"One manager shared by the process",
						"One player per guild",
						"Plugins resolve sources",
						"Events update embeds and UI",
					],
				},
				{
					title: "Production checklist",
					description: "Before shipping, add permissions, error reporting, cleanup, and rate limits around commands.",
					bullets: [
						"Validate voice permissions",
						"Handle empty queues",
						"Log player and connection errors",
						"Use leaveTimeout for idle guilds",
					],
				},
			]}
			next={{ label: "Back to Getting Started", href: "/docs/getting-started" }}
		/>
	);
}
