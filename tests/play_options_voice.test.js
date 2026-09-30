const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Player, assertVoiceChannel, Bus, PLAYER_RPC, BUS_REQUEST, BUS_OUTPUT, PLAYER_QUERY, BasePlugin } = require("../core/dist");

test("assertVoiceChannel validates GuildVoice channels and rejects other channel types", () => {
	// Valid GuildVoice channels (type: 2 or type: 'GuildVoice')
	assert.doesNotThrow(() => assertVoiceChannel({ id: "vc-1", guildId: "g-1", type: 2, guild: {} }));
	assert.doesNotThrow(() => assertVoiceChannel({ id: "vc-2", guildId: "g-1", type: "GuildVoice", guild: {} }));

	// Null / undefined / primitive
	assert.throws(
		() => assertVoiceChannel(null),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);
	assert.throws(
		() => assertVoiceChannel(undefined),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);
	assert.throws(
		() => assertVoiceChannel("123456789"),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);

	// Missing type
	assert.throws(
		() => assertVoiceChannel({ id: "vc-1", guildId: "g-1" }),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);

	// Other Discord channel types (Text: 0, DM: 1, Category: 4, StageVoice: 13)
	assert.throws(
		() => assertVoiceChannel({ id: "text-1", type: 0, guildId: "g-1" }),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);
	assert.throws(
		() => assertVoiceChannel({ id: "dm-1", type: 1, guildId: "g-1" }),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);
	assert.throws(
		() => assertVoiceChannel({ id: "cat-1", type: 4, guildId: "g-1" }),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);
	assert.throws(
		() => assertVoiceChannel({ id: "stage-1", type: 13, guildId: "g-1" }),
		(err) => err instanceof TypeError && err.message.includes("requires a Guild VoiceChannel"),
	);
});

test("player.play returns PlayResult with track, query, requestedBy, and player reference", async () => {
	const bus = new Bus();
	const playerId = "guild-play-options-1";
	const player = new Player(playerId, bus);

	const mockTrack = {
		id: "track-123",
		title: "Test Song",
		url: "https://example.com/test",
		duration: 180,
		source: "mock",
	};

	bus.registerRpc(PLAYER_RPC.play, async (payload) => {
		return { ok: true, track: mockTrack };
	});

	const result = await player.play("Test Song", {
		requestedBy: { id: "user-456", username: "Alice" },
	});

	assert.ok(result, "play() should return a truthy PlayResult");
	assert.equal(result.track.id, "track-123");
	assert.equal(result.query, "Test Song");
	assert.deepEqual(result.requestedBy, { id: "user-456", username: "Alice" });
	assert.equal(result.player, player);

	player.destroy();
});

test("player.play backward compatibility with string requestedBy", async () => {
	const bus = new Bus();
	const playerId = "guild-play-compat-1";
	const player = new Player(playerId, bus);

	const mockTrack = {
		id: "track-compat",
		title: "Compat Song",
		url: "https://example.com/compat",
		duration: 200,
	};

	let receivedRequestedBy;
	bus.registerRpc(PLAYER_RPC.play, async (payload) => {
		receivedRequestedBy = payload.requestedBy;
		return { ok: true, track: mockTrack };
	});

	const result = await player.play("Compat Song", "legacy-user-id");
	assert.ok(result);
	assert.equal(result.requestedBy, "legacy-user-id");
	assert.equal(receivedRequestedBy, "legacy-user-id");

	player.destroy();
});

test("player.play backward compatibility with Discord user object as second argument", async () => {
	const bus = new Bus();
	const playerId = "guild-play-compat-2";
	const player = new Player(playerId, bus);

	const mockTrack = {
		id: "track-user-obj",
		title: "User Obj Song",
		duration: 200,
	};

	const discordUser = { id: "987654", username: "Bob", discriminator: "0001" };
	bus.registerRpc(PLAYER_RPC.play, async (payload) => {
		return { ok: true, track: mockTrack };
	});

	const result = await player.play("User Obj Song", discordUser);
	assert.ok(result);
	assert.deepEqual(result.requestedBy, discordUser);

	player.destroy();
});

test("player.play auto-connects to valid voiceChannel and rejects invalid channel", async () => {
	const bus = new Bus();
	const playerId = "guild-play-voice-1";
	const player = new Player(playerId, bus);

	const mockTrack = { id: "track-voice", title: "Voice Song", duration: 150 };
	bus.registerRpc(PLAYER_RPC.play, async () => ({ ok: true, track: mockTrack }));

	let connectedChannel = null;
	const mockConnection = {
		state: { status: "ready" },
		joinConfig: { channelId: "vc-guild-123" },
	};

	bus.onInput(BUS_REQUEST.connectionConnect, (event) => {
		connectedChannel = event.channel;
		bus.emitOutput({
			type: BUS_OUTPUT.connectionConnected,
			requestId: event.requestId,
			playerId: event.playerId,
			channel: event.channel,
			connection: mockConnection,
		});
	});

	// Register query so Player.connection sees the connection
	bus.registerQuery(PLAYER_QUERY.connection, () => (connectedChannel ? mockConnection : null));

	// Rejects invalid channel with TypeError
	await assert.rejects(
		() => player.play("song", { voiceChannel: { id: "text-chan", type: 0 } }),
		TypeError,
	);

	// Valid GuildVoice channel auto-connects
	const validChannel = { id: "vc-guild-123", guildId: "g-1", type: 2, guild: {} };
	const result = await player.play("song", { voiceChannel: validChannel });
	assert.ok(result);
	assert.equal(connectedChannel.id, "vc-guild-123");
	assert.equal(result.voiceConnection, mockConnection);

	// Second play with same channel reuses connection without re-connecting
	let reconnected = false;
	bus.onInput(BUS_REQUEST.connectionConnect, (event) => {
		reconnected = true;
		bus.emitOutput({
			type: BUS_OUTPUT.connectionConnected,
			requestId: event.requestId,
			playerId: event.playerId,
			channel: event.channel,
			connection: mockConnection,
		});
	});
	await player.play("song 2", { voiceChannel: validChannel });
	assert.equal(reconnected, false, "Should reuse existing connection for same voiceChannel");

	player.destroy();
});

test("player.play forwards plugin option to RPC", async () => {
	const bus = new Bus();
	const playerId = "guild-play-plugin-filter";
	const player = new Player(playerId, bus);

	const mockTrack = { id: "track-plugin", title: "Plugin Song", duration: 120 };
	let capturedPlugin;
	bus.registerRpc(PLAYER_RPC.play, async (payload) => {
		capturedPlugin = payload.plugin;
		return { ok: true, track: mockTrack };
	});

	await player.play("song", { plugin: "youtube" });
	assert.equal(capturedPlugin, "youtube");

	await player.play("song", { plugin: ["youtube", "soundcloud"] });
	assert.deepEqual(capturedPlugin, ["youtube", "soundcloud"]);

	player.destroy();
});
