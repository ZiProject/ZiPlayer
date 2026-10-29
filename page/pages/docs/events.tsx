import { DocsPage } from "@/components/DocsPage";

const code = `player.on("trackStart", (track) => renderNowPlaying(track));
player.on("trackEnd", (track) => logFinished(track));
player.on("queueAdd", (track) => updateQueue(track));
player.on("willPlay", (track, upcoming) => preload(track));
player.on("playerError", (error, track) => report(error, track));
player.on("connectionError", (error) => recover(error));`;

export default function EventsDocs() {
	return (
		<DocsPage
			title='Events and'
			accent='Listeners'
			description='Subscribe to playback, queue, lifecycle, and error events to keep your application state in sync.'
			sections={[
				{
					title: "Playback events",
					description: "Track start, end, pause, resume, and stop events map directly to UI state.",
					bullets: ["trackStart", "trackEnd", "playerPause and playerResume", "playerStop"],
				},
				{ title: "Queue and lifecycle", description: "Use queue events for notifications and willPlay for preloading.", code },
				{
					title: "Error recovery",
					description:
						"Keep failures observable and recoverable. Player errors can skip a failed track; connection errors can trigger a reconnect policy.",
					bullets: ["playerError", "connectionError", "queueEnd", "playerDestroy"],
				},
			]}
			next={{ label: "Explore Plugins", href: "/docs/plugins" }}
		/>
	);
}
