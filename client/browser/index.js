export const WEB_AUDIO_PROTOCOL_VERSION = 1;
export const WEB_AUDIO_SAMPLE_RATE_HZ = 48_000;
export const WEB_AUDIO_CHANNELS = 2;
export const WEB_AUDIO_SAMPLE_BYTES = 2;
export const WEB_AUDIO_FRAME_HEADER_BYTES = 16;
export const WEB_AUDIO_MAX_MESSAGE_BYTES = 1024 * 1024;

export function parseAudioConfig(message, expectedSessionId) {
	const config = typeof message === "string" ? JSON.parse(message) : message;
	if (
		!config ||
		config.v !== WEB_AUDIO_PROTOCOL_VERSION ||
		config.type !== "audio:config" ||
		typeof config.sessionId !== "string" ||
		!config.sessionId ||
		config.sessionId.length > 128 ||
		(expectedSessionId && config.sessionId !== expectedSessionId) ||
		config.protocolVersion !== WEB_AUDIO_PROTOCOL_VERSION ||
		config.sampleRateHz !== WEB_AUDIO_SAMPLE_RATE_HZ ||
		config.channels !== WEB_AUDIO_CHANNELS ||
		config.sampleFormat !== "s16" ||
		config.endianness !== "little" ||
		config.channelLayout !== "interleaved"
	) {
		throw new Error("Publisher sent an unsupported or mismatched PCM configuration");
	}
	return config;
}

export function decodePcmFrame(data, config, expectedSequence = null) {
	if (
		!(data instanceof ArrayBuffer) ||
		data.byteLength < WEB_AUDIO_FRAME_HEADER_BYTES ||
		data.byteLength > WEB_AUDIO_MAX_MESSAGE_BYTES + WEB_AUDIO_FRAME_HEADER_BYTES
	) {
		throw new Error("Received a malformed PCM frame");
	}
	const view = new DataView(data);
	const sequence = view.getUint32(0, true);
	const timestampMs = view.getUint32(4, true);
	const sampleRateHz = view.getUint16(8, true);
	const channels = view.getUint16(10, true);
	const sampleBytes = view.getUint16(12, true);
	const payloadBytes = data.byteLength - WEB_AUDIO_FRAME_HEADER_BYTES;
	if (
		sampleRateHz !== config.sampleRateHz ||
		channels !== config.channels ||
		sampleBytes !== WEB_AUDIO_SAMPLE_BYTES ||
		payloadBytes === 0 ||
		payloadBytes % (channels * sampleBytes) !== 0
	) {
		throw new Error("Received an invalid PCM frame header or payload");
	}
	const sampleCount = payloadBytes / sampleBytes;
	const samples = new Float32Array(sampleCount);
	let peak = 0;
	for (let index = 0; index < sampleCount; index++) {
		const value = view.getInt16(WEB_AUDIO_FRAME_HEADER_BYTES + index * sampleBytes, true);
		const normalized = value < 0 ? value / 32768 : value / 32767;
		samples[index] = normalized;
		peak = Math.max(peak, Math.abs(normalized));
	}
	return {
		sequence,
		timestampMs,
		samples,
		peak,
		payload: new Uint8Array(data, WEB_AUDIO_FRAME_HEADER_BYTES, payloadBytes),
		sequenceGap: expectedSequence !== null && sequence !== expectedSequence,
	};
}

function createWorkletSource() {
	return `
class ZiPlayerPcmProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this.capacityFrames = options.processorOptions.capacityFrames;
		this.startupBufferFrames = options.processorOptions.startupBufferFrames;
		this.left = new Float32Array(this.capacityFrames);
		this.right = new Float32Array(this.capacityFrames);
		this.readIndex = 0;
		this.writeIndex = 0;
		this.availableFrames = 0;
		this.primed = false;
		this.port.onmessage = ({ data }) => {
			if (data.type === "flush") {
				this.readIndex = 0;
				this.writeIndex = 0;
				this.availableFrames = 0;
				this.primed = false;
				return;
			}
			if (data.type !== "pcm" || !(data.samples instanceof Float32Array)) return;
			this.enqueue(data.samples);
		};
	}

	enqueue(samples) {
		const incomingFrames = Math.floor(samples.length / 2);
		const skipFrames = Math.max(0, incomingFrames - this.capacityFrames);
		const framesToWrite = incomingFrames - skipFrames;
		const overflow = Math.max(0, this.availableFrames + framesToWrite - this.capacityFrames);
		this.readIndex = (this.readIndex + overflow) % this.capacityFrames;
		this.availableFrames -= overflow;
		for (let frame = 0; frame < framesToWrite; frame++) {
			const sourceOffset = (frame + skipFrames) * 2;
			this.left[this.writeIndex] = samples[sourceOffset];
			this.right[this.writeIndex] = samples[sourceOffset + 1];
			this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
		}
		this.availableFrames += framesToWrite;
	}

	process(_inputs, outputs) {
		const output = outputs[0];
		const left = output[0];
		const right = output[1];
		if (!this.primed && this.availableFrames >= this.startupBufferFrames) this.primed = true;
		if (!this.primed) {
			left.fill(0);
			right?.fill(0);
			return true;
		}
		for (let frame = 0; frame < left.length; frame++) {
			if (this.availableFrames === 0) {
				left[frame] = 0;
				if (right) right[frame] = 0;
				this.primed = false;
				continue;
			}
			left[frame] = this.left[this.readIndex];
			if (right) right[frame] = this.right[this.readIndex];
			this.readIndex = (this.readIndex + 1) % this.capacityFrames;
			this.availableFrames--;
		}
		return true;
	}
}

registerProcessor("ziplayer-pcm-output", ZiPlayerPcmProcessor);
`;
}

function dispatchDetail(target, type, detail) {
	target.dispatchEvent(new CustomEvent(type, { detail }));
}

export class WebAudioClient extends EventTarget {
	constructor({
		audioContextFactory = (options) => new AudioContext(options),
		webSocketFactory = (url) => new WebSocket(url),
		startupBufferMs = 100,
		maxBufferSeconds = 2,
		connectTimeoutMs = 5000,
	} = {}) {
		super();
		if (!Number.isFinite(startupBufferMs) || startupBufferMs < 0) {
			throw new TypeError("startupBufferMs must be a non-negative number");
		}
		if (!Number.isFinite(maxBufferSeconds) || maxBufferSeconds <= 0) {
			throw new TypeError("maxBufferSeconds must be a positive number");
		}
		if (startupBufferMs > maxBufferSeconds * 1000) {
			throw new TypeError("startupBufferMs cannot exceed the maximum AudioWorklet buffer duration");
		}
		if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
			throw new TypeError("connectTimeoutMs must be a positive integer");
		}
		this.audioContextFactory = audioContextFactory;
		this.webSocketFactory = webSocketFactory;
		this.startupBufferMs = startupBufferMs;
		this.maxBufferSeconds = maxBufferSeconds;
		this.connectTimeoutMs = connectTimeoutMs;
		this.socket = null;
		this.audioContext = null;
		this.workletNode = null;
		this.sessionId = null;
		this.config = null;
		this.expectedSequence = null;
		this.acceptNextSession = false;
		this.state = "disconnected";
	}

	async connect({ gatewayUrl, token, sessionId, nextPublisher = false } = {}) {
		if (typeof gatewayUrl !== "string" || !gatewayUrl) throw new TypeError("gatewayUrl is required");
		if (typeof token !== "string" || !token) throw new TypeError("token is required");
		if (!nextPublisher && (typeof sessionId !== "string" || !sessionId || sessionId.length > 128)) {
			throw new TypeError("sessionId is required unless nextPublisher is enabled");
		}
		if (this.socket || this.audioContext) await this.disconnect();
		await this.createAudioOutput();

		const url = new URL(nextPublisher ? "/listen-next" : "/listen", gatewayUrl);
		if (typeof sessionId === "string" && sessionId) url.searchParams.set("sessionId", sessionId);
		url.searchParams.set("token", token);
		this.sessionId = nextPublisher ? null : sessionId;
		this.config = null;
		this.expectedSequence = null;
		this.acceptNextSession = nextPublisher;
		this.setState("connecting");

		let socket;
		try {
			socket = this.webSocketFactory(url);
		} catch (error) {
			this.setState("disconnected");
			throw error;
		}
		this.socket = socket;
		socket.binaryType = "arraybuffer";

		try {
			await new Promise((resolve, reject) => {
				let settled = false;
				const timeout = setTimeout(() => finish(new Error("WebSocket listener connection timed out")), this.connectTimeoutMs);
				const cleanup = () => {
					clearTimeout(timeout);
					socket.removeEventListener("open", onOpen);
					socket.removeEventListener("error", onError);
					socket.removeEventListener("close", onClose);
				};
				const finish = (error) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (error) reject(error);
					else resolve();
				};
				const onOpen = () => finish();
				const onError = () => finish(new Error("WebSocket listener connection failed; check gateway URL and token"));
				const onClose = (event) => finish(new Error(`WebSocket listener closed before connecting (${event.code})`));
				socket.addEventListener("open", onOpen, { once: true });
				socket.addEventListener("error", onError, { once: true });
				socket.addEventListener("close", onClose, { once: true });
			});
		} catch (error) {
			if (this.socket === socket) {
				this.socket = null;
				socket.close();
				await this.closeAudioOutput();
				this.setState("disconnected");
			}
			throw error;
		}

		socket.addEventListener("message", (event) => {
			if (this.socket !== socket) return;
			try {
				if (typeof event.data === "string") this.receiveControlMessage(event.data);
				else this.receivePcmFrame(event.data);
			} catch (error) {
				this.reportError(error);
				socket.close(1002, "Invalid audio protocol message");
			}
		});
		socket.addEventListener("close", (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.config = null;
			this.expectedSequence = null;
			this.acceptNextSession = false;
			void this.closeAudioOutput()
				.catch((error) => this.reportError(error))
				.finally(() => {
					this.setState("disconnected");
					dispatchDetail(this, "close", { code: event.code, reason: event.reason });
				});
		});
		socket.addEventListener("error", () => {
			if (this.socket === socket) this.reportError(new Error("WebSocket transport error"));
		});
		this.setState("connected");
		dispatchDetail(this, "connected", { sessionId: this.sessionId, nextPublisher });
		return this;
	}

	async disconnect() {
		const socket = this.socket;
		this.socket = null;
		this.config = null;
		this.expectedSequence = null;
		this.acceptNextSession = false;
		if (socket && socket.readyState < 2) socket.close(1000, "Listener disconnected");
		await this.closeAudioOutput();
		this.setState("disconnected");
	}

	async createAudioOutput() {
		if (this.audioContext) return;
		const context = this.audioContextFactory({ sampleRate: WEB_AUDIO_SAMPLE_RATE_HZ });
		this.audioContext = context;
		if (context.sampleRate !== WEB_AUDIO_SAMPLE_RATE_HZ) {
			await this.closeAudioOutput();
			throw new Error(`Browser audio device must support ${WEB_AUDIO_SAMPLE_RATE_HZ} Hz output`);
		}
		const moduleUrl = URL.createObjectURL(new Blob([createWorkletSource()], { type: "text/javascript" }));
		try {
			await context.audioWorklet.addModule(moduleUrl);
			const startupBufferFrames = Math.round((this.startupBufferMs / 1000) * WEB_AUDIO_SAMPLE_RATE_HZ);
			this.workletNode = new AudioWorkletNode(context, "ziplayer-pcm-output", {
				numberOfInputs: 0,
				numberOfOutputs: 1,
				outputChannelCount: [WEB_AUDIO_CHANNELS],
				processorOptions: {
					capacityFrames: Math.round(this.maxBufferSeconds * WEB_AUDIO_SAMPLE_RATE_HZ),
					startupBufferFrames,
				},
			});
			this.workletNode.connect(context.destination);
			await context.resume();
		} catch (error) {
			await this.closeAudioOutput();
			throw error;
		} finally {
			URL.revokeObjectURL(moduleUrl);
		}
	}

	async closeAudioOutput() {
		this.workletNode?.disconnect();
		this.workletNode = null;
		const context = this.audioContext;
		this.audioContext = null;
		if (context && context.state !== "closed") await context.close();
	}

	receiveControlMessage(payload) {
		let message;
		try {
			message = JSON.parse(payload);
		} catch {
			throw new Error("Received invalid JSON from audio publisher");
		}
		if (!message || message.v !== WEB_AUDIO_PROTOCOL_VERSION || typeof message.type !== "string") {
			throw new Error("Received a malformed or unsupported control message");
		}
		if (message.type === "audio:config") {
			const config = parseAudioConfig(message, this.acceptNextSession ? undefined : this.sessionId);
			this.sessionId = config.sessionId;
			this.acceptNextSession = false;
			this.config = config;
			this.expectedSequence = null;
			this.workletNode?.port.postMessage({ type: "flush" });
			void this.audioContext?.resume().catch((error) => this.reportError(error));
			this.setState("playing");
			dispatchDetail(this, "config", config);
			return;
		}
		if (message.sessionId !== this.sessionId) throw new Error("Received a control message for another session");
		switch (message.type) {
			case "playback:pause":
				void this.audioContext?.suspend().catch((error) => this.reportError(error));
				this.setState("paused");
				break;
			case "playback:resume":
				void this.audioContext?.resume().catch((error) => this.reportError(error));
				this.setState("playing");
				break;
			case "playback:stop":
				this.workletNode?.port.postMessage({ type: "flush" });
				this.setState("waiting");
				break;
			case "error":
				throw new Error(message.message || "Publisher reported an audio error");
			case "playback:state":
				break;
			default:
				dispatchDetail(this, "control", message);
		}
	}

	receivePcmFrame(data) {
		if (!this.config || !this.workletNode) throw new Error("Received PCM before its audio configuration");
		const frame = decodePcmFrame(data, this.config, this.expectedSequence);
		if (frame.sequenceGap) {
			dispatchDetail(this, "sequencegap", {
				expectedSequence: this.expectedSequence,
				receivedSequence: frame.sequence,
			});
		}
		this.expectedSequence = (frame.sequence + 1) >>> 0;
		dispatchDetail(this, "pcm", frame);
		this.workletNode.port.postMessage({ type: "pcm", samples: frame.samples }, [frame.samples.buffer]);
	}

	setState(state) {
		if (this.state === state) return;
		const previousState = this.state;
		this.state = state;
		dispatchDetail(this, "statechange", { state, previousState });
	}

	reportError(error) {
		dispatchDetail(this, "error", { error: error instanceof Error ? error : new Error(String(error)) });
	}
}
