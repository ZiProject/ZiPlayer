import { DocsPage } from "@/components/DocsPage";

const code = `import { voiceExt, lyricsExt, lavalinkExt } from "@ziplayer/extension";

const manager = new PlayerManager({
  extensions: [
    new voiceExt(null, { lang: "en-US" }),
    new lyricsExt(null, { includeSynced: true }),
    new lavalinkExt(null, { /* server options */ }),
  ],
});`;

export default function ExtensionsDocs() {
	return (
		<DocsPage
			title='Composable'
			accent='Extensions'
			description='Add voice, lyrics, Lavalink, and application-specific behavior around the core lifecycle.'
			sections={[
				{
					title: "Voice and lyrics",
					description: "Use voice extensions for announcements and lyrics extensions for synced or plain text results.",
					bullets: ["Voice announcements", "Multi-language TTS", "Synced lyrics updates", "Track-start automation"],
				},
				{
					title: "Register extensions",
					description: "Extensions receive manager and player lifecycle hooks without changing the Player facade.",
					code,
				},
				{
					title: "Cleanup is explicit",
					description:
						"Destroying a player must release extension resources. Lavalink connections are closed and listeners are removed during teardown.",
					bullets: [
						"Implement active and inactive hooks",
						"Handle playerDestroy",
						"Avoid hidden reconnect loops",
						"Keep extension state scoped",
					],
				},
			]}
			next={{ label: "See Examples", href: "/docs/examples" }}
		/>
	);
}
