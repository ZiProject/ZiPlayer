const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
	Bus,
	createSharedControllers,
	BUS_EVENT,
	BUS_OUTPUT,
	PlaybackMode,
	PLAYER_ACTION,
	PLAYER_QUERY,
} = require("../core/dist");

test("leaveOnEmpty waits for an empty voice channel and disconnects despite active playback", async (t) => {
	const bus = new Bus();
	const { lifecycle } = createSharedControllers({ bus });
	const playerId = "voice-empty-guild";
	const client = new EventEmitter();
	const members = new Map([
		["human", { user: { bot: false } }],
		["bot", { user: { bot: true } }],
	]);
	const channel = {
		id: "voice-channel",
		guildId: playerId,
		guild: { id: playerId, client },
		members,
	};
	let disconnectCount = 0;

	bus.registerQuery(PLAYER_QUERY.playbackMode, () => PlaybackMode.NATIVE);
	bus.request = async () => {
		disconnectCount++;
	};
	lifecycle.attach(playerId, { leaveOnEmpty: true, leaveTimeout: 30 }, () => undefined);
	bus.emitOutput({
		type: BUS_OUTPUT.connectionConnected,
		requestId: "request-1",
		playerId,
		sessionId: "session-1",
		channel,
		connection: {},
	});
	bus.publish(playerId, BUS_EVENT.stateChanged, { status: "idle" }, { status: "playing" });

	const emitHumanVoiceState = (oldChannelId, newChannelId) => {
		client.emit(
			"voiceStateUpdate",
			{ guild: { id: playerId }, channelId: oldChannelId },
			{ guild: { id: playerId }, channelId: newChannelId },
		);
	};

	// A human returning during the grace period cancels the pending leave.
	members.delete("human");
	emitHumanVoiceState(channel.id, null);
	members.set("human", { user: { bot: false } });
	emitHumanVoiceState(null, channel.id);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(disconnectCount, 0);

	// Once the human leaves again, the bot-only channel is considered empty.
	members.delete("human");
	emitHumanVoiceState(channel.id, null);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(disconnectCount, 1);

	t.after(() => {
		lifecycle.detach(playerId);
		bus.dispose();
	});
});

test("pauseOnEmpty pauses active playback and resumes it when a human returns", async (t) => {
	const bus = new Bus();
	let playing = true;
	let paused = false;
	const actions = [];
	const playerId = "pause-empty-guild";
	const client = new EventEmitter();
	const members = new Map([["human", { user: { bot: false } }]]);
	const channel = {
		id: "pause-voice-channel",
		guildId: playerId,
		guild: { id: playerId, client },
		members,
	};

	bus.registerQuery(PLAYER_QUERY.playbackMode, () => PlaybackMode.NATIVE);
	bus.registerQuery(PLAYER_QUERY.isPlaying, () => playing);
	bus.registerQuery(PLAYER_QUERY.isPaused, () => paused);
	const { lifecycle } = createSharedControllers({ bus });
	bus.action = async (_id, action) => {
		actions.push(action.type);
		playing = action.type === PLAYER_ACTION.resume;
		paused = action.type === PLAYER_ACTION.pause;
	};
	lifecycle.attach(playerId, { leaveOnEmpty: false, pauseOnEmpty: true, leaveTimeout: 0 }, () => undefined);
	bus.emitOutput({
		type: BUS_OUTPUT.connectionConnected,
		requestId: "pause-request-1",
		playerId,
		sessionId: "pause-session-1",
		channel,
		connection: {},
	});

	const emitHumanVoiceState = (oldChannelId, newChannelId) => {
		client.emit(
			"voiceStateUpdate",
			{ guild: { id: playerId }, channelId: oldChannelId },
			{ guild: { id: playerId }, channelId: newChannelId },
		);
	};

	members.clear();
	emitHumanVoiceState(channel.id, null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(actions, [PLAYER_ACTION.pause]);
	assert.equal(paused, true);

	members.set("human", { user: { bot: false } });
	emitHumanVoiceState(null, channel.id);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(actions, [PLAYER_ACTION.pause, PLAYER_ACTION.resume]);
	assert.equal(playing, true);
	assert.equal(paused, false);

	t.after(() => {
		lifecycle.detach(playerId);
		bus.dispose();
	});
});

test("pauseOnEmpty does not resume playback that was manually paused", async (t) => {
	const bus = new Bus();
	let paused = true;
	const actions = [];
	const playerId = "manual-pause-empty-guild";
	const client = new EventEmitter();
	const members = new Map([["human", { user: { bot: false } }]]);
	const channel = {
		id: "manual-pause-voice-channel",
		guildId: playerId,
		guild: { id: playerId, client },
		members,
	};

	bus.registerQuery(PLAYER_QUERY.playbackMode, () => PlaybackMode.NATIVE);
	bus.registerQuery(PLAYER_QUERY.isPlaying, () => false);
	bus.registerQuery(PLAYER_QUERY.isPaused, () => paused);
	const { lifecycle } = createSharedControllers({ bus });
	bus.action = async (_id, action) => actions.push(action.type);
	lifecycle.attach(playerId, { leaveOnEmpty: false, pauseOnEmpty: true }, () => undefined);
	bus.emitOutput({
		type: BUS_OUTPUT.connectionConnected,
		requestId: "manual-pause-request",
		playerId,
		sessionId: "manual-pause-session",
		channel,
		connection: {},
	});

	members.clear();
	client.emit(
		"voiceStateUpdate",
		{ guild: { id: playerId }, channelId: channel.id },
		{ guild: { id: playerId }, channelId: null },
	);
	members.set("human", { user: { bot: false } });
	client.emit(
		"voiceStateUpdate",
		{ guild: { id: playerId }, channelId: null },
		{ guild: { id: playerId }, channelId: channel.id },
	);
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(actions, []);
	assert.equal(paused, true);
	t.after(() => {
		lifecycle.detach(playerId);
		bus.dispose();
	});
});
