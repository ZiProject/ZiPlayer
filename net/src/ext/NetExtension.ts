import { BaseExtension, type ExtensionContext, type ExtensionStreamRequest, type Player, type StreamInfo } from "ziplayer";
import type { ZiNet } from "../ZiNet";

/**
 * Per-player extension. Supplies streams from another node (`track.metadata.net.owner`) and, when the
 * player's voice has been delegated, a remote playback handle that drives the executor.
 */
export class NetExtension extends BaseExtension {
	name = "ziplayer-net";
	version = "0.1.0";
	player: Player | null;

	constructor(
		private readonly net: ZiNet,
		player: Player | null = null,
	) {
		super();
		this.player = player;
	}

	active(): boolean {
		return true;
	}

	async provideStream(context: ExtensionContext, payload: ExtensionStreamRequest): Promise<StreamInfo | null> {
		const player = (context.player ?? this.player) as Player | null;
		const track = payload.track;
		if (!player) return null;

		if (this.net.delegationFor(player.guildId)) {
			return this.net.buildRemoteStream(player, track) as unknown as StreamInfo | null;
		}

		const owner = (track.metadata as any)?.net?.owner as string | undefined;
		if (owner && owner !== this.net.nodeId) {
			const info = await this.net.openRemoteStream(owner, track, 0, context.signal);
			return info as unknown as StreamInfo;
		}
		return null;
	}
}
