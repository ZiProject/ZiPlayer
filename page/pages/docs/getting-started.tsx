import { DocsPage } from "@/components/DocsPage";

const install = `npm install ziplayer @ziplayer/plugin @ziplayer/extension @discordjs/voice discord.js`;
const setup = `import { PlayerManager } from "ziplayer";
import { YouTubePlugin } from "@ziplayer/plugin";

const manager = new PlayerManager({ plugins: [new YouTubePlugin()] });
const player = await manager.create(guildId);
await player.connect(voiceChannel);
await player.play("Never Gonna Give You Up", userId);`;

export default function GettingStarted() {
	return (
		<DocsPage
			title='Get started with'
			accent='ZiPlayer'
			description='Install the event-driven audio engine, create one manager, and start playback in a Discord voice channel.'
			sections={[
				{
					title: "Install the runtime",
					description: "ZiPlayer targets Node.js 20.3+ and works with TypeScript projects.",
					code: install,
					bullets: ["Node.js 20.3 or newer", "TypeScript strict mode", "@discordjs/voice transport"],
				},
				{
					title: "Create a manager and player",
					description: "Keep one PlayerManager per process, then create a player for each guild.",
					code: setup,
				},
				{
					title: "Choose your next system",
					description: "Learn the public facade before extending the core.",
					bullets: [
						"Player and manager lifecycle",
						"Queue controls and repeat modes",
						"Event listeners and recovery",
						"Plugins and extensions",
					],
				},
			]}
			next={{ label: "Read Player API", href: "/docs/player" }}
		/>
	);
}
