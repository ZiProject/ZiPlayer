import type { StreamInfo, Track, TrackMiddleware, TrackMiddlewareContext } from "../types";
import type { PlaybackSession } from "./PlaybackSession";

export interface TrackLoaderContext extends TrackMiddlewareContext {}

export type TrackStreamResolver = (
	track: Track,
	session: PlaybackSession,
) => Promise<StreamInfo | null | undefined> | StreamInfo | null | undefined;

export interface TrackLoadResult {
	track: Track;
	stream: StreamInfo;
	sessionId: number;
}

export interface TrackLoaderOptions {
	middleware?: TrackMiddleware[];
	context: TrackLoaderContext;
	resolvers?: TrackStreamResolver[];
}

/**
 * Owns the track -> stream resolution pipeline.
 *
 * The loader deliberately knows nothing about Discord AudioPlayer or queue
 * mutation. Extensions/plugins are represented as resolvers so they can be
 * adapted without making the loader depend on concrete managers.
 */
export class TrackLoader {
	private readonly middleware: TrackMiddleware[];
	private readonly context: TrackLoaderContext;
	private readonly resolvers: TrackStreamResolver[];

	public constructor(options: TrackLoaderOptions) {
		this.middleware = [...(options.middleware ?? [])];
		this.context = options.context;
		this.resolvers = [...(options.resolvers ?? [])];
	}

	public addResolver(resolver: TrackStreamResolver): () => void {
		this.resolvers.push(resolver);
		return () => {
			const index = this.resolvers.indexOf(resolver);
			if (index >= 0) this.resolvers.splice(index, 1);
		};
	}

	public async load(track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		this.assertActive(session);

		for (const middleware of this.middleware) {
			this.assertActive(session);
			const result = await middleware(track, this.context);
			if (result && result !== track) Object.assign(track, result);
		}

		this.assertActive(session);

		for (const resolver of this.resolvers) {
			this.assertActive(session);
			const stream = await resolver(track, session);
			if (!stream) continue;

			this.assertActive(session);
			return {
				track,
				stream,
				sessionId: session.id,
			};
		}

		throw new Error(`No stream resolver could load track: ${track.title}`);
	}

	private assertActive(session: PlaybackSession): void {
		if (!session.isActive()) {
			throw new DOMException("Playback session is no longer active", "AbortError");
		}
	}
}
