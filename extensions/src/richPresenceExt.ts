import { BaseExtension, Player, Track } from "ziplayer";
import type { ExtensionContext } from "ziplayer";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface RichPresenceOptions {
	/** Discord Application (Client) ID. Defaults to standard Discord RPC application. */
	clientId?: string;
	/** Activity type: "Listening" (type 2) or "Playing" (type 0). Defaults to "Listening". */
	activityType?: "Listening" | "Playing";
	/** Whether to display start/end timeline bar. Defaults to true. */
	showTimeline?: boolean;
	/** Whether to display track thumbnail as large image. Defaults to true. */
	showThumbnail?: boolean;
	/** Whether to display Rich Presence when idle (no track playing). Defaults to true. */
	showIdle?: boolean;
	/** Details text displayed when idle. Defaults to "Chờ phát nhạc". */
	idleDetails?: string;
	/** State text displayed when idle. Defaults to "Zimusix". */
	idleState?: string;
	/** Fallback large image asset key or HTTPS URL when track has no thumbnail. */
	largeImageFallback?: string;
}

export interface DiscordRpcUser {
	id: string;
	username: string;
	discriminator?: string;
	global_name?: string;
	avatar?: string | null;
}

const OPCODES = {
	HANDSHAKE: 0,
	FRAME: 1,
	CLOSE: 2,
	PING: 3,
	PONG: 4,
} as const;

function sanitizeString(str: unknown, minLen = 2, maxLen = 128): string | undefined {
	if (typeof str !== "string") return undefined;
	const trimmed = str.trim();
	if (!trimmed) return undefined;
	if (trimmed.length < minLen) return trimmed.padEnd(minLen, " ");
	return trimmed.slice(0, maxLen);
}

function isValidHttpUrl(url: unknown): boolean {
	if (typeof url !== "string") return false;
	try {
		const parsed = new URL(url);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			!parsed.hostname.includes("127.0.0.1") &&
			parsed.hostname !== "localhost"
		);
	} catch {
		return false;
	}
}

/**
 * richPresenceExt - Discord Rich Presence extension for ZiPlayer.
 *
 * Connects directly to the local Discord desktop client via IPC pipe/socket,
 * displaying the currently playing track with live timeline progress bar and thumbnail artwork,
 * as well as an idle status when no music is playing.
 */
export class richPresenceExt extends BaseExtension {
	public name = "richPresenceExt";
	public version = "1.0.0";
	public priority = 80;
	public player: Player | null = null;

	private options: Required<RichPresenceOptions>;
	private socket: net.Socket | null = null;
	private rxBuffer: Buffer = Buffer.alloc(0);
	private isConnected = false;
	private isDestroyed = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private currentUser: DiscordRpcUser | null = null;
	private currentActivity: Record<string, unknown> | null = null;
	private attachedPlayer: Player | null = null;
	private busUnsubs: Array<() => void> = [];
	private idleStartedAt: number = Date.now();

	constructor(playerOrOptions?: Player | RichPresenceOptions | null, options?: RichPresenceOptions) {
		super();
		const opts: RichPresenceOptions = playerOrOptions && !(playerOrOptions instanceof Player) ? playerOrOptions : (options ?? {});
		if (playerOrOptions instanceof Player) {
			this.player = playerOrOptions;
		}

		this.options = {
			clientId: opts.clientId ?? "383226320970055681",
			activityType: opts.activityType ?? "Listening",
			showTimeline: opts.showTimeline ?? true,
			showThumbnail: opts.showThumbnail ?? true,
			showIdle: opts.showIdle ?? true,
			idleDetails: opts.idleDetails ?? "Chờ phát nhạc",
			idleState: opts.idleState ?? "Zimusix",
			largeImageFallback: opts.largeImageFallback ?? "",
		};

		this.connect();
	}

	public get connected(): boolean {
		return this.isConnected;
	}

	public get user(): DiscordRpcUser | null {
		return this.currentUser;
	}

	public setClientId(clientId: string): void {
		if (!clientId || clientId === this.options.clientId) return;
		this.options.clientId = clientId;
		this.disconnect();
		this.connect();
	}

	public setOptions(options: Partial<RichPresenceOptions>): void {
		const oldClientId = this.options.clientId;
		this.options = { ...this.options, ...options };
		if (options.clientId && options.clientId !== oldClientId) {
			this.setClientId(options.clientId);
		} else if (this.attachedPlayer && this.attachedPlayer.currentTrack) {
			this.syncPlayerState(this.attachedPlayer);
		} else if (this.options.showIdle) {
			this.setIdleActivity();
		}
	}

	public active(context: ExtensionContext): boolean {
		const player = context.player ?? this.player;
		if (!player) return false;
		this.attachedPlayer = player;
		this.player = player;

		this.busUnsubs.push(
			player.bus.subscribe(player.playerId, "TRACK_STARTED", ({ track }) => {
				this.onTrackStart(track, player);
			}),
		);
		this.busUnsubs.push(
			player.bus.subscribe(player.playerId, "playerPause", () => {
				this.onPlayerPause(player);
			}),
		);
		this.busUnsubs.push(
			player.bus.subscribe(player.playerId, "playerResume", () => {
				this.onPlayerResume(player);
			}),
		);
		this.busUnsubs.push(
			player.bus.subscribe(player.playerId, "seek", ({ position }) => {
				this.onSeek(position, player);
			}),
		);
		this.busUnsubs.push(
			player.bus.subscribe(player.playerId, "TRACK_END", () => {
				this.onTrackEnd(player);
			}),
		);
		this.busUnsubs.push(
			player.bus.subscribe(player.playerId, "playerStop", () => {
				this.setIdleActivity();
			}),
		);
		this.busUnsubs.push(
			player.bus.subscribe(player.playerId, "destroyed", () => {
				this.onDestroy();
			}),
		);

		if (player.currentTrack) {
			this.syncPlayerState(player);
		} else {
			this.setIdleActivity();
		}

		return true;
	}

	public onDestroy(): void {
		this.isDestroyed = true;
		for (const unsub of this.busUnsubs) {
			try {
				unsub();
			} catch {}
		}
		this.busUnsubs = [];
		this.clearActivity();
		this.disconnect();
	}

	public clearActivity(): void {
		this.currentActivity = null;
		if (!this.isConnected || !this.socket) return;
		this.sendPacket(OPCODES.FRAME, {
			cmd: "SET_ACTIVITY",
			args: {
				pid: process.pid,
				activity: null,
			},
			nonce: crypto.randomUUID(),
		});
	}

	public setIdleActivity(): void {
		if (!this.options.showIdle) {
			this.clearActivity();
			return;
		}

		if (!this.idleStartedAt) {
			this.idleStartedAt = Date.now();
		}

		const details = sanitizeString(this.options.idleDetails || "Chờ phát nhạc");
		const state = sanitizeString(this.options.idleState || "Zimusix");

		let largeImage: string | undefined;
		if (this.options.largeImageFallback && isValidHttpUrl(this.options.largeImageFallback)) {
			largeImage = this.options.largeImageFallback;
		}

		const assets: Record<string, string | undefined> = {
			large_image: largeImage,
			large_text: sanitizeString(this.options.idleState || "Zimusix"),
		};

		const activity: Record<string, unknown> = {
			details,
			state,
			assets,
			timestamps: { start: this.idleStartedAt },
			type: this.options.activityType === "Playing" ? 0 : 2,
		};

		this.setActivity(activity);
	}

	public setActivity(activity: Record<string, unknown> | null): void {
		this.currentActivity = activity;
		if (!this.isConnected || !this.socket) return;
		this.sendPacket(OPCODES.FRAME, {
			cmd: "SET_ACTIVITY",
			args: {
				pid: process.pid,
				activity,
			},
			nonce: crypto.randomUUID(),
		});
	}

	public syncPlayerState(player: Player): void {
		const track = player.currentTrack;
		if (!track) {
			this.setIdleActivity();
			return;
		}

		const time = player.getTime();
		const positionMs = time.current;
		const durationMs = time.total;
		const isPaused = player.isPaused;

		this.formatAndSendActivity({
			track,
			positionMs,
			durationMs,
			isPaused,
			isLive: Boolean(track.isLive),
		});
	}

	private onTrackStart(track: Track | null, player: Player): void {
		if (!track) {
			this.setIdleActivity();
			return;
		}
		this.idleStartedAt = 0;
		const d = Number(track.duration) || 0;
		const durationMs = d > 1000 ? d : d * 1000;
		this.formatAndSendActivity({
			track,
			positionMs: 0,
			durationMs,
			isPaused: false,
			isLive: Boolean(track.isLive),
		});
	}

	private onPlayerPause(player: Player): void {
		const track = player.currentTrack;
		if (!track) return;
		const time = player.getTime();
		this.formatAndSendActivity({
			track,
			positionMs: time.current,
			durationMs: time.total,
			isPaused: true,
			isLive: Boolean(track.isLive),
		});
	}

	private onPlayerResume(player: Player): void {
		const track = player.currentTrack;
		if (!track) return;
		const time = player.getTime();
		this.formatAndSendActivity({
			track,
			positionMs: time.current,
			durationMs: time.total,
			isPaused: false,
			isLive: Boolean(track.isLive),
		});
	}

	private onSeek(positionMs: number, player: Player): void {
		const track = player.currentTrack;
		if (!track) return;
		const time = player.getTime();
		this.formatAndSendActivity({
			track,
			positionMs,
			durationMs: time.total,
			isPaused: player.isPaused,
			isLive: Boolean(track.isLive),
		});
	}

	private onTrackEnd(player: Player): void {
		if (player.upcomingTracks.length === 0 && !player.isPlaying) {
			this.setIdleActivity();
		}
	}

	private formatAndSendActivity(params: {
		track: Track;
		positionMs: number;
		durationMs: number;
		isPaused: boolean;
		isLive: boolean;
	}): void {
		const { track, positionMs, durationMs, isPaused, isLive } = params;
		const details = sanitizeString(track.title || "Untitled track");
		const authorText = track.author ? `by ${track.author}` : "ZiPlayer";
		const stateText = isPaused ? `${authorText} (Paused)` : authorText;
		const state = sanitizeString(stateText);

		let timestamps: { start?: number; end?: number } | undefined;
		if (this.options.showTimeline && !isPaused) {
			const start = Math.floor(Date.now() - Math.max(0, positionMs));
			timestamps = { start };
			if (durationMs > 0 && !isLive) {
				timestamps.end = Math.floor(start + durationMs);
			}
		}

		let largeImage: string | undefined;
		if (this.options.showThumbnail) {
			if (isValidHttpUrl(track.thumbnail)) {
				largeImage = track.thumbnail;
			} else if (this.options.largeImageFallback && isValidHttpUrl(this.options.largeImageFallback)) {
				largeImage = this.options.largeImageFallback;
			}
		}

		const assets: Record<string, string | undefined> = {
			large_image: largeImage,
			large_text: sanitizeString(track.title || "ZiPlayer"),
			small_image: isPaused ? "pause" : "play",
			small_text: isPaused ? "Paused" : "Playing",
		};

		const activity: Record<string, unknown> = {
			details,
			state,
			assets,
			type: this.options.activityType === "Playing" ? 0 : 2,
		};
		if (timestamps) activity.timestamps = timestamps;

		this.setActivity(activity);
	}

	/* ------------------------------------------------------------- IPC Protocol */

	private getIpcPaths(): string[] {
		const paths: string[] = [];
		if (process.platform === "win32") {
			for (let i = 0; i < 10; i++) {
				paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
				paths.push(`\\\\.\\pipe\\discord-ipc-${i}`);
			}
		} else {
			const envDirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, "/tmp"].filter(
				Boolean,
			) as string[];

			for (const dir of envDirs) {
				for (let i = 0; i < 10; i++) {
					paths.push(path.join(dir, `discord-ipc-${i}`));
				}
			}
		}
		return paths;
	}

	private connect(): void {
		if (this.isDestroyed || this.socket || this.isConnected) return;

		const candidatePaths = this.getIpcPaths();
		let index = 0;

		const tryNext = () => {
			if (this.isDestroyed || this.socket) return;
			if (index >= candidatePaths.length) {
				this.scheduleReconnect();
				return;
			}

			const ipcPath = candidatePaths[index++];
			const sock = net.connect(ipcPath);

			sock.once("connect", () => {
				this.socket = sock;
				this.rxBuffer = Buffer.alloc(0);
				this.setupSocket(sock);
				this.sendHandshake();
			});

			sock.once("error", () => {
				sock.destroy();
				tryNext();
			});
		};

		tryNext();
	}

	private setupSocket(sock: net.Socket): void {
		sock.on("data", (chunk: Buffer) => {
			this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
			while (this.rxBuffer.length >= 8) {
				const opcode = this.rxBuffer.readInt32LE(0);
				const length = this.rxBuffer.readInt32LE(4);
				if (this.rxBuffer.length < 8 + length) break;

				const payloadBytes = this.rxBuffer.subarray(8, 8 + length);
				this.rxBuffer = this.rxBuffer.subarray(8 + length);

				try {
					const text = payloadBytes.toString("utf8");
					const message = JSON.parse(text);
					this.handleMessage(opcode, message);
				} catch (err) {
					console.error("[richPresenceExt] Failed to parse frame:", err);
				}
			}
		});

		sock.on("close", () => {
			this.onSocketDisconnected();
		});

		sock.on("error", () => {
			this.onSocketDisconnected();
		});
	}

	private handleMessage(opcode: number, message: any): void {
		if (opcode === OPCODES.FRAME) {
			if (message.evt === "READY") {
				this.isConnected = true;
				this.currentUser = message.data?.user ?? null;
				this.emit("ready", this.currentUser);
				if (this.currentActivity) {
					this.setActivity(this.currentActivity);
				} else if (this.attachedPlayer?.currentTrack) {
					this.syncPlayerState(this.attachedPlayer);
				} else {
					this.setIdleActivity();
				}
			} else if (message.evt === "ERROR") {
				console.warn("[richPresenceExt] Discord error event:", message.data);
			}
		} else if (opcode === OPCODES.PING) {
			this.sendPacket(OPCODES.PONG, message);
		} else if (opcode === OPCODES.CLOSE) {
			this.disconnect();
			this.scheduleReconnect();
		}
	}

	private sendHandshake(): void {
		this.sendPacket(OPCODES.HANDSHAKE, {
			v: 1,
			client_id: this.options.clientId,
		});
	}

	private sendPacket(opcode: number, payload: unknown): void {
		if (!this.socket || this.socket.destroyed) return;
		try {
			const json = JSON.stringify(payload);
			const jsonBuf = Buffer.from(json, "utf8");
			const header = Buffer.alloc(8);
			header.writeInt32LE(opcode, 0);
			header.writeInt32LE(jsonBuf.length, 4);
			this.socket.write(Buffer.concat([header, jsonBuf]));
		} catch (err) {
			console.error("[richPresenceExt] Failed to send packet:", err);
		}
	}

	private onSocketDisconnected(): void {
		this.isConnected = false;
		this.currentUser = null;
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		this.scheduleReconnect();
	}

	private disconnect(): void {
		this.isConnected = false;
		this.currentUser = null;
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.isDestroyed || !this.socket || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, 10_000).unref();
	}
}
