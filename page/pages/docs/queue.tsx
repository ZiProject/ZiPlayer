import { DocsPage } from "@/components/DocsPage";

const code = `await player.queue.add(track, userId);
await player.queue.insert(track, 0, userId);
player.queue.remove(2);
player.queue.shuffle();
player.queue.loop("queue");
player.queue.autoPlay(true);

const current = player.queue.currentTrack;
const next = player.queue.nextTrack;`;

export default function QueueDocs() {
	return (
		<DocsPage
			title='Queue and'
			accent='Controls'
			description='Build predictable playback flows with queue mutation, navigation, looping, shuffle, and autoplay.'
			sections={[
				{
					title: "Queue operations",
					description: "Tracks are added after the active item and can be inserted at an upcoming position.",
					code,
				},
				{
					title: "Playback modes",
					description: "Use queue controls to shape the listening experience without reaching into the audio pipeline.",
					bullets: [
						"autoPlay(true) advances automatically",
						'loop("track") repeats the current track',
						'loop("queue") repeats the full queue',
						"shuffle() randomizes upcoming tracks",
					],
				},
				{
					title: "Useful state",
					description: "Read currentTrack, nextTrack, previousTracks, size, and isEmpty to render your own UI.",
					bullets: [
						"queueAdd and queueRemove for UI updates",
						"willPlay for preloading and announcements",
						"queueEnd for idle cleanup",
					],
				},
			]}
			next={{ label: "Read Events", href: "/docs/events" }}
		/>
	);
}
