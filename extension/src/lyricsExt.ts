import { BaseExtension, Player, PlayerManager, Track } from "ziplayer";
import axios from "axios";

/**
 * Configuration options for the lyrics extension.
 */
interface LyricsOptions {
	/** Lyrics provider to use (default: "lrclib") */
	provider?: "lrclib" | "lyricsovh";
	/** Whether to prefer LRC (synced) lyrics if available (default: true) */
	includeSynced?: boolean;
	/** Whether to automatically fetch lyrics when a track starts (default: true) */
	autoFetchOnTrackStart?: boolean;
	/** Whether to clean noisy suffixes from track titles (default: true) */
	sanitizeTitle?: boolean;
	/** Maximum length for lyrics text (default: 32000) */
	maxLength?: number;
}

/**
 * Result object containing lyrics information and metadata.
 */
export interface LyricsResult {
	/** The provider that supplied the lyrics */
	provider: "lrclib" | "lyricsovh";
	/** Human-readable source name */
	source?: string;
	/** Provider page URL if available */
	url?: string;
	/** Plain lyrics text */
	text?: string | null;
	/** LRC (synced) lyrics if available */
	synced?: string | null;
	/** Current line for per-line updates with synced lyrics */
	current?: string | null;
	/** Previous line for per-line updates */
	previous?: string | null;
	/** Next line for per-line updates */
	next?: string | null;
	/** Current line index for synced lyrics */
	lineIndex?: number;
	/** Current time in milliseconds for synced lyrics */
	timeMs?: number;
	/** Track name as matched by the provider */
	trackName?: string;
	/** Artist name as matched by the provider */
	artistName?: string;
	/** Album name as matched by the provider */
	albumName?: string;
	/** How the match was made (e.g., "exact", "fuzzy") */
	matchedBy?: string;
	/** Language of the lyrics if detected */
	lang?: string | null;
}

type LyricsLine = { timeMs: number; text: string };

interface LyricsSchedule {
	timer: NodeJS.Timeout | null;
	startAt: number;
	pausedAt?: number;
	pausedDuration: number;
	lines: LyricsLine[];
	nextIndex: number;
	result: LyricsResult;
}

interface LyricsPlayerBinding {
	manager?: PlayerManager;
	listeners: {
		trackStart: (track: Track) => void;
		playerPause: () => void;
		playerResume: () => void;
		trackEnd: () => void;
		playerDestroy: () => void;
	};
}

/**
 * Lyrics extension for ZiPlayer that provides automatic lyrics fetching and synchronization.
 *
 * This extension automatically fetches and displays lyrics for playing tracks by:
 * - Fetching lyrics from multiple providers (LRCLIB, Lyrics.ovh)
 * - Supporting both plain text and LRC (synchronized) lyrics
 * - Providing real-time line-by-line updates for synced lyrics
 * - Automatically cleaning and sanitizing track titles for better matching
 * - Emitting events for lyrics creation and updates
 *
 * @example
 * const lyricsExt = new lyricsExt(null, {
 *   provider: "lrclib",
 *   includeSynced: true,
 *   autoFetchOnTrackStart: true
 * });
 *
 * // Add to PlayerManager
 * const manager = new PlayerManager({
 *   extensions: [lyricsExt]
 * });
 *
 * // Listen for lyrics events
 * manager.on("lyricsCreate", (player, track, lyrics) => {
 *   console.log(`Lyrics for ${track.title}: ${lyrics.text}`);
 * });
 *
 * manager.on("lyricsChange", (player, track, lyrics) => {
 *   console.log(`Current line: ${lyrics.current}`);
 * });
 *
 * @since 1.0.0
 */
export class lyricsExt extends BaseExtension {
	name = "lyricsExt";
	version = "1.0.0";
	player: Player | null = null;
	private readonly bindings = new Map<Player, LyricsPlayerBinding>();

	private options: LyricsOptions;
	private schedules = new Map<string, LyricsSchedule>();

	/**
	 * Creates a new lyrics extension instance.
	 *
	 * @param player - The player instance to attach to (optional, can be set later)
	 * @param opts - Configuration options for lyrics fetching
	 * @param opts.provider - Lyrics provider to use (default: "lrclib")
	 * @param opts.includeSynced - Whether to prefer LRC lyrics (default: true)
	 * @param opts.autoFetchOnTrackStart - Auto-fetch on track start (default: true)
	 * @param opts.sanitizeTitle - Clean track titles (default: true)
	 * @param opts.maxLength - Maximum lyrics length (default: 32000)
	 *
	 * @example
	 * const lyricsExt = new lyricsExt(null, {
	 *   provider: "lrclib",
	 *   includeSynced: true,
	 *   autoFetchOnTrackStart: true,
	 *   sanitizeTitle: true,
	 *   maxLength: 50000
	 * });
	 */
	constructor(player: Player | null = null, opts?: Partial<LyricsOptions>) {
		super();
		this.player = player;
		this.options = {
			provider: "lrclib",
			includeSynced: true,
			autoFetchOnTrackStart: true,
			sanitizeTitle: true,
			maxLength: 32_000,
			...opts,
		} as LyricsOptions;
	}

	/**
	 * Activates the lyrics extension with the provided context.
	 *
	 * This method handles the activation process:
	 * - Sets up the player and manager references
	 * - Attaches track start event listeners for automatic lyrics fetching
	 * - Sets up cleanup handlers for track end and player destroy events
	 *
	 * @param alas - Context object containing manager and player references
	 * @returns `true` if activation was successful, `false` otherwise
	 *
	 * @example
	 * const success = lyricsExt.active({
	 *   manager: playerManager,
	 *   player: playerInstance
	 * });
	 */
	active(alas: any): boolean {
		const player = (alas?.player as Player | undefined) ?? this.player;
		const manager = alas?.manager as PlayerManager | undefined;
		if (!player) return false;
		this.player = player;

		if (this.options.autoFetchOnTrackStart && !this.bindings.has(player)) {
			this.debug(`Wiring trackStart for guild=${player.guildId}`);
			let binding: LyricsPlayerBinding;
			const listeners: LyricsPlayerBinding["listeners"] = {
				trackStart: (track) => void this.handleTrackStart(player, binding, track),
				playerPause: () => {
					this.debug("playerPause: pausing lyrics sync");
					this.pauseLineSchedule(player);
				},
				playerResume: () => {
					this.debug("playerResume: resuming lyrics sync");
					this.resumeLineSchedule(player);
				},
				trackEnd: () => {
					this.debug("trackEnd: clearing line schedule");
					this.clearLineSchedule(player);
				},
				playerDestroy: () => this.cleanupPlayer(player),
			};
			binding = { manager, listeners };
			this.bindings.set(player, binding);
			player.on("trackStart", listeners.trackStart);
			player.on("playerPause", listeners.playerPause);
			player.on("playerResume", listeners.playerResume);
			player.on("trackEnd", listeners.trackEnd);
			player.on("playerDestroy", listeners.playerDestroy);
		}

		return true;
	}

	onDestroy(context: { player?: Player | null; playerId: string }): void {
		const player = context.player ?? [...this.bindings.keys()].find((candidate) => candidate.playerId === context.playerId);
		if (player) this.cleanupPlayer(player);
	}

	private async handleTrackStart(player: Player, binding: LyricsPlayerBinding, track: Track): Promise<void> {
		const startedAt = Date.now();
		this.debug(`trackStart: ${track?.title ?? "<unknown>"} @${startedAt}`);
		try {
			const res = await this.fetch(track).catch(() => undefined);
			if (!res || this.bindings.get(player) !== binding || player.destroyed) return;

			track.metadata = track.metadata || {};
			(track.metadata as any).lyrics = {
				text: res.text ?? undefined,
				synced: res.synced ?? undefined,
				provider: res.provider,
				url: res.url,
				source: res.source,
			};

			this.debug(`fetched provider=${res.provider} synced=${!!res.synced} textLen=${res.text?.length ?? 0}`);
			if (binding.manager && typeof (binding.manager as any).emit === "function") {
				binding.manager.emit("lyricsCreate", player, track, res);
				binding.manager.emit("lyricsChange", player, track, res);
			} else {
				(player as any)?.emit?.("lyricsCreate", track, res);
				(player as any)?.emit?.("lyricsChange", track, res);
			}

			if (res.synced) this.startLineSchedule(player, track, res, res.synced, startedAt);
		} catch (e: any) {
			this.debug(`lyrics error: ${e?.message || e}`);
		}
	}

	private cleanupPlayer(player: Player): void {
		const binding = this.bindings.get(player);
		if (binding) {
			player.off("trackStart", binding.listeners.trackStart);
			player.off("playerPause", binding.listeners.playerPause);
			player.off("playerResume", binding.listeners.playerResume);
			player.off("trackEnd", binding.listeners.trackEnd);
			player.off("playerDestroy", binding.listeners.playerDestroy);
			this.bindings.delete(player);
		}
		this.clearLineSchedule(player);
		if (this.player === player) this.player = [...this.bindings.keys()].at(-1) ?? null;
	}

	/**
	 * Fetches lyrics for a given track.
	 *
	 * This method attempts to fetch lyrics from configured providers:
	 * - First tries LRCLIB with artist and title
	 * - Falls back to LRCLIB with title only if no results
	 * - Finally tries Lyrics.ovh as a last resort
	 * - Supports both plain text and LRC (synchronized) lyrics
	 *
	 * @param track - The track to fetch lyrics for (uses current track if not provided)
	 * @param override - Options to override for this specific fetch (optional)
	 * @returns Lyrics result object, or null if no lyrics found
	 *
	 * @example
	 * const lyrics = await lyricsExt.fetch(track, {
	 *   provider: "lrclib",
	 *   includeSynced: true
	 * });
	 *
	 * if (lyrics) {
	 *   console.log(`Found ${lyrics.provider} lyrics: ${lyrics.text}`);
	 *   if (lyrics.synced) {
	 *     console.log("Synced lyrics available!");
	 *   }
	 * }
	 */
	async fetch(track?: Track, override?: Partial<LyricsOptions>): Promise<LyricsResult | null> {
		const use: LyricsOptions = { ...this.options, ...(override || {}) } as LyricsOptions;
		if (!track) track = this.player?.currentTrack ?? (undefined as any);
		if (!track) return null;

		// Extract best guess for artist/title
		const rawTitle = String(track.title || "");
		const author = (track.metadata as any)?.author as string | undefined;
		const { title, artist } = this.deriveArtistAndTitle(rawTitle, author);
		this.debug("Fetch Lyrics for: " + title);

		try {
			const lr = await this.queryLRCLIB({
				title,
				artist,
				duration: this.normalizeDuration(track.duration),
				includeSynced: !!use.includeSynced,
			});

			let primary = lr;
			// Fallback: LRCLIB without artist if none found and we had artist
			if (!primary && artist) {
				this.debug(`lrclib: retry without artist for title="${title}"`);
				primary = await this.queryLRCLIB({
					title,
					includeSynced: !!use.includeSynced,
					duration: this.normalizeDuration(track.duration),
				});
			}

			if (primary) {
				// Trim if needed
				const cut = (s?: string | null) =>
					use.maxLength && s && s.length > use.maxLength ? s.slice(0, use.maxLength) : (s ?? null);

				const result: LyricsResult = {
					provider: "lrclib",
					source: "LRCLIB",
					url: "https://lrclib.net/",
					text: cut(primary.plainLyrics || primary.syncedLyrics?.replace(/\n\[[0-9:.]+\].*/g, "")),
					synced: use.includeSynced ? cut(primary.syncedLyrics) : null,
					trackName: primary.trackName || title,
					artistName: primary.artistName || artist,
					albumName: primary.albumName,
					matchedBy: primary.matchedBy,
					lang: primary.language || null,
				};
				return result;
			}
		} catch (e: any) {
			this.debug(`lrclib fetch failed: ${e?.message || e}`);
		}

		// Fallback: lyrics.ovh (plain lyrics only)
		try {
			this.debug(`lyrics.ovh: query artist="${artist ?? ""}" title="${title}"`);
			const text = await this.queryLyricsOVH({ artist, title });
			if (text) {
				const cut = (s?: string | null) =>
					use.maxLength && s && s.length > use.maxLength ? s.slice(0, use.maxLength) : (s ?? null);
				return {
					provider: "lyricsovh",
					source: "Lyrics.ovh",
					url: `https://api.lyrics.ovh/v1/${encodeURIComponent(artist || "")}/${encodeURIComponent(title)}`,
					text: cut(text),
					synced: null,
					trackName: title,
					artistName: artist,
					albumName: undefined,
					matchedBy: undefined,
					lang: null,
				};
			}
		} catch (e: any) {
			this.debug(`lyrics.ovh fetch failed: ${e?.message || e}`);
		}

		return null;
	}

	// --- Scheduling per-line updates ---
	private startLineSchedule(player: Player, _track: Track, result: LyricsResult, lrc: string, startedAt: number) {
		if (!lrc) return;
		const guildId = player.guildId;
		this.clearLineSchedule(player);
		const lines = this.parseLRC(lrc);
		if (!lines.length) {
			this.debug("parseLRC: no timed lines");
			return;
		}
		const schedule: LyricsSchedule = {
			timer: null,
			startAt: startedAt,
			pausedDuration: 0,
			lines,
			nextIndex: 0,
			result,
		};
		this.schedules.set(guildId, schedule);
		this.debug(`schedule: ${lines.length} lines; startAt=${startedAt}`);

		// Emit immediate line if already passed due to fetch delay
		const elapsed = Date.now() - startedAt;
		let currentIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].timeMs <= elapsed) currentIdx = i;
			else break;
		}
		if (currentIdx >= 0) {
			this.debug(`immediate emit at idx=${currentIdx} (elapsed=${elapsed}ms)`);
			this.emitLineAtIndex(player, lines, currentIdx, result);
			schedule.nextIndex = currentIdx + 1;
		}
		this.scheduleNextLine(player, schedule);
	}

	private pauseLineSchedule(player: Player) {
		const sched = this.schedules.get(player.guildId);
		if (!sched) return;

		if (sched.timer) clearTimeout(sched.timer);
		sched.timer = null;
		sched.pausedAt = Date.now();
		this.debug(`paused lyrics sync at=${sched.pausedAt}`);
	}

	private resumeLineSchedule(player: Player) {
		const sched = this.schedules.get(player.guildId);
		if (!sched || sched.pausedAt === undefined) return;

		sched.pausedDuration += Date.now() - sched.pausedAt;
		sched.pausedAt = undefined;
		const elapsed = Date.now() - sched.startAt - sched.pausedDuration;
		let currentIdx = -1;
		for (let i = 0; i < sched.lines.length; i++) {
			if (sched.lines[i].timeMs <= elapsed) currentIdx = i;
			else break;
		}

		if (currentIdx >= sched.nextIndex) {
			this.debug(`resume emit at idx=${currentIdx} (elapsed=${elapsed}ms)`);
			this.emitLineAtIndex(player, sched.lines, currentIdx, sched.result);
			sched.nextIndex = currentIdx + 1;
		}
		this.scheduleNextLine(player, sched);
	}

	private scheduleNextLine(player: Player, sched: LyricsSchedule): void {
		if (this.schedules.get(player.guildId) !== sched || player.destroyed || sched.pausedAt !== undefined) return;
		const line = sched.lines[sched.nextIndex];
		if (!line) {
			this.schedules.delete(player.guildId);
			return;
		}

		const elapsed = Date.now() - sched.startAt - sched.pausedDuration;
		sched.timer = setTimeout(
			() => {
				sched.timer = null;
				if (this.schedules.get(player.guildId) !== sched) return;
				const index = sched.nextIndex++;
				this.emitLineAtIndex(player, sched.lines, index, sched.result);
				this.scheduleNextLine(player, sched);
			},
			Math.max(0, line.timeMs - elapsed),
		);
	}

	private emitLineAtIndex(player: Player, lines: LyricsLine[], idx: number, result?: LyricsResult): void {
		const prev = idx > 0 ? lines[idx - 1] : undefined;
		const curr = lines[idx];
		const next = idx + 1 < lines.length ? lines[idx + 1] : undefined;

		// Get current track
		const track = player.currentTrack;
		if (!track) return;

		const payload: LyricsResult = {
			...(result || {
				provider: "lrclib",
				source: "LRCLIB",
				url: "https://lrclib.net/",
			}),
			current: curr?.text ?? null,
			previous: prev?.text ?? null,
			next: next?.text ?? null,
			text: curr?.text ?? null,
			lineIndex: idx,
			timeMs: curr?.timeMs ?? 0,
		};

		this.debug(`emit line idx=${idx} t=${curr?.timeMs} "${this.trunc(curr?.text || "", 80)}"`);
		const manager = this.bindings.get(player)?.manager;
		if (manager && typeof (manager as any).emit === "function") {
			manager.emit("lyricsChange", player, track, payload);
		} else {
			(player as any)?.emit?.("lyricsChange", track, payload);
		}
	}

	private clearLineSchedule(player: Player) {
		const sched = this.schedules.get(player.guildId);
		if (!sched) return;
		if (sched.timer) clearTimeout(sched.timer);
		this.debug(`cleared timer=${sched.timer ? 1 : 0}`);
		this.schedules.delete(player.guildId);
	}

	private parseLRC(input: string): { timeMs: number; text: string }[] {
		const lines = input.split(/\r?\n/);
		const out: { timeMs: number; text: string }[] = [];
		const tag = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
		for (const raw of lines) {
			if (!raw) continue;
			let m: RegExpExecArray | null;
			let lastIndex = 0;
			const times: number[] = [];
			while ((m = tag.exec(raw))) {
				lastIndex = tag.lastIndex;
				const min = parseInt(m[1] || "0", 10);
				const sec = parseInt(m[2] || "0", 10);
				const frac = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) : 0;
				times.push(min * 60_000 + sec * 1_000 + frac);
			}
			tag.lastIndex = 0;
			const text = raw.slice(lastIndex).trim();
			if (!times.length || !text) continue;
			for (const t of times) out.push({ timeMs: t, text });
		}
		out.sort((a, b) => a.timeMs - b.timeMs);
		return out;
	}

	private trunc(s: string, n = 60): string {
		if (!s) return "";
		return s.length > n ? s.slice(0, n) + "..." : s;
	}

	// --- Providers ---
	private async queryLRCLIB(input: {
		title: string;
		artist?: string;
		duration?: number | null; // seconds
		includeSynced: boolean;
	}): Promise<null | {
		trackName?: string;
		artistName?: string;
		albumName?: string;
		language?: string | null;
		matchedBy?: string;
		plainLyrics?: string | null;
		syncedLyrics?: string | null;
	}> {
		const params: Record<string, string> = {};
		if (input.title) params["track_name"] = input.title;
		if (input.artist) params["artist_name"] = input.artist;
		if (typeof input.duration === "number" && Number.isFinite(input.duration)) {
			params["duration"] = String(Math.round(input.duration));
		}

		const qs = new URLSearchParams(params).toString();
		const url = `https://lrclib.net/api/search?${qs}`;
		const res = await axios.get(url, { timeout: 10_000 }).then((r) => r.data as any[]);

		const items: any[] = Array.isArray(res) ? res : [];
		if (!items.length) {
			// Fallback: fuzzy q
			const q = [input.artist, input.title].filter(Boolean).join(" ");
			if (!q) return null;
			const fuzzy = await axios
				.get(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { timeout: 10_000 })
				.then((r) => r.data as any[])
				.catch(() => []);
			if (!fuzzy?.length) return null;
			return this.pickBest(fuzzy, !!input.includeSynced);
		}

		return this.pickBest(items, !!input.includeSynced);
	}

	private pickBest(items: any[], preferSynced: boolean) {
		if (!items?.length) return null;
		// Prefer exacts with synced, else first with plain
		let best = items[0];
		if (preferSynced) {
			const withSynced = items.find((i) => !!i?.syncedLyrics);
			if (withSynced) best = withSynced;
		}
		return {
			trackName: best?.trackName ?? best?.track_name,
			artistName: best?.artistName ?? best?.artist_name,
			albumName: best?.albumName ?? best?.album_name,
			language: best?.language ?? best?.lang ?? null,
			matchedBy: best?.matchedBy ?? best?.matched_by,
			plainLyrics: best?.plainLyrics ?? best?.plain_lyrics ?? null,
			syncedLyrics: best?.syncedLyrics ?? best?.synced_lyrics ?? null,
		} as any;
	}

	private async queryLyricsOVH(input: { artist?: string; title: string }): Promise<string | null> {
		const artist = (input.artist || "").trim();
		const title = (input.title || "").trim();
		if (!artist || !title) return null;
		const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
		const data = await axios
			.get(url, { timeout: 10_000 })
			.then((r) => r.data as any)
			.catch(() => null);
		const raw = data?.lyrics as string | undefined;
		if (!raw || typeof raw !== "string") return null;
		// Basic cleanup: normalize newlines
		return raw.replace(/\r\n/g, "\n").trim();
	}

	// --- Helpers ---
	private deriveArtistAndTitle(rawTitle: string, metadataAuthor?: string) {
		let artist = (metadataAuthor || "").trim();
		let title = String(rawTitle || "").trim();

		// Clean common channel suffixes
		if (artist.endsWith(" - Topic")) artist = artist.replace(/\s*-\s*Topic$/i, "");

		if (this.options.sanitizeTitle) {
			title = this.cleanTitle(title);
		}

		// If author missing, try split pattern "Artist - Title"
		if (!artist && /\s-\s/.test(rawTitle)) {
			const [maybeArtist, maybeTitle] = rawTitle.split(/\s-\s/, 2);
			if (maybeArtist && maybeTitle) {
				artist = maybeArtist.trim();
				title = this.options.sanitizeTitle ? this.cleanTitle(maybeTitle) : maybeTitle.trim();
			}
		}

		// Final pass trims
		artist = artist.trim();
		title = title.trim();
		return { artist, title };
	}

	private cleanTitle(t: string): string {
		let s = t;
		// Remove content in (), [], {}
		s = s.replace(/\s*[\[(\{][^\]\)\}]*[\])\}]\s*/g, " ");
		// Remove common noise
		s = s.replace(/\b(official\s+video|official\s+music\s+video|lyrics?|visualizer|audio only|HD|4K)\b/gi, "");
		s = s.replace(/lyrics|mv|full|official|music|video/gi, "").replace(/ft/gi, "feat");

		// Collapse ft./feat. segments to keep main title
		s = s.replace(/\b(ft\.?|feat\.?)\s+[^-–|]+/gi, "");
		// Simplify separators
		s = s.replace(/[|•·~]+/g, " ");
		// Normalize whitespace
		s = s.replace(/\s{2,}/g, " ").trim();
		return s;
	}

	private normalizeDuration(d: number | undefined): number | null {
		if (typeof d === "number") {
			// Most tracks store seconds; some may store ms if extremely large
			if (d > 0 && d < 1000 * 60 * 60) return Math.round(d);
			if (d > 1000) return Math.round(d / 1000);
		}
		return null;
	}
}
