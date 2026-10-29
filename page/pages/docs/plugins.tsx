import { DocsPage } from "@/components/DocsPage";

const code = `import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin } from "@ziplayer/plugin";

const manager = new PlayerManager({
  plugins: [new YouTubePlugin(), new SoundCloudPlugin(), new SpotifyPlugin()],
});`;

export default function PluginsDocs() {
	return (
		<DocsPage
			title='Source'
			accent='Plugins'
			description='Resolve searches, URLs, playlists, and streams through a consistent plugin contract.'
			sections={[
				{
					title: "Built-in sources",
					description: "Register only the sources your application needs.",
					bullets: [
						"YouTube search and playlists",
						"SoundCloud tracks and playlists",
						"Spotify metadata and imports",
						"Custom APIs and direct streams",
					],
				},
				{ title: "Register plugins", description: "Plugins are passed to PlayerManager and selected during resolution.", code },
				{
					title: "Custom plugin contract",
					description:
						"Extend BasePlugin with a stable name, search, and stream resolver. Keep source-specific credentials and parsing inside the plugin.",
					bullets: [
						"search(query) returns Track[]",
						"getStream(url) returns a playable stream",
						"getPlaylist(url) is optional",
						"Keep network errors explicit",
					],
				},
			]}
			next={{ label: "Explore Extensions", href: "/docs/extensions" }}
		/>
	);
}
