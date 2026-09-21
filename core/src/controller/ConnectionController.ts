import {
	VoiceConnection,
	VoiceConnectionStatus,
	entersState,
	joinVoiceChannel,
	getVoiceConnection,
	type AudioPlayer,
	type PlayerSubscription,
} from "@discordjs/voice";
import type { PlayerOptions, VoiceChannel, PlayerConnectionInput, ConnectionControllerOptions } from "../types";
import { createPlayerSessionId, type Bus, type PlayerRequestId, type PlayerSessionId } from "../structures/Bus";
import { BUS_OUTPUT, BUS_REQUEST, PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

interface ConnectionSlot {
	group?: string;
	selfDeaf: boolean;
	selfMute: boolean;
	debug?: (message: string) => void;
	readyTimeoutMs: number;
	connection: VoiceConnection | null;
	channel: VoiceChannel | null;
	sessionId: PlayerSessionId | null;
	requestId: PlayerRequestId | null;
	audioPlayer: AudioPlayer | null;
	subscription: PlayerSubscription | null;
	disposed: boolean;
	operation: Promise<void>;
}

/**
 * Owns Discord voice connection state and lifecycle behind the Bus.
 *
 * Singleton — created exactly once in `ensureSharedControllers()` and shared by every
 * player in the process (see `SharedControllerGraph`). A Discord voice connection is
 * inherently per-guild (one `VoiceConnection`/`AudioPlayer` can only ever serve one
 * guild), so that per-guild resource still exists once per player — it just lives as an
 * entry in this controller's internal `Map<playerId, ConnectionSlot>` (via
 * `attach(playerId, ...)`/`detach(playerId)`) instead of a whole separate
 * `ConnectionController` instance. `connection.setAudioPlayer`/`connection`/
 * `connection.state` and the three `onInput` listeners below are registered exactly
 * once for the whole process and route by `playerId`/`event.playerId` — this also fixes
 * a latent bug in the old one-instance-per-player design, where `Bus.onInput()`
 * dispatch is global/flat (broadcast to every listener) and the old handlers didn't
 * filter by `event.playerId`, so every guild's `ConnectionController` instance used to
 * run `connect()`/`disconnect()`/`reconnect()` for every OTHER guild's request too.
 */
export class ConnectionController {
	private readonly bus?: Bus;
	private readonly slots = new Map<string, ConnectionSlot>();

	public constructor(bus?: Bus) {
		this.bus = bus;

		if (bus) {
			bus.registerRpc<{ audioPlayer: AudioPlayer | null }, void>(PLAYER_RPC.connectionSetAudioPlayer, ({ audioPlayer }, ctx) =>
				this.setAudioPlayer(ctx.playerId, audioPlayer),
			);
			bus.registerQuery(PLAYER_QUERY.connection, (playerId) => this.slots.get(playerId)?.connection ?? null);
			bus.registerQuery(PLAYER_QUERY.connectionState, (playerId) => this.slots.get(playerId)?.connection?.state.status);
			bus.onInput(BUS_REQUEST.connectionConnect, (event) =>
				this.enqueue(event.playerId, () => this.connect(event.playerId, event)),
			);
			bus.onInput(BUS_REQUEST.connectionDisconnect, (event) =>
				this.enqueue(event.playerId, () => this.disconnect(event.playerId, event)),
			);
			bus.onInput(BUS_REQUEST.connectionReconnect, (event) =>
				this.enqueue(event.playerId, () => this.reconnect(event.playerId, event)),
			);
		}
	}

	/** Opens a slot for `playerId`. */
	public attach(playerId: string, options: ConnectionControllerOptions): void {
		const opt = options.options ?? {};
		this.slots.set(playerId, {
			group: opt.group,
			selfDeaf: opt.selfDeaf ?? true,
			selfMute: opt.selfMute ?? false,
			debug: options.debug,
			readyTimeoutMs: options.readyTimeoutMs ?? 15_000,
			connection: null,
			channel: null,
			sessionId: null,
			requestId: null,
			audioPlayer: options.audioPlayer ?? null,
			subscription: null,
			disposed: false,
			operation: Promise.resolve(),
		});
	}

	public getActive(playerId: string): VoiceConnection | null {
		return this.slots.get(playerId)?.connection ?? null;
	}
	public getActiveChannel(playerId: string): VoiceChannel | null {
		return this.slots.get(playerId)?.channel ?? null;
	}
	public getActiveSessionId(playerId: string): PlayerSessionId | null {
		return this.slots.get(playerId)?.sessionId ?? null;
	}
	public getActiveSubscription(playerId: string): PlayerSubscription | null {
		return this.slots.get(playerId)?.subscription ?? null;
	}
	public getIsReady(playerId: string): boolean {
		return this.slots.get(playerId)?.connection?.state.status === VoiceConnectionStatus.Ready;
	}
	public getIsSubscribed(playerId: string): boolean {
		const slot = this.slots.get(playerId);
		return Boolean(slot?.subscription && slot.connection?.state.status === VoiceConnectionStatus.Ready);
	}

	public setAudioPlayer(playerId: string, audioPlayer: AudioPlayer | null): void {
		const slot = this.slots.get(playerId);
		if (!slot || slot.audioPlayer === audioPlayer) return;
		this.cleanupSubscription(playerId);
		slot.audioPlayer = audioPlayer;
		if (slot.connection && slot.connection.state.status === VoiceConnectionStatus.Ready) {
			this.ensureSubscription(playerId, slot.connection);
		}
	}

	public ensureSubscription(playerId: string, connection?: VoiceConnection | null): PlayerSubscription | null {
		const slot = this.slots.get(playerId);
		if (!slot) return null;
		const target = connection === undefined ? slot.connection : connection;
		if (slot.disposed || !target || !slot.audioPlayer) {
			this.cleanupSubscription(playerId);
			return null;
		}
		if (target.state.status !== VoiceConnectionStatus.Ready) {
			return null;
		}
		if (slot.subscription && slot.subscription.connection !== target) {
			this.cleanupSubscription(playerId);
		}
		const currentSub = (target.state as { subscription?: PlayerSubscription }).subscription;
		if (slot.subscription && currentSub === slot.subscription) {
			return slot.subscription;
		}
		try {
			slot.subscription?.unsubscribe();
			slot.subscription = target.subscribe(slot.audioPlayer) ?? null;
			slot.debug?.(`[ConnectionController] AudioPlayer subscribed guild=${playerId}`);
		} catch (error) {
			slot.debug?.(`[ConnectionController] AudioPlayer subscription failed guild=${playerId}: ${this.errorMessage(error)}`);
			slot.subscription = null;
		}
		return slot.subscription;
	}

	public cleanupSubscription(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (!slot?.subscription) return;
		try {
			slot.subscription.unsubscribe();
		} catch {}
		slot.subscription = null;
		slot.debug?.(`[ConnectionController] AudioPlayer unsubscribed guild=${playerId}`);
	}

	public async dispose(playerId?: string): Promise<void> {
		if (playerId) {
			await this.detach(playerId);
			return;
		}
		for (const id of [...this.slots.keys()]) await this.detach(id);
	}

	public async detach(playerId: string): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot || slot.disposed) return;
		slot.disposed = true;
		await slot.operation.catch(() => undefined);
		this.cleanupSubscription(playerId);
		const connection = slot.connection;
		slot.connection = null;
		slot.channel = null;
		slot.sessionId = null;
		slot.requestId = null;
		connection?.destroy();
		this.slots.delete(playerId);
	}

	private enqueue(playerId: string, operation: () => Promise<void>): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		slot.operation = slot.operation.then(operation, operation).catch((error) => {
			slot.debug?.(`[ConnectionController] operation failed: ${this.errorMessage(error)}`);
		});
	}

	private async connect(
		playerId: string,
		event: Extract<PlayerConnectionInput, { type: typeof BUS_REQUEST.connectionConnect }>,
	): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot || slot.disposed) return;
		const sessionId = createPlayerSessionId();
		slot.requestId = event.requestId;
		slot.sessionId = sessionId;
		slot.channel = event.channel;
		this.bus?.emitOutput({
			type: BUS_OUTPUT.connectionConnecting,
			requestId: event.requestId,
			playerId,
			sessionId,
			channel: event.channel,
		});

		try {
			if (
				slot.connection &&
				slot.channel?.id === event.channel.id &&
				slot.connection.state.status === VoiceConnectionStatus.Ready
			) {
				this.ensureSubscription(playerId, slot.connection);
				this.emitConnected(playerId, event.requestId, sessionId, event.channel, slot.connection, slot);
				return;
			}

			this.cleanupSubscription(playerId);
			slot.connection?.destroy();
			slot.connection = null;
			const existing = getVoiceConnection(playerId);
			if (existing) existing.destroy();

			const connection = joinVoiceChannel({
				channelId: event.channel.id,
				guildId: event.channel.guildId || playerId,
				adapterCreator: event.channel.guild.voiceAdapterCreator,
				group: slot.group,
				selfDeaf: slot.selfDeaf,
				selfMute: slot.selfMute,
			});
			slot.connection = connection;

			connection.on(VoiceConnectionStatus.Ready, () => {
				if (slot.connection !== connection) return;
				this.ensureSubscription(playerId, connection);
			});

			connection.on(VoiceConnectionStatus.Disconnected, async () => {
				if (slot.connection !== connection) return;
				try {
					await Promise.race([
						entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
						entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
					]);
				} catch {
					if (slot.connection === connection) connection.destroy();
				}
			});
			connection.once(VoiceConnectionStatus.Destroyed, () => {
				if (slot.connection !== connection) return;
				this.cleanupSubscription(playerId);
				slot.connection = null;
				this.bus?.emitOutput({
					type: BUS_OUTPUT.connectionDisconnected,
					requestId: slot.requestId ?? undefined,
					playerId,
					sessionId: slot.sessionId ?? sessionId,
					reason: "destroyed",
				});
			});

			await entersState(connection, VoiceConnectionStatus.Ready, slot.readyTimeoutMs);
			if (slot.disposed || slot.sessionId !== sessionId || slot.connection !== connection) {
				this.cleanupSubscription(playerId);
				connection.destroy();
				return;
			}
			this.ensureSubscription(playerId, connection);
			this.emitConnected(playerId, event.requestId, sessionId, event.channel, connection, slot);
		} catch (error) {
			if (slot.sessionId !== sessionId) return;
			this.cleanupSubscription(playerId);
			slot.connection?.destroy();
			slot.connection = null;
			this.bus?.emitOutput({
				type: BUS_OUTPUT.connectionError,
				requestId: event.requestId,
				playerId,
				sessionId,
				operation: "connect",
				error: this.toError(error),
			});
		}
	}

	private async disconnect(
		playerId: string,
		event: Extract<PlayerConnectionInput, { type: typeof BUS_REQUEST.connectionDisconnect }>,
	): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot || slot.disposed) return;
		const sessionId = slot.sessionId ?? createPlayerSessionId();
		const connection = slot.connection;
		this.cleanupSubscription(playerId);
		slot.connection = null;
		slot.channel = null;
		slot.sessionId = null;
		slot.requestId = null;
		try {
			connection?.destroy();
			this.bus?.emitOutput({
				type: BUS_OUTPUT.connectionDisconnected,
				requestId: event.requestId,
				playerId,
				sessionId,
				reason: event.reason,
			});
		} catch (error) {
			this.bus?.emitOutput({
				type: BUS_OUTPUT.connectionError,
				requestId: event.requestId,
				playerId,
				sessionId,
				operation: "disconnect",
				error: this.toError(error),
			});
		}
	}

	private async reconnect(
		playerId: string,
		event: Extract<PlayerConnectionInput, { type: typeof BUS_REQUEST.connectionReconnect }>,
	): Promise<void> {
		const slot = this.slots.get(playerId);
		if (!slot || slot.disposed) return;
		this.cleanupSubscription(playerId);
		slot.connection?.destroy();
		slot.connection = null;
		slot.channel = null;
		slot.sessionId = null;
		await this.connect(playerId, { type: BUS_REQUEST.connectionConnect, requestId: event.requestId, channel: event.channel });
	}

	private emitConnected(
		playerId: string,
		requestId: PlayerRequestId,
		sessionId: PlayerSessionId,
		channel: VoiceChannel,
		connection: VoiceConnection,
		slot: ConnectionSlot,
	): void {
		slot.debug?.(`[ConnectionController] connected guild=${playerId} channel=${channel.id}`);
		this.bus?.emitOutput({
			type: BUS_OUTPUT.connectionConnected,
			requestId,
			playerId,
			sessionId,
			channel,
			connection,
		});
	}

	private toError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}
	private errorMessage(error: unknown): string {
		return this.toError(error).message;
	}
}
