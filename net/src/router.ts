/**
 * Route planning: decide, for a batch of tracks, whether to keep the voice here and pull audio from other
 * nodes ("relay"), or move the voice to the node that can play most of them itself ("handoff").
 *
 * Rule of thumb from the design discussion: if most tracks can only be resolved elsewhere (e.g. this node
 * only has SoundCloud and a 50-song YouTube playlist is added) moving the voice is cheaper than relaying
 * every packet; if only a few tracks are foreign, relaying them keeps the voice where it is.
 */
export interface RoutePeer {
	id: string;
	/** Plugin / source names the peer can resolve streams for (e.g. "youtube"). */
	sources: Iterable<string>;
	/** Optional load hint (lower is better), used to break ties. */
	load?: number;
}

export interface RouteTrack {
	source?: string;
}

export interface RoutePlan {
	mode: "local" | "relay" | "handoff";
	/** Handoff target. */
	executor?: string;
	/** For each track, the node that should resolve its stream. */
	owners: string[];
	/** Fraction of tracks this node cannot resolve itself. */
	foreignShare: number;
	/** Indices nobody can resolve. */
	unresolvable: number[];
}

export interface PlanRouteInput {
	selfId: string;
	selfSources: Iterable<string>;
	peers: RoutePeer[];
	tracks: RouteTrack[];
	/** Foreign share at or above which the voice is handed off. Default 0.5. */
	handoffThreshold?: number;
}

export function planRoute(input: PlanRouteInput): RoutePlan {
	const selfSources = new Set(input.selfSources);
	const peers = input.peers.map((p) => ({ ...p, set: new Set(p.sources) }));
	const tracks = input.tracks;
	const canSelf = (t: RouteTrack) => !t.source || selfSources.has(t.source);
	const canPeer = (p: { set: Set<string> }, t: RouteTrack) => !t.source || p.set.has(t.source);

	const foreign = tracks.map((t, i) => (canSelf(t) ? -1 : i)).filter((i) => i >= 0);
	const owners = tracks.map(() => input.selfId);
	const unresolvable: number[] = [];
	const share = tracks.length ? foreign.length / tracks.length : 0;
	if (foreign.length === 0) return { mode: "local", owners, foreignShare: 0, unresolvable };

	// Best single node for the foreign tracks (most coverage, then lowest load).
	const ranked = peers
		.map((p) => ({ p, covered: foreign.filter((i) => canPeer(p, tracks[i])).length }))
		.filter((x) => x.covered > 0)
		.sort((a, b) => b.covered - a.covered || (a.p.load ?? 0) - (b.p.load ?? 0));

	const pickFor = (i: number, preferred?: string): string | null => {
		const cands = peers.filter((p) => canPeer(p, tracks[i]));
		if (!cands.length) return null;
		return (cands.find((p) => p.id === preferred) ?? cands.sort((a, b) => (a.load ?? 0) - (b.load ?? 0))[0]).id;
	};

	const best = ranked[0];
	const threshold = input.handoffThreshold ?? 0.5;
	if (best && share >= threshold) {
		const executor = best.p.id;
		tracks.forEach((t, i) => {
			if (canPeer(best.p, t)) return void (owners[i] = executor);
			const other = canSelf(t) ? input.selfId : pickFor(i);
			if (other) owners[i] = other;
			else unresolvable.push(i);
		});
		return { mode: "handoff", executor, owners, foreignShare: share, unresolvable };
	}

	for (const i of foreign) {
		const owner = pickFor(i, best?.p.id);
		if (owner) owners[i] = owner;
		else unresolvable.push(i);
	}
	return { mode: "relay", owners, foreignShare: share, unresolvable };
}
