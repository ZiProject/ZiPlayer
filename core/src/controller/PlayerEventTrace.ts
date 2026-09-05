import type { PlayerEvent } from "../structures/PlayerBus";

const sequenceByEvent = new WeakMap<object, number>();
let sequence = 0;

export interface PlayerEventTraceInfo {
	sequence: number;
	fingerprint: string;
}

export function traceEvent(event: PlayerEvent): PlayerEventTraceInfo {
	let id = sequenceByEvent.get(event as object);
	if (!id) {
		id = ++sequence;
		sequenceByEvent.set(event as object, id);
	}
	return { sequence: id, fingerprint: fingerprintEvent(event) };
}

export function describeEvent(event: PlayerEvent): Record<string, unknown> {
	const value = event as unknown as Record<string, any>;
	const session = value.session as any;
	const track = session?.track ?? value.track;
	const state = value.state;
	const queue = value.queue;

	return {
		sequence: traceEvent(event).sequence,
		type: event.type,
		requestId: value.requestId,
		sessionId: session?.id,
		status: session?.status,
		trackId: session?.track?.id ?? track?.id,
		track: session?.track?.title ?? track?.title,
		oldState: value.oldState?.status,
		newState: value.newState?.status,
		queueSize: Array.isArray(queue) ? queue.length : undefined,
		preloadTrackId: state?.requestedTrack?.id,
		preloadValid: state?.valid,
		reason: value.reason,
	};
}

function fingerprintEvent(event: PlayerEvent): string {
	const value = event as unknown as Record<string, any>;
	const session = value.session as any;
	switch (event.type) {
		case "queueChanged":
			return `queueChanged:${(value.queue ?? []).map((track: any) => track?.id).join(",")}`;
		case "stateChanged":
			return `stateChanged:${value.oldState?.status}->${value.newState?.status}`;
		case "volumeRequested":
			return `volumeRequested:${value.volume}`;
		case "TRACK_LOADING":
		case "TRACK_LOADED":
		case "TRACK_STARTED":
		case "TRACK_END":
		case "STREAM_ABORTED":
		case "playbackStateChanged":
		case "playbackSessionCreated":
		case "TRACK_ERROR":
		case "STUCK_DETECTED":
		case "RECOVERY_STARTED":
		case "RECOVERY_FAILED":
			return `${event.type}:${session?.id}:${session?.track?.id}`;
		case "trackRequested":
			return `trackRequested:${value.session?.id}:${value.track?.id}`;
		case "preloadStateChanged":
			return `preloadStateChanged:${value.state?.requestedTrack?.id}:${value.state?.valid}`;
		case "preloadPromoted":
			return `preloadPromoted:${value.track?.id}`;
		case "preloadCancelled":
		case "initialized":
		case "ready":
		case "destroyed":
			return event.type;
		case "willPlay":
			return `willPlay:${value.track?.id}`;
		case "queueEnd":
		case "playerStop":
		case "filtersCleared":
			return event.type;
		case "playerPause":
		case "playerResume":
			return `${event.type}:${value.track?.id}`;
		case "seek":
			return `seek:${value.track?.id}:${value.position}`;
		case "filterApplied":
		case "filterRemoved":
			return `${event.type}:${value.filter?.name ?? value.filter?.type ?? "unknown"}`;
		case "streamError":
			return `streamError:${value.track?.id}:${value.error?.message}`;
		case "forwardModeStart":
		case "forwardModeEnd":
			return `${event.type}:${value.leader?.guildId}:${value.reason ?? ""}`;
	}
}
