import { VoiceConnection, VoiceConnectionStatus, entersState, joinVoiceChannel, getVoiceConnection } from "@discordjs/voice";
import type { PlayerOptions, VoiceChannel, PlayerConnectionInput, ConnectionControllerOptions } from "../types";
import { PlayerBus, createPlayerSessionId, type PlayerRequestId, type PlayerSessionId } from "../structures/PlayerBus";

/** Owns Discord voice connection state and lifecycle behind PlayerBus. */
export class ConnectionController {
	private readonly guildId: string;
	private readonly bus: PlayerBus;
	private readonly selfDeaf: boolean;
	private readonly selfMute: boolean;
	private readonly debug?: (message: string) => void;
	private readonly readyTimeoutMs: number;
	private readonly unsubscribe: () => void;

	private connection: VoiceConnection | null = null;
	private channel: VoiceChannel | null = null;
	private sessionId: PlayerSessionId | null = null;
	private requestId: PlayerRequestId | null = null;
	private disposed = false;
	private operation: Promise<void> = Promise.resolve();

	public constructor(options: ConnectionControllerOptions) {
		this.guildId = options.guildId;
		this.bus = options.bus;
		this.selfDeaf = options.options?.selfDeaf ?? true;
		this.selfMute = options.options?.selfMute ?? false;
		this.debug = options.debug;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;

		const unsubscribers = [
			this.bus.onInput("[Player]->[Connection]:connect", (event) => this.enqueue(() => this.connect(event))),
			this.bus.onInput("[Player]->[Connection]:disconnect", (event) => this.enqueue(() => this.disconnect(event))),
			this.bus.onInput("[Player]->[Connection]:reconnect", (event) => this.enqueue(() => this.reconnect(event))),
		];
		this.unsubscribe = () => unsubscribers.forEach((unsubscribe) => unsubscribe());
	}

	public get active(): VoiceConnection | null {
		return this.connection;
	}
	public get activeChannel(): VoiceChannel | null {
		return this.channel;
	}
	public get activeSessionId(): PlayerSessionId | null {
		return this.sessionId;
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		await this.operation.catch(() => undefined);
		const connection = this.connection;
		this.connection = null;
		this.channel = null;
		this.sessionId = null;
		this.requestId = null;
		connection?.destroy();
	}

	private enqueue(operation: () => Promise<void>): void {
		this.operation = this.operation.then(operation, operation).catch((error) => {
			this.debug?.(`[ConnectionController] operation failed: ${this.errorMessage(error)}`);
		});
	}

	private async connect(event: Extract<PlayerConnectionInput, { type: "[Player]->[Connection]:connect" }>): Promise<void> {
		if (this.disposed) return;
		const sessionId = createPlayerSessionId();
		this.requestId = event.requestId;
		this.sessionId = sessionId;
		this.channel = event.channel;
		this.bus.emitOutput({
			type: "[Connection]->[Player]:connecting",
			requestId: event.requestId,
			sessionId,
			channel: event.channel,
		});

		try {
			if (
				this.connection &&
				this.channel?.id === event.channel.id &&
				this.connection.state.status === VoiceConnectionStatus.Ready
			) {
				this.emitConnected(event.requestId, sessionId, event.channel, this.connection);
				return;
			}

			this.connection?.destroy();
			this.connection = null;
			const existing = getVoiceConnection(this.guildId);
			if (existing) existing.destroy();

			const connection = joinVoiceChannel({
				channelId: event.channel.id,
				guildId: event.channel.guildId || this.guildId,
				adapterCreator: event.channel.guild.voiceAdapterCreator,
				selfDeaf: this.selfDeaf,
				selfMute: this.selfMute,
			});
			this.connection = connection;
			connection.on(VoiceConnectionStatus.Disconnected, async () => {
				if (this.connection !== connection) return;
				try {
					await Promise.race([
						entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
						entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
					]);
				} catch {
					if (this.connection === connection) connection.destroy();
				}
			});
			connection.once(VoiceConnectionStatus.Destroyed, () => {
				if (this.connection !== connection) return;
				this.connection = null;
				this.bus.emitOutput({
					type: "[Connection]->[Player]:disconnected",
					requestId: this.requestId ?? undefined,
					sessionId: this.sessionId ?? sessionId,
					reason: "destroyed",
				});
			});

			await entersState(connection, VoiceConnectionStatus.Ready, this.readyTimeoutMs);
			if (this.disposed || this.sessionId !== sessionId || this.connection !== connection) {
				connection.destroy();
				return;
			}
			this.emitConnected(event.requestId, sessionId, event.channel, connection);
		} catch (error) {
			if (this.sessionId !== sessionId) return;
			this.connection?.destroy();
			this.connection = null;
			this.bus.emitOutput({
				type: "[Connection]->[Player]:error",
				requestId: event.requestId,
				sessionId,
				operation: "connect",
				error: this.toError(error),
			});
		}
	}

	private async disconnect(event: Extract<PlayerConnectionInput, { type: "[Player]->[Connection]:disconnect" }>): Promise<void> {
		if (this.disposed) return;
		const sessionId = this.sessionId ?? createPlayerSessionId();
		const connection = this.connection;
		this.connection = null;
		this.channel = null;
		this.sessionId = null;
		this.requestId = null;
		try {
			connection?.destroy();
			this.bus.emitOutput({
				type: "[Connection]->[Player]:disconnected",
				requestId: event.requestId,
				sessionId,
				reason: event.reason,
			});
		} catch (error) {
			this.bus.emitOutput({
				type: "[Connection]->[Player]:error",
				requestId: event.requestId,
				sessionId,
				operation: "disconnect",
				error: this.toError(error),
			});
		}
	}

	private async reconnect(event: Extract<PlayerConnectionInput, { type: "[Player]->[Connection]:reconnect" }>): Promise<void> {
		if (this.disposed) return;
		this.connection?.destroy();
		this.connection = null;
		this.channel = null;
		this.sessionId = null;
		await this.connect({ type: "[Player]->[Connection]:connect", requestId: event.requestId, channel: event.channel });
	}

	private emitConnected(
		requestId: PlayerRequestId,
		sessionId: PlayerSessionId,
		channel: VoiceChannel,
		connection: VoiceConnection,
	): void {
		this.debug?.(`[ConnectionController] connected guild=${this.guildId} channel=${channel.id}`);
		this.bus.emitOutput({ type: "[Connection]->[Player]:connected", requestId, sessionId, channel, connection });
	}

	private toError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}
	private errorMessage(error: unknown): string {
		return this.toError(error).message;
	}
}
