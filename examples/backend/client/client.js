import { WEB_AUDIO_CHANNELS, WEB_AUDIO_SAMPLE_RATE_HZ, WEB_AUDIO_SAMPLE_BYTES, WebAudioClient } from "/web-audio-client.js";

const connectForm = document.querySelector("#connect-form");
const gatewayUrlInput = document.querySelector("#gateway-url");
const sessionIdInput = document.querySelector("#session-id");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const pauseButton = document.querySelector("#pause");
const resumeButton = document.querySelector("#resume");
const stopPlaybackButton = document.querySelector("#stop-playback");
const seekForm = document.querySelector("#seek-form");
const seekPositionInput = document.querySelector("#seek-position");
const volumeInput = document.querySelector("#volume");
const volumeValue = document.querySelector("#volume-value");
const controlStatusElement = document.querySelector("#control-status");
const statusElement = document.querySelector("#status");
const recordButton = document.querySelector("#record");
const downloadRecordingButton = document.querySelector("#download-recording");
const clearRecordingButton = document.querySelector("#clear-recording");
const recordingStatusElement = document.querySelector("#recording-status");
const searchForm = document.querySelector("#search-form");
const searchQueryInput = document.querySelector("#search-query");
const searchButton = document.querySelector("#search");
const searchStatusElement = document.querySelector("#search-status");
const currentTrackElement = document.querySelector("#current-track");
const queueListElement = document.querySelector("#queue-list");
const relatedListElement = document.querySelector("#related-list");
const skipButton = document.querySelector("#skip");
const loopModeSelect = document.querySelector("#loop-mode");
const autoplayInput = document.querySelector("#autoplay");
const filterSelect = document.querySelector("#filter-select");
const applyFilterButton = document.querySelector("#apply-filter");
const clearFiltersButton = document.querySelector("#clear-filters");
const filterStatusElement = document.querySelector("#filter-status");
const BYTES_PER_SECOND = WEB_AUDIO_SAMPLE_RATE_HZ * WEB_AUDIO_CHANNELS * WEB_AUDIO_SAMPLE_BYTES;
const MAX_RECORDING_BYTES = BYTES_PER_SECOND * 60 * 10;

gatewayUrlInput.value = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

const playbackConfig = fetch("/config")
	.then(async (response) => {
		if (!response.ok) throw new Error(`Gateway configuration request failed (${response.status})`);
		return response.json();
	})
	.then((config) => {
		if (typeof config.defaultSessionId === "string") sessionIdInput.value = config.defaultSessionId;
		return config;
	});
void playbackConfig.catch((error) => {
	console.error("Unable to load gateway configuration:", error);
	setSearchStatus(`Gateway setup unavailable: ${error.message}`);
});

const audioClient = new WebAudioClient();
let followsPublisher = false;
let listeningSessionId = null;
let recordingActive = false;
let recordedChunks = [];
let recordedBytes = 0;
let receivedPcmFrames = 0;
let receivedPcmBytes = 0;
let pcmWatchdog = null;
let currentActiveFilters = new Set();

function setStatus(message) {
	statusElement.textContent = message;
}

function setSearchStatus(message) {
	searchStatusElement.textContent = message;
}

function setControlStatus(message) {
	controlStatusElement.textContent = message;
}

async function sendPlaybackControl(action, values = {}) {
	const sessionId = sessionIdInput.value.trim();
	if (!sessionId) throw new Error("Enter the player ID to control");
	const response = await fetch("/control", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId, action, ...values }),
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || `Control request failed (${response.status})`);
	setControlStatus(`${action} applied to ${result.sessionId}`);
	await refreshPlayerState();
}

function reportControlError(error) {
	console.error("Playback control failed:", error);
	setControlStatus(`Control failed: ${error.message}`);
}

function displayTrack(track) {
	if (!track) return "No track";
	const duration = track.isLive ? "LIVE" : formatDuration((track.duration || 0) / 1000);
	return `${track.title}${track.author ? ` — ${track.author}` : ""} (${duration})`;
}

function renderTrackList(element, tracks, emptyMessage) {
	element.replaceChildren();
	if (!tracks.length) {
		const empty = document.createElement("li");
		empty.textContent = emptyMessage;
		element.append(empty);
		return;
	}
	for (const track of tracks) {
		const item = document.createElement("li");
		item.textContent = displayTrack(track);
		element.append(item);
	}
}

async function refreshPlayerState() {
	const sessionId = sessionIdInput.value.trim();
	if (!sessionId) return;
	try {
		const response = await fetch(`/player-state?sessionId=${encodeURIComponent(sessionId)}`);
		const state = await response.json();
		if (response.status === 404) {
			currentTrackElement.textContent = "No player created yet";
			renderTrackList(queueListElement, [], "Queue is empty");
			renderTrackList(relatedListElement, [], "No related tracks");
			currentActiveFilters = new Set();
			filterSelect.replaceChildren(new Option("No player selected", ""));
			filterStatusElement.textContent = "No player selected";
			loopModeSelect.value = "off";
			autoplayInput.checked = false;
			volumeInput.value = "100";
			volumeValue.textContent = "100%";
			return;
		}
		if (!response.ok) throw new Error(state.error || `Player state request failed (${response.status})`);
		currentTrackElement.textContent = displayTrack(state.currentTrack);
		renderTrackList(queueListElement, state.tracks, "Queue is empty");
		renderTrackList(relatedListElement, state.related, "No related tracks");
		loopModeSelect.value = state.loopMode;
		autoplayInput.checked = state.autoPlay;
		volumeInput.value = String(state.volume);
		volumeValue.textContent = `${state.volume}%`;
		const activeNames = new Set(state.activeFilters.map((filter) => filter.name));
		currentActiveFilters = activeNames;
		const selectedFilter = filterSelect.value;
		filterSelect.replaceChildren(new Option("Select a filter", ""));
		for (const filter of state.filters) {
			filterSelect.add(new Option(`${filter.description}${activeNames.has(filter.name) ? " (active)" : ""}`, filter.name));
		}
		if (state.filters.some((filter) => filter.name === selectedFilter)) filterSelect.value = selectedFilter;
		filterStatusElement.textContent = activeNames.size ? `Active: ${[...activeNames].join(", ")}` : "No active filters";
	} catch (error) {
		console.error("Unable to load player state:", error);
		filterStatusElement.textContent = `Unable to load player state: ${error.message}`;
	}
}

function updateRecordingControls(message) {
	const isConfigured = audioClient.config !== null;
	if (message) recordingStatusElement.textContent = message;
	else if (recordingActive) {
		recordingStatusElement.textContent = `Recording ${formatDuration(recordedBytes / BYTES_PER_SECOND)} · ${(recordedBytes / (1024 * 1024)).toFixed(1)} MiB`;
	} else if (recordedBytes > 0) {
		recordingStatusElement.textContent = `Captured ${formatDuration(recordedBytes / BYTES_PER_SECOND)} · ${(recordedBytes / (1024 * 1024)).toFixed(1)} MiB`;
	} else {
		recordingStatusElement.textContent = "";
	}
	recordButton.disabled = !isConfigured || (!recordingActive && recordedBytes > 0) || recordedBytes >= MAX_RECORDING_BYTES;
	recordButton.textContent = recordingActive ? "Stop & download WAV" : "Start WAV recording";
	downloadRecordingButton.disabled = recordedBytes === 0;
	clearRecordingButton.disabled = recordedBytes === 0 || recordingActive;
}

function formatDuration(seconds) {
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.floor(seconds % 60);
	return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function armPcmWatchdog() {
	clearTimeout(pcmWatchdog);
	pcmWatchdog = setTimeout(() => {
		if (!audioClient.config) return;
		const message =
			receivedPcmFrames === 0 ?
				"Connected, but no PCM frames arrived. Check the server terminal for stream/decode errors."
			:	"No PCM received in the last 5s. The source may have stalled or ended.";
		setStatus(message);
	}, 5000);
}

function createWavHeader(dataBytes) {
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const writeText = (offset, text) => {
		for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
	};
	writeText(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeText(8, "WAVE");
	writeText(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, WEB_AUDIO_CHANNELS, true);
	view.setUint32(24, WEB_AUDIO_SAMPLE_RATE_HZ, true);
	view.setUint32(28, BYTES_PER_SECOND, true);
	view.setUint16(32, WEB_AUDIO_CHANNELS * WEB_AUDIO_SAMPLE_BYTES, true);
	view.setUint16(34, WEB_AUDIO_SAMPLE_BYTES * 8, true);
	writeText(36, "data");
	view.setUint32(40, dataBytes, true);
	return header;
}

function downloadWav() {
	if (!recordedBytes) return false;
	const blob = new Blob([createWavHeader(recordedBytes), ...recordedChunks], { type: "audio/wav" });
	const objectUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");
	const sessionName = (audioClient.sessionId || "ziplayer").replace(/[^a-zA-Z0-9_-]/g, "_");
	link.href = objectUrl;
	link.download = `${sessionName}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
	return true;
}

function onPcm({ detail }) {
	receivedPcmFrames++;
	receivedPcmBytes += detail.payload.byteLength;
	armPcmWatchdog();
	if (recordingActive) {
		const remainingBytes = MAX_RECORDING_BYTES - recordedBytes;
		const capturedBytes = Math.min(detail.payload.byteLength, remainingBytes - (remainingBytes % 4));
		if (capturedBytes > 0) {
			recordedChunks.push(detail.payload.slice(0, capturedBytes));
			recordedBytes += capturedBytes;
		}
		if (recordedBytes >= MAX_RECORDING_BYTES) {
			recordingActive = false;
			updateRecordingControls("Recording reached the 10-minute limit; download or clear it to continue.");
		} else {
			updateRecordingControls();
		}
	}
	const signalStatus = detail.peak < 0.0001 ? "PCM is silent" : "PCM has signal";
	setStatus(
		`${signalStatus} · ${receivedPcmFrames} frames · ${(receivedPcmBytes / BYTES_PER_SECOND).toFixed(1)}s · AudioContext ${audioClient.state}`,
	);
}

audioClient.addEventListener("statechange", ({ detail }) => {
	if (detail.state === "connected") {
		disconnectButton.disabled = false;
		setStatus(followsPublisher ? "Ready; waiting for audio from this player" : "Connected; waiting for publisher configuration");
	}
	if (detail.state === "disconnected") {
		followsPublisher = false;
		listeningSessionId = null;
		clearTimeout(pcmWatchdog);
		pcmWatchdog = null;
		receivedPcmFrames = 0;
		receivedPcmBytes = 0;
		connectButton.disabled = false;
		disconnectButton.disabled = true;
		setStatus("Disconnected");
		updateRecordingControls();
	}
});

audioClient.addEventListener("connected", ({ detail }) => {
	followsPublisher = detail.nextPublisher;
});

audioClient.addEventListener("config", ({ detail }) => {
	sessionIdInput.value = detail.sessionId;
	receivedPcmFrames = 0;
	receivedPcmBytes = 0;
	clearTimeout(pcmWatchdog);
	armPcmWatchdog();
	setStatus(`Connected to ${detail.sessionId}; waiting for PCM frames`);
	updateRecordingControls();
});

audioClient.addEventListener("pcm", onPcm);
audioClient.addEventListener("sequencegap", ({ detail }) => {
	console.warn(`PCM sequence gap: expected ${detail.expectedSequence}, received ${detail.receivedSequence}`);
});
audioClient.addEventListener("error", ({ detail }) => {
	console.error("Web audio client error:", detail.error);
	setStatus(`Web audio error: ${detail.error.message}`);
});
audioClient.addEventListener("close", ({ detail }) => {
	console.warn(`Audio listener closed (${detail.code}${detail.reason ? `: ${detail.reason}` : ""})`);
});

async function connectToSession({ nextPublisher = false, sessionId = sessionIdInput.value.trim() } = {}) {
	connectButton.disabled = true;
	setStatus("Starting browser audio output…");
	try {
		if (sessionId) sessionIdInput.value = sessionId;
		await audioClient.connect({
			gatewayUrl: gatewayUrlInput.value,
			sessionId,
			nextPublisher,
		});
		listeningSessionId = sessionId || null;
		return true;
	} catch (error) {
		console.error("Unable to connect Web audio client:", error);
		setStatus(`Unable to start audio: ${error.message}`);
		connectButton.disabled = false;
		disconnectButton.disabled = true;
		return false;
	}
}

async function stopClient() {
	recordingActive = false;
	await audioClient.disconnect();
	followsPublisher = false;
}

connectForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void connectToSession();
});

disconnectButton.addEventListener("click", () => void stopClient());
recordButton.addEventListener("click", () => {
	if (recordingActive) {
		recordingActive = false;
		if (!downloadWav()) {
			updateRecordingControls("No PCM audio has been captured yet.");
			return;
		}
		recordedChunks = [];
		recordedBytes = 0;
		updateRecordingControls("Recording downloaded.");
		return;
	}
	if (recordedBytes > 0) return;
	recordingActive = true;
	updateRecordingControls("Recording stream to WAV; playback continues.");
});
downloadRecordingButton.addEventListener("click", () => {
	if (downloadWav())
		updateRecordingControls(recordingActive ? "Downloaded current snapshot; recording continues." : "WAV downloaded.");
});
clearRecordingButton.addEventListener("click", () => {
	if (recordingActive) return;
	recordedChunks = [];
	recordedBytes = 0;
	updateRecordingControls("Recording cleared.");
});

searchForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	searchButton.disabled = true;
	setSearchStatus("Searching with ZiPlayer plugins…");
	try {
		const config = await playbackConfig;
		const sessionId = sessionIdInput.value.trim() || config.defaultSessionId;
		if (!sessionId) throw new Error("Enter the player ID for this playback session");
		sessionIdInput.value = sessionId;
		if (!(followsPublisher && audioClient.state === "connected" && listeningSessionId === sessionId)) {
			if (audioClient.state !== "disconnected") await audioClient.disconnect();
			const listenerReady = await connectToSession({ nextPublisher: true, sessionId });
			if (!listenerReady) throw new Error("Could not connect a listener before starting playback");
		}
		const response = await fetch("/play", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: searchQueryInput.value, sessionId }),
		});
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || `Search failed (${response.status})`);
		if (!result.sessionId) throw new Error("Track was queued, but the player session is not available yet");
		if (sessionIdInput.value && sessionIdInput.value !== result.sessionId) {
			throw new Error("The audio publisher session did not match the listener session");
		}
		setSearchStatus(`Added to playback: ${result.track.title}`);
		await refreshPlayerState();
		if (result.track.url) console.info(`Selected track: ${result.track.title} (${result.track.url})`);
	} catch (error) {
		console.error("Web track search failed:", error);
		setSearchStatus(`Search failed: ${error.message}`);
	} finally {
		searchButton.disabled = false;
	}
});

pauseButton.addEventListener("click", () => void sendPlaybackControl("pause").catch(reportControlError));
resumeButton.addEventListener("click", () => void sendPlaybackControl("resume").catch(reportControlError));
stopPlaybackButton.addEventListener("click", () => void sendPlaybackControl("stop").catch(reportControlError));
skipButton.addEventListener("click", () => void sendPlaybackControl("skip").catch(reportControlError));
seekForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const seconds = Number(seekPositionInput.value);
	if (!Number.isFinite(seconds) || seconds < 0) {
		setControlStatus("Seek position must be a non-negative number of seconds.");
		return;
	}
	void sendPlaybackControl("seek", { positionMs: seconds * 1000 }).catch(reportControlError);
});
volumeInput.addEventListener("input", () => {
	volumeValue.textContent = `${volumeInput.value}%`;
});
volumeInput.addEventListener("change", () => {
	void sendPlaybackControl("volume", { volume: Number(volumeInput.value) }).catch(reportControlError);
});
loopModeSelect.addEventListener("change", () => {
	void sendPlaybackControl("loop", { mode: loopModeSelect.value }).catch(reportControlError);
});
autoplayInput.addEventListener("change", () => {
	void sendPlaybackControl("autoplay", { enabled: autoplayInput.checked }).catch(reportControlError);
});
applyFilterButton.addEventListener("click", () => {
	const filterName = filterSelect.value;
	if (!filterName) {
		filterStatusElement.textContent = "Choose a filter first.";
		return;
	}
	const isActive = currentActiveFilters.has(filterName);
	void sendPlaybackControl("filter", { filterName, enabled: !isActive })
		.then(() => {
			filterStatusElement.textContent = `${isActive ? "Removed" : "Applied"} ${filterName}`;
		})
		.catch(reportControlError);
});
clearFiltersButton.addEventListener("click", () => {
	void sendPlaybackControl("filter-clear")
		.then(() => {
			filterStatusElement.textContent = "Cleared all filters";
		})
		.catch(reportControlError);
});
sessionIdInput.addEventListener("change", () => void refreshPlayerState());
void refreshPlayerState();
setInterval(() => void refreshPlayerState(), 3000);

window.addEventListener("beforeunload", () => void audioClient.disconnect());
