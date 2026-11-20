import { PassThrough } from "node:stream";
import { NetError, NetNode, type NetNodeOptions } from "./NetNode";
import { NetExtension } from "./ext/NetExtension";
import { StreamImporter, type StreamImporterOptions } from "./stream/StreamImporter";
import { StreamProvider, type ProvidedStreamInfo } from "./stream/StreamProvider";
import { RemoteVoiceHub, serializeTrack } from "./voice/RemoteVoice";
import { planRoute, type RoutePlan } from "./router";
import {
	dedupeNetTracks,
	DEFAULT_SEARCH_ALIASES,
	importWireResult,
	MAX_QUERY_CHARS,
	parseSearchQuery,
	toWireResult,
	type NetSearchOptions,
	type NetSearchResult,
	type ServeSearchOptions,
} from "./search";
import type { GatewayLike } from "./voice/Gateway";

export interface ZiNetOptions extends NetNodeOptions {
	/** The local PlayerManager (needed to provide streams and to accept voice). */
	manager?: any;
	/** Required on a node that hands voice off (it owns the Discord gateway). */
	gateway?: GatewayLike;
	importer?: StreamImporterOptions;
	/** Source (plugin) names this node can resolve. Defaults to the manager's registered plugin names. */
	sources?: string[];
	/** Extra / overriding query prefixes for `search()`: `{ ytm: "youtube" }` makes `ytm:lofi` search the youtube plugin. */
	searchAliases?: Record<string, string>;
}

export interface DelegateVoiceOptions {
	/** Channel object to reconnect locally if the hand-off fails or is reclaimed. Defaults to `gateway.resolveChannel`. */
	channel?: any;
	/**
	 * Where the executor gets audio: `"executor"` (default) resolves with its own plugins; `"owner"` pulls
	 * from this node, which must call `provideStreams()`. Tracks already marked with `markTrack` keep their owner.
	 */
	streamFrom?: "executor" | "owner";
}

interface Delegation {
	executor: string;
	channelId: string;
	channel: any;
	selfDeaf: boolean;
	selfMute: boolean;
	streamFrom: "executor" | "owner";
	stopRelay: () => void;
}

interface Execution {
	owner: string;
	cleanup: () => void;
}

export function markTrack<T extends { metadata?: Record<string, any> }>(track: T, ownerNodeId: string): T {
	track.metadata = { ...(track.metadata ?? {}), net: { ...(track.metadata?.net ?? {}), owner: ownerNodeId } };
	return track;
}

/**
 * High level entry point: wires a {@link NetNode} to a PlayerManager.
 *
 * - Owner streamInfo: `provideStreams()`; consumers just play tracks marked with `markTrack(track, nodeId)`.
 * - Owner connection: `player.connect()` as usual; `delegateVoice()` hands the voice session to another node.
 */
export class ZiNet {
	readonly node: NetNode;
	readonly importer: StreamImporter;
	readonly hub: RemoteVoiceHub;
	private provider?: StreamProvider;
	private readonly delegations = new Map<string, Delegation>();
	private readonly executions = new Map<string, Execution>();
	private readonly manager: any;
	private readonly gateway?: GatewayLike;
	private voiceAccepting = false;
	private searchProvider?: { allow?: ServeSearchOptions["allow"]; maxResults: number; maxResponseBytes: number };
	private readonly aliases: Record<string, string>;
	private allowVoice?: (guildId: string, from: string) => boolean | Promise<boolean>;

	constructor(private readonly options: ZiNetOptions) {
		this.node = new NetNode(options);
		this.aliases = { ...DEFAULT_SEARCH_ALIASES, ...(options.searchAliases ?? {}) };
		this.manager = options.manager;
		this.gateway = options.gateway;
		this.importer = new StreamImporter(this.node, options.importer);
		this.hub = new RemoteVoiceHub(this.node);
		this.node.onAudio((peerId, frame) => this.importer.onFrame(peerId, frame));
		this.node.on("peerOffline", (peerId: string) => this.onPeerGone(peerId));

		// Owner side: relayed gateway payloads from the executor.
		this.node.handle(
			"voice.payload",
			(body, ctx) => {
				const guildId = String(body?.guildId);
				const delegation = this.delegations.get(guildId);
				if (!delegation || delegation.executor !== ctx.from) throw new NetError("No delegation for this guild", "FORBIDDEN");
				const p = body?.payload;
				// Only a voice-state update for this very guild may reach the gateway.
				if (!p || p.op !== 4 || String(p.d?.guild_id) !== guildId) throw new NetError("Payload not allowed", "FORBIDDEN");
				this.gateway?.send(guildId, { op: 4, d: p.d });
			},
			{ role: "accept-voice" },
		);
		this.node.handle("player.event", (body, ctx) => this.onExecutorEvent(body, ctx.from), { role: "accept-voice" });
		this.node.handle("net.capabilities", () => ({
			sources: this.localSources(),
			players: this.manager?.getStats?.().players ?? 0,
			search: Boolean(this.searchProvider),
		}));
		this.node.handle("net.search", (body, ctx) => this.onSearch(body, ctx.from), { role: "provide-search" });
	}

	// ── capabilities & routing ───────────────────────────────────────────────

	private readonly capsCache = new Map<string, { at: number; sources: string[]; players: number; search?: boolean }>();

	localSources(): string[] {
		if (this.options.sources) return this.options.sources;
		const plugins = this.manager?.controllers?.plugin?.getPlugins?.() ?? [];
		return plugins.map((p: any) => String(p.name));
	}

	async peerCapabilities(peerId: string, maxAgeMs = 30_000) {
		const hit = this.capsCache.get(peerId);
		if (hit && Date.now() - hit.at < maxAgeMs) return hit;
		const caps = await this.node.request<{ sources: string[]; players: number; search?: boolean }>(
			peerId,
			"net.capabilities",
			undefined,
			{ timeoutMs: 5000 },
		);
		const entry = { at: Date.now(), sources: caps.sources ?? [], players: caps.players ?? 0, search: caps.search };
		this.capsCache.set(peerId, entry);
		return entry;
	}

	/**
	 * Plans where each track should be resolved and, with `apply` (default), marks tracks with their owner node
	 * and moves or reclaims the voice when the plan calls for it.
	 *
	 * - `relay`: voice stays here; foreign tracks are pulled from the node that can resolve them.
	 * - `handoff`: voice moves to the node that can play most tracks; others are pulled from their owners.
	 */
	async routeTracks(
		player: any,
		tracks: any[],
		options: { handoffThreshold?: number; apply?: boolean; peers?: string[]; delegate?: DelegateVoiceOptions } = {},
	): Promise<RoutePlan & { applied: boolean; error?: Error }> {
		const candidates = (options.peers ?? this.node.onlinePeers()).filter((id) => this.node.isOnline(id) || options.peers);
		const peers = (
			await Promise.all(
				candidates.map((id) =>
					this.peerCapabilities(id)
						.then((c) => ({ id, sources: c.sources, load: c.players }))
						.catch(() => null),
				),
			)
		).filter((p): p is { id: string; sources: string[]; load: number } => p !== null);

		const plan = planRoute({
			selfId: this.nodeId,
			selfSources: this.localSources(),
			peers,
			tracks,
			handoffThreshold: options.handoffThreshold,
		});
		if (options.apply === false) return { ...plan, applied: false };

		const resolvesItself = plan.mode === "handoff" ? plan.executor : this.nodeId;
		tracks.forEach((track, i) => {
			const owner = plan.owners[i];
			if (owner !== resolvesItself) markTrack(track, owner);
		});
		try {
			const delegated = Boolean(this.delegations.get(player.guildId));
			if (plan.mode === "handoff" && !delegated) await this.delegateVoice(player, plan.executor!, options.delegate);
			else if (plan.mode !== "handoff" && delegated) await this.reclaimVoice(player);
			return { ...plan, applied: true };
		} catch (error) {
			return { ...plan, applied: false, error: error as Error };
		}
	}

	get nodeId(): string {
		return this.node.nodeId;
	}

	start(): Promise<void> {
		return this.node.start();
	}

	async stop(): Promise<void> {
		this.provider?.closeAll();
		this.importer.closeAll();
		for (const g of [...this.delegations.keys()]) this.dropDelegation(g);
		for (const e of this.executions.values()) e.cleanup();
		this.executions.clear();
		await this.node.stop();
	}

	/** Extension class to pass in `manager.create(guild, { extensions: [net.extensionClass()] })`. */
	extensionClass(): new (player?: any) => NetExtension {
		const net = this;
		return class extends NetExtension {
			constructor(player?: any) {
				super(net, player ?? null);
			}
		};
	}

	// ── search ───────────────────────────────────────────────────────────────

	/**
	 * Serve search results from this node's plugins to trusted peers that hold the `provide-search` role
	 * (the default `*` role includes it). Opt-in, like `provideStreams()`.
	 */
	provideSearch(options: ServeSearchOptions = {}): void {
		if (!this.manager?.search) throw new Error("provideSearch() needs a PlayerManager with search()");
		this.searchProvider = {
			allow: options.allow,
			maxResults: Math.min(Math.max(Math.floor(options.maxResults ?? 25), 1), 100),
			maxResponseBytes: Math.max(Math.floor(options.maxResponseBytes ?? 200_000), 1_000),
		};
	}

	/**
	 * Searches across the cluster. Tracks found by another node come back already marked with that node as owner
	 * (`track.metadata.net.owner`), so `player.play(track)` pulls the audio from it.
	 *
	 * `yt:lofi`, `sc:…`, `sp:…`, `tts:…` target the node that has that plugin; anything else (a plain query or a URL)
	 * is tried on this node first and, if nothing is found, on every node that serves search.
	 */
	async search(text: string, options: NetSearchOptions = {}): Promise<NetSearchResult> {
		const raw = typeof text === "string" ? text.trim() : "";
		if (!raw) throw new NetError("Empty search query", "BAD_REQUEST");
		const { source, query } = parseSearchQuery(raw, this.aliases, options.source);
		const limit = Math.min(Math.max(Math.floor(options.limit ?? 10) || 10, 1), 100);
		const mode = options.local ?? "first";
		const canLocal = mode !== "never" && Boolean(this.manager?.search) && (!source || this.localSources().includes(source));
		const errors: Error[] = [];
		const fail = () => {
			const detail = [...new Set(errors.map((e) => e.message))].join("; ");
			return new NetError(`No results found for: ${raw}${detail ? ` (${detail})` : ""}`, "NO_RESULTS");
		};

		const local = async (): Promise<NetSearchResult> => {
			const r = await this.searchLocal(query, source, options.requestedBy);
			if (!r?.tracks?.length) throw new NetError(`No results found locally for: ${query}`, "NO_RESULTS");
			this.node.traceNote(`search "${query}": ${r.tracks.length} result(s) from local plugins`);
			return {
				tracks: r.tracks.slice(0, limit),
				playlist: r.playlist ?? null,
				query: r.query,
				source: r.source,
				node: this.nodeId,
				nodes: [this.nodeId],
			};
		};
		const peerIds = async () => (mode === "only" ? [] : await this.searchCandidates(source, options.peers));

		if (options.merge) {
			const ids = await peerIds();
			const jobs = [...(canLocal ? [local()] : []), ...ids.map((id) => this.searchOn(id, raw, options))];
			const settled = await Promise.allSettled(jobs);
			const ok: NetSearchResult[] = [];
			for (const r of settled) r.status === "fulfilled" ? ok.push(r.value) : errors.push(r.reason as Error);
			if (!ok.length) throw fail();
			const withPlaylist = ok.find((r) => r.playlist);
			if (withPlaylist) return withPlaylist;
			return {
				tracks: dedupeNetTracks(ok.flatMap((r) => r.tracks)).slice(0, limit),
				playlist: null,
				query: ok[0].query,
				source: ok[0].source,
				node: ok[0].node,
				nodes: [...new Set(ok.flatMap((r) => r.nodes))],
			};
		}

		const tryLocal = async () => {
			if (!canLocal) return null;
			try {
				return await local();
			} catch (error) {
				errors.push(error as Error);
				this.node.traceNote(`search "${query}": nothing from local plugins (${(error as Error).message})`);
				return null;
			}
		};
		const tryPeers = async () => {
			const ids = await peerIds();
			if (!ids.length) return null;
			const stop = new AbortController();
			const onAbort = () => stop.abort();
			if (options.signal?.aborted) stop.abort();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.any(ids.map((id) => this.searchOn(id, raw, { ...options, signal: stop.signal })));
			} catch (error) {
				errors.push(...(error instanceof AggregateError ? (error.errors as Error[]) : [error as Error]));
				return null;
			} finally {
				stop.abort(); // cancel the requests that lost the race
				options.signal?.removeEventListener("abort", onAbort);
			}
		};
		for (const step of mode === "last" ? [tryPeers, tryLocal] : [tryLocal, tryPeers]) {
			const result = await step();
			if (result) return result;
		}
		throw fail();
	}

	/** Searches on one specific node (it must run `provideSearch()` and trust this node). */
	async searchOn(peerId: string, text: string, options: NetSearchOptions = {}): Promise<NetSearchResult> {
		const { source, query } = parseSearchQuery(String(text ?? ""), this.aliases, options.source);
		if (!query) throw new NetError("Empty search query", "BAD_REQUEST");
		const limit = Math.min(Math.max(Math.floor(options.limit ?? 10) || 10, 1), 100);
		this.node.traceNote(`search "${query}" → ${peerId}${source ? ` (plugin ${source})` : ""}`, { peer: peerId });
		const raw = await this.node.request(
			peerId,
			"net.search",
			{ query, limit, plugins: source ? [source] : undefined },
			{ timeoutMs: options.timeoutMs, signal: options.signal },
		);
		const result = importWireResult(raw, peerId, options.requestedBy, limit);
		if (!result.tracks.length) throw new NetError(`No results found on ${peerId} for: ${query}`, "NO_RESULTS");
		this.node.traceNote(`search "${query}": ${result.tracks.length} result(s) from ${peerId}`, { peer: peerId });
		return { ...result, node: peerId, nodes: [peerId] };
	}

	private async searchCandidates(source: string | undefined, explicit?: string[]): Promise<string[]> {
		const ids = (explicit ?? this.node.onlinePeers()).filter((id) => id !== this.nodeId && (explicit || this.node.isOnline(id)));
		const caps = await Promise.all(
			ids.map((id) =>
				this.peerCapabilities(id)
					.then((c) => ({ id, ...c }))
					.catch(() => null),
			),
		);
		return caps
			.filter((c): c is NonNullable<typeof c> => c !== null)
			.filter((c) => c.search !== false && (!source || c.sources.includes(source)))
			.sort((a, b) => a.players - b.players)
			.map((c) => c.id);
	}

	/** Runs the query on this node's plugins. With a `plugins` filter it goes straight to the shared plugin manager. */
	private async searchLocal(query: string, source: string | undefined, requestedBy: unknown): Promise<any> {
		const who = typeof requestedBy === "string" ? requestedBy : ((requestedBy as any)?.id ?? "net");
		const pluginManager = source ? this.manager?.controllers?.plugin?.getSharedManager?.() : undefined;
		if (pluginManager?.search) {
			const result = await pluginManager.search(query, { requestedBy: String(who), plugins: [source] });
			if (!result?.tracks?.length) throw new NetError(`No results found for: ${query}`, "NO_RESULTS");
			return result;
		}
		return this.manager.search(query, requestedBy ?? "net");
	}

	private async onSearch(body: any, from: string) {
		const provider = this.searchProvider;
		if (!provider) throw new NetError("This node does not serve search", "NOT_PROVIDED");
		const query = typeof body?.query === "string" ? body.query.trim() : "";
		if (!query || query.length > MAX_QUERY_CHARS) throw new NetError("Invalid search query", "BAD_REQUEST");
		const plugins: string[] | undefined =
			Array.isArray(body?.plugins) ?
				body.plugins.filter((p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 64).slice(0, 8)
			:	undefined;
		const limit = Math.min(Math.max(Math.floor(Number(body?.limit)) || 10, 1), provider.maxResults);
		if (provider.allow && !(await provider.allow(query, from))) throw new NetError("Search refused", "FORBIDDEN");
		const source = plugins?.length === 1 ? plugins[0] : undefined;
		const result = await this.searchLocal(query, source, `net:${from}`);
		const wire = toWireResult(result, limit, provider.maxResponseBytes);
		this.node.traceNote(`search "${query}" from ${from}: answering ${wire.tracks.length} track(s)`, { peer: from });
		return wire;
	}

	// ── owner streamInfo ─────────────────────────────────────────────────────

	/** Serve streams resolved by this node's plugins to trusted peers that hold the `provide-stream` role. */
	provideStreams(options?: {
		allow?: (track: any, peerId: string) => boolean | Promise<boolean>;
		chunkBytes?: number;
	}): StreamProvider {
		if (!this.manager?.resolveStream) throw new Error("provideStreams() needs a PlayerManager with resolveStream()");
		this.provider = new StreamProvider(this.node, {
			resolveStream: (track, opts) => this.manager.resolveStream(track, opts) as Promise<ProvidedStreamInfo | null>,
			allow: options?.allow,
			chunkBytes: options?.chunkBytes,
			debug: this.options.debug,
		});
		return this.provider;
	}

	/** Open a remote stream as a ziplayer `StreamInfo`. */
	async openRemoteStream(ownerId: string, track: any, position = 0, signal?: AbortSignal) {
		const remote = await this.importer.open(ownerId, serializeTrack(track), { position, signal });
		return {
			stream: remote.stream,
			track,
			streamType: remote.streamType,
			type: remote.streamType,
			recreate: remote.recreate,
			// A network stream is single-use: never let the extension manager replay a consumed Readable.
			cacheable: false,
			metadata: { net: { owner: ownerId } },
		};
	}

	// ── owner connection → executor ──────────────────────────────────────────

	delegationFor(guildId: string): Delegation | undefined {
		return this.delegations.get(guildId);
	}

	/**
	 * Hands the player's Discord voice session to `executorId`. This node keeps the gateway and the queue; the
	 * executor joins voice (through a relay adapter) and plays. Call it while nothing is playing.
	 */
	async delegateVoice(player: any, executorId: string, options: DelegateVoiceOptions = {}): Promise<void> {
		const gateway = this.gateway;
		if (!gateway) throw new NetError("delegateVoice() needs a gateway (see discordJsGateway)", "NO_GATEWAY");
		const guildId: string = player.guildId;
		if (this.delegations.has(guildId)) throw new NetError("Voice already delegated for this guild", "ALREADY_DELEGATED");
		const connection = player.connection;
		if (!connection) throw new NetError("Player is not connected; call player.connect() first", "NOT_CONNECTED");
		if (player.isPlaying) throw new NetError("Stop playback before delegating voice", "BUSY");
		const channelId: string = connection.joinConfig.channelId;
		const channel = options.channel ?? gateway.resolveChannel?.(guildId, channelId);

		await this.node.ensureSession(executorId);
		const stopRelay = gateway.onVoiceUpdate((gid, kind, data) => {
			if (gid !== guildId) return;
			this.node.notify(executorId, "voice.event", { guildId, kind, data }).catch(() => {});
		});
		// Registered BEFORE the request: the executor's first gateway payload (join) arrives while it is still connecting.
		this.delegations.set(guildId, {
			executor: executorId,
			channelId,
			channel,
			selfDeaf: connection.joinConfig.selfDeaf,
			selfMute: connection.joinConfig.selfMute,
			streamFrom: options.streamFrom ?? "executor",
			stopRelay,
		});
		// Release our UDP connection WITHOUT leaving the Discord channel so the executor can take over.
		await player.disconnect({ silent: true });
		try {
			await this.node.request(
				executorId,
				"voice.delegate",
				{
					guildId,
					channelId,
					selfDeaf: connection.joinConfig.selfDeaf,
					selfMute: connection.joinConfig.selfMute,
					volume: player.volume,
				},
				{ timeoutMs: 30_000 },
			);
		} catch (error) {
			this.dropDelegation(guildId);
			if (channel) await player.connect(channel).catch(() => {});
			throw error;
		}
	}

	/** Takes the voice session back and reconnects locally. */
	async reclaimVoice(player: any, options: { channel?: any } = {}): Promise<void> {
		const guildId: string = player.guildId;
		const d = this.delegations.get(guildId);
		if (!d) return;
		const queuedTracks = player.queue?.getTracks?.() ?? [];
		const hadCurrentTrack = player.currentTrack != null;
		await this.node.request(d.executor, "voice.release", { guildId }, { timeoutMs: 10_000 }).catch(() => {});
		this.dropDelegation(guildId);
		try {
			player.exitRemoteMode?.();
		} catch {}
		if (hadCurrentTrack) {
			if (!(await player.stop())) throw new NetError("Could not clear remote playback while reclaiming voice", "STOP_FAILED");
			if (queuedTracks.length) player.queue.addMultiple(queuedTracks);
		}
		const channel = options.channel ?? d.channel;
		if (channel) {
			await this.leaveGatewayVoice(guildId, d);
			await player.connect(channel);
		}
	}

	private async leaveGatewayVoice(guildId: string, delegation: Delegation): Promise<void> {
		const gateway = this.gateway;
		if (!gateway) return;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let unsubscribe = () => {};
			const finish = (error?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				unsubscribe();
				if (error) reject(error);
				else resolve();
			};
			const timeout = setTimeout(
				() => finish(new NetError(`Timed out waiting for guild ${guildId} to leave voice before reclaim`, "VOICE_LEAVE_TIMEOUT")),
				5_000,
			);
			unsubscribe = gateway.onVoiceUpdate((eventGuildId, kind, data) => {
				if (eventGuildId === guildId && kind === "state" && data?.channel_id == null) finish();
			});
			try {
				gateway.send(guildId, {
					op: 4,
					d: {
						guild_id: guildId,
						channel_id: null,
						self_deaf: delegation.selfDeaf,
						self_mute: delegation.selfMute,
					},
				});
			} catch (error) {
				finish(error);
			}
		});
	}

	private dropDelegation(guildId: string) {
		const d = this.delegations.get(guildId);
		if (!d) return;
		d.stopRelay();
		this.delegations.delete(guildId);
	}

	/** Remote playback handle for a delegated player (same contract Lavalink uses). */
	buildRemoteStream(player: any, track: any) {
		const guildId: string = player.guildId;
		const d = this.delegations.get(guildId);
		if (!d) return null;
		const wire = serializeTrack(track);
		if (!wire.metadata?.net?.owner && d.streamFrom === "owner") markTrack(wire, this.nodeId);
		const cmd = (name: string, value?: unknown) =>
			this.node.request(d.executor, "player.cmd", { guildId, cmd: name, value }, { timeoutMs: 30_000 });
		const handle = {
			play: async () => void (await cmd("play", { track: wire, position: 0 })),
			pause: async () => void (await cmd("pause")),
			resume: async () => void (await cmd("resume")),
			stop: async () => {
				await cmd("stop");
				// Core only forwards stop() to the handle; leave REMOTE mode afterwards so the player is not left "playing".
				setImmediate(() => {
					try {
						if (this.delegations.has(guildId)) player.exitRemoteMode?.();
					} catch {}
				});
			},
			seek: async (position: number) => void (await cmd("seek", position)),
			setVolume: async (volume: number) => void (await cmd("volume", volume)),
			destroy: async () => void (await cmd("stop").catch(() => {})),
		};
		const dummy = new PassThrough();
		dummy.end();
		return { stream: dummy, track, streamType: "arbitrary", type: "arbitrary", remote: true, handle };
	}

	private onExecutorEvent(body: any, from: string) {
		const guildId = String(body?.guildId);
		const d = this.delegations.get(guildId);
		if (!d || d.executor !== from) return;
		const player = this.manager?.get?.(guildId);
		if (!player || player.destroyed) return;
		switch (body.type) {
			case "trackEnd": {
				const track = player.currentTrack;
				if (track) player.emit("trackEnd", track);
				if (body.reason === "finished" || body.reason === "error") void player.playNext?.().catch(() => {});
				break;
			}
			case "error":
				player.emit("playerError", new Error(String(body.message ?? "Remote playback error")), player.currentTrack);
				break;
		}
	}

	private onPeerGone(peerId: string) {
		// Executor vanished: take voice back so the guild is not left silent.
		for (const [guildId, d] of [...this.delegations]) {
			if (d.executor !== peerId) continue;
			const player = this.manager?.get?.(guildId);
			this.dropDelegation(guildId);
			try {
				player?.exitRemoteMode?.();
			} catch {}
			if (player && !player.destroyed && d.channel) void player.connect(d.channel).catch(() => {});
			player?.emit?.("debug", `[net] executor ${peerId} went offline; reclaimed voice for ${guildId}`);
		}
		for (const [guildId, e] of [...this.executions]) {
			if (e.owner !== peerId) continue;
			e.cleanup();
			this.executions.delete(guildId);
		}
	}

	// ── executor ─────────────────────────────────────────────────────────────

	/** Accept voice hand-offs from trusted owners that hold the `delegate-voice` role. */
	acceptVoice(options?: { allow?: (guildId: string, from: string) => boolean | Promise<boolean> }): void {
		if (!this.manager) throw new Error("acceptVoice() needs a PlayerManager");
		if (this.voiceAccepting) return;
		this.voiceAccepting = true;
		this.allowVoice = options?.allow;

		this.node.handle(
			"voice.event",
			(body, ctx) => {
				if (body?.kind !== "state" && body?.kind !== "server") return;
				this.hub.feed(String(body.guildId), ctx.from, body.kind, body.data);
			},
			{ role: "delegate-voice" },
		);

		this.node.handle("voice.delegate", (body, ctx) => this.onDelegate(body, ctx.from), { role: "delegate-voice" });

		this.node.handle(
			"voice.release",
			async (body, ctx) => {
				const guildId = String(body?.guildId);
				const e = this.executions.get(guildId);
				if (!e || e.owner !== ctx.from) return;
				await this.endExecution(guildId, true);
			},
			{ role: "delegate-voice" },
		);

		this.node.handle(
			"player.cmd",
			async (body, ctx) => {
				const guildId = String(body?.guildId);
				const e = this.executions.get(guildId);
				if (!e || e.owner !== ctx.from) throw new NetError("No execution for this guild", "FORBIDDEN");
				const player = this.manager.get(guildId);
				if (!player) throw new NetError("Player missing", "NO_PLAYER");
				switch (body.cmd) {
					case "play": {
						const track = body.value?.track;
						if (!track) throw new Error("Missing track");
						if (!(await player.play(track, { requestedBy: track.requestedBy ?? "net" })))
							throw new Error("Playback failed to start");
						return;
					}
					case "pause":
						return void (await player.pause());
					case "resume":
						return void (await player.resume());
					case "stop":
						return void (await player.stop());
					case "seek":
						return void (await player.seek(Number(body.value) || 0));
					case "volume":
						return void player.setVolume(Number(body.value));
					default:
						throw new Error(`Unknown command "${body.cmd}"`);
				}
			},
			{ role: "delegate-voice" },
		);
	}

	private async onDelegate(body: any, owner: string) {
		const guildId = String(body?.guildId);
		const channelId = String(body?.channelId);
		if (!guildId || !channelId) throw new Error("Missing guildId/channelId");
		if (this.allowVoice && !(await this.allowVoice(guildId, owner))) throw new NetError("Delegation refused", "FORBIDDEN");
		if (this.executions.has(guildId)) await this.endExecution(guildId, true);

		const player = await this.manager.create(guildId, {
			extensions: [this.extensionClass()],
			selfDeaf: body.selfDeaf,
			selfMute: body.selfMute,
		});
		const channel = this.hub.createChannel(guildId, channelId, owner);
		await player.connect(channel);
		if (typeof body.volume === "number") player.setVolume(body.volume);

		const report = (payload: Record<string, unknown>) =>
			this.node.notify(owner, "player.event", { guildId, ...payload }).catch(() => {});
		const onEnd = () => void report({ type: "trackEnd", reason: "finished" });
		const onError = (error: Error) => void report({ type: "error", message: error?.message });
		player.on("queueEnd", onEnd);
		player.on("trackEnd", onEnd);
		player.on("playerError", onError);
		this.executions.set(guildId, {
			owner,
			cleanup: () => {
				player.off("queueEnd", onEnd);
				player.off("trackEnd", onEnd);
				player.off("playerError", onError);
			},
		});
		return { ok: true };
	}

	private async endExecution(guildId: string, silent: boolean) {
		const e = this.executions.get(guildId);
		if (!e) return;
		e.cleanup();
		this.executions.delete(guildId);
		const player = this.manager.get(guildId);
		if (player) {
			// Do not leave the Discord channel: the owner is about to take the session back.
			await player.disconnect({ silent }).catch(() => {});
			await this.manager.destroy(guildId).catch(() => {});
		}
		this.hub.forget(guildId);
	}
}
