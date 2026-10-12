import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";
import { PassThrough, Readable } from "node:stream";
import type {
	AudioFrameFormat,
	AudioOutputBackend,
	AudioOutputCapabilities,
	AudioOutputContext,
	AudioOutputEvent,
	AudioOutputHandle,
	AudioOutputInput,
	AudioOutputState,
} from "./AudioOutputBackend";
import { AudioOutputUnsupportedOperationError, createAudioAbortError } from "./AudioOutputBackend";

const DEFAULT_SECONDARY_QUEUE_BYTES = 192 * 1024;
const PROCESS_OUTPUTS = ["pcm16le", "pcmFloat32", "encoded"] as const;
type ProcessOutput = (typeof PROCESS_OUTPUTS)[number];

export interface AudioOutputRegistrationOptions {
	id: string;
	name?: string;
	/** Whether Player.volume should be sent to this output. Dynamic outputs default to false. */
	playerVolume?: boolean;
}

export interface AudioOutputInfo {
	id: string;
	name: string;
	state: AudioOutputState;
	activeSessions: number;
	droppedChunks: number;
	droppedBytes: number;
	capabilities: AudioOutputCapabilities;
}

interface OutputRecord {
	id: string;
	name: string;
	backend: AudioOutputBackend<any>;
	playerVolume: boolean;
	droppedChunks: number;
	droppedBytes: number;
	detachPacingListener?: () => void;
}

interface TeeBranch {
	id: string;
	stream: PassThrough;
	active: boolean;
	maxQueuedBytes: number;
	droppedChunks: number;
	droppedBytes: number;
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function processOutputForFormat(format: AudioFrameFormat): ProcessOutput {
	if (format.kind === "encoded") return "encoded";
	return format.sampleFormat === "f32" ? "pcmFloat32" : "pcm16le";
}

function acceptedOutputs(backend: AudioOutputBackend<any>): readonly ProcessOutput[] {
	return backend.capabilities.acceptedProcessOutputs ?? PROCESS_OUTPUTS;
}

function formatAccepted(backend: AudioOutputBackend<any>, format: AudioFrameFormat): boolean {
	return acceptedOutputs(backend).includes(processOutputForFormat(format));
}

/**
 * A byte-stream fan-out. Exactly one branch is allowed to apply backpressure to the source;
 * all other branches have a bounded readable queue and drop whole source chunks when full.
 */
class AudioStreamTee {
	private readonly branches = new Map<string, TeeBranch>();
	private readonly masterChangedListeners = new Set<() => void>();
	private started = false;
	private closed = false;
	private ended = false;

	public constructor(
		private readonly source: Readable,
		private readonly selectMaster: () => string | undefined,
		private readonly onSourceError: (error: Error) => void,
		private readonly secondaryQueueBytes = DEFAULT_SECONDARY_QUEUE_BYTES,
	) {}

	private readonly progressListeners = new Set<() => void>();

	public hasEnded(): boolean {
		return this.closed || this.ended;
	}

	public addBranch(id: string, maxQueuedBytes = this.secondaryQueueBytes): TeeBranch {
		if (this.closed || this.ended) throw new Error("Cannot attach an output to an ended audio stream");
		if (this.branches.has(id)) throw new Error(`Audio output branch already exists: ${id}`);
		const queueLimit = Math.max(4, Math.min(this.secondaryQueueBytes, Math.floor(maxQueuedBytes)));
		const stream = new PassThrough({ highWaterMark: queueLimit });
		stream.setMaxListeners(0);
		const origRead = stream._read.bind(stream);
		stream._read = (size) => {
			this.start();
			const result = origRead(size);
			this.notifyProgress();
			return result;
		};
		const branch: TeeBranch = {
			id,
			stream,
			active: true,
			maxQueuedBytes: queueLimit,
			droppedChunks: 0,
			droppedBytes: 0,
		};
		stream.once("close", () => {
			branch.active = false;
			this.notifyProgress();
			if (this.branches.size > 0 && [...this.branches.values()].every((b) => !b.active || b.stream.destroyed)) {
				this.close();
			}
		});
		this.branches.set(id, branch);
		this.notifyMasterChanged();
		return branch;
	}

	public removeBranch(id: string): void {
		const branch = this.branches.get(id);
		if (!branch) return;
		branch.active = false;
		this.branches.delete(id);
		if (!branch.stream.destroyed) branch.stream.destroy();
		this.notifyMasterChanged();
		this.notifyProgress();
		if (this.branches.size === 0 && this.started && !this.closed && !this.ended) this.destroySource();
	}

	public stats(id: string): { droppedChunks: number; droppedBytes: number } {
		const branch = this.branches.get(id);
		return { droppedChunks: branch?.droppedChunks ?? 0, droppedBytes: branch?.droppedBytes ?? 0 };
	}

	public notifyMasterChanged(): void {
		for (const listener of [...this.masterChangedListeners]) listener();
	}

	private notifyProgress(): void {
		for (const listener of [...this.progressListeners]) listener();
	}

	public start(): void {
		if (this.started || this.closed || this.ended) return;
		this.started = true;
		void this.pump();
	}

	public close(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.destroySource();
		for (const branch of this.branches.values()) {
			branch.active = false;
			if (!branch.stream.destroyed) branch.stream.destroy(error);
		}
		this.branches.clear();
		this.notifyMasterChanged();
		this.notifyProgress();
	}

	private destroySource(): void {
		if (!this.source.destroyed) this.source.destroy();
	}

	private async waitForMasterAvailability(): Promise<string | undefined> {
		while (!this.closed && !this.ended) {
			if (this.branches.size > 0 && [...this.branches.values()].every((b) => !b.active || b.stream.destroyed)) {
				this.close();
				return undefined;
			}
			const master = this.selectMaster();
			if (master) return master;
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					this.masterChangedListeners.delete(finish);
					resolve();
				};
				this.masterChangedListeners.add(finish);
				if (this.closed || this.ended || this.selectMaster()) finish();
			});
		}
		return undefined;
	}

	private async waitForMasterProgress(branch: TeeBranch): Promise<void> {
		while (!this.closed && !this.ended && branch.active && branch.stream.readableLength >= branch.maxQueuedBytes) {
			if (this.selectMaster() !== branch.id) return;
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					this.progressListeners.delete(finish);
					this.masterChangedListeners.delete(finish);
					resolve();
				};
				this.progressListeners.add(finish);
				this.masterChangedListeners.add(finish);
				branch.stream.once("close", finish);
				if (this.closed || this.ended || !branch.active || branch.stream.readableLength < branch.maxQueuedBytes) finish();
			});
		}
	}

	private async pump(): Promise<void> {
		try {
			for await (const value of this.source) {
				if (this.closed) break;
				if (this.branches.size > 0 && [...this.branches.values()].every((b) => !b.active || b.stream.destroyed)) {
					this.close();
					break;
				}
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				// If no real-time sink is available, hold this chunk and stop pulling from the source
				// until a voice subscription returns or another output becomes available.
				const masterId = await this.waitForMasterAvailability();
				if (!masterId || this.closed) break;
				for (const branch of [...this.branches.values()]) {
					if (!branch.active || branch.stream.destroyed) continue;
					const isMaster = branch.id === masterId;
					if (!isMaster && branch.stream.readableLength + chunk.length > branch.maxQueuedBytes) {
						branch.droppedChunks++;
						branch.droppedBytes += chunk.length;
						continue;
					}
					branch.stream.write(chunk);
					if (isMaster && branch.stream.readableLength >= branch.maxQueuedBytes) {
						await this.waitForMasterProgress(branch);
					}
					if (this.closed) break;
				}
			}
			this.ended = true;
			for (const branch of this.branches.values()) {
				if (branch.active && !branch.stream.destroyed) branch.stream.end();
			}
		} catch (error) {
			const err = normalizeError(error);
			for (const branch of this.branches.values()) {
				if (branch.active && !branch.stream.destroyed) branch.stream.destroy(err);
			}
			if (!this.closed) this.onSourceError(err);
		} finally {
			this.ended = true;
			this.notifyMasterChanged();
		}
	}
}

/**
 * Owns multiple sinks while exposing a single AudioOutputBackend to PlaybackController.
 * The encoded/PCM source is produced once and fanned out; it never creates another DSP process.
 */
export class MultiAudioOutputBackend implements AudioOutputBackend<AudioResource> {
	public readonly ready = Promise.resolve();
	private readonly outputs = new Map<string, OutputRecord>();
	private readonly handles = new Set<MultiAudioOutputHandle>();
	private disposed = false;
	private disposePromise?: Promise<void>;

	public constructor(initialBackend: AudioOutputBackend<any>, initial: AudioOutputRegistrationOptions) {
		this.validateRegistration(initial);
		this.validateBackend(initialBackend);
		this.outputs.set(initial.id, {
			id: initial.id,
			name: initial.name ?? initial.id,
			backend: initialBackend,
			playerVolume: initial.playerVolume ?? true,
			droppedChunks: 0,
			droppedBytes: 0,
		});
		this.subscribePacingChanges(this.outputs.get(initial.id)!);
	}

	public get capabilities(): AudioOutputCapabilities {
		const records = [...this.outputs.values()];
		if (records.length === 0) {
			return {
				pause: false,
				resume: false,
				stop: false,
				seek: "unsupported",
				replacement: "unsupported",
				ownership: "transfer",
				volume: "unsupported",
				backpressure: "bounded",
				maxBufferedBytes: DEFAULT_SECONDARY_QUEUE_BYTES,
				acceptedProcessOutputs: [],
				preferredProcessOutput: "pcm16le",
			};
		}
		const allAccepted = records.map((record) => acceptedOutputs(record.backend));
		const accepted = PROCESS_OUTPUTS.filter((format) => allAccepted.every((list) => list.includes(format)));
		const boundedCaps = records
			.map((record) => record.backend.capabilities)
			.filter((caps) => caps.backpressure === "bounded" && caps.maxBufferedBytes != null)
			.map((caps) => caps.maxBufferedBytes as number);
		// The narrowest sink determines the output when present (e.g. WebSocket requires PCM).
		// Otherwise preserve the initial backend's preference for backwards compatibility.
		const preferenceRecord =
			records.find((record) => acceptedOutputs(record.backend).length < PROCESS_OUTPUTS.length) ?? records[0];
		const preferredCandidate = preferenceRecord.backend.capabilities.preferredProcessOutput;
		const preferred = preferredCandidate && accepted.includes(preferredCandidate) ? preferredCandidate : accepted[0];
		return {
			pause: records.every((record) => record.backend.capabilities.pause),
			resume: records.every((record) => record.backend.capabilities.resume),
			stop: records.every((record) => record.backend.capabilities.stop),
			seek:
				records.some((record) => record.backend.capabilities.seek === "unsupported") ? "unsupported"
				: records.some((record) => record.backend.capabilities.seek === "replace") ? "replace"
				: "native",
			replacement:
				records.some((record) => record.backend.capabilities.replacement === "unsupported") ? "unsupported"
				: records.some((record) => record.backend.capabilities.replacement === "stop-before-start") ? "stop-before-start"
				: "atomic",
			ownership: "transfer",
			volume:
				records.some((record) => record.playerVolume && record.backend.capabilities.volume === "backend") ? "backend" : (
					"unsupported"
				),
			backpressure: this.selectMasterRecord()?.backend.capabilities.backpressure === "source" ? "source" : "bounded",
			maxBufferedBytes: boundedCaps.length ? Math.min(...boundedCaps) : DEFAULT_SECONDARY_QUEUE_BYTES,
			acceptedProcessOutputs: accepted,
			preferredProcessOutput: preferred,
		};
	}

	public get requiresPcmProcessing(): boolean {
		return [...this.outputs.values()].some((record) => {
			const accepted = acceptedOutputs(record.backend);
			return !accepted.includes("encoded") && accepted.includes("pcm16le");
		});
	}

	public get hasOutput(): boolean {
		return this.outputs.size > 0;
	}

	public hasOutputId(id: string): boolean {
		return this.outputs.has(id);
	}

	public async initialize(signal?: AbortSignal): Promise<void> {
		if (this.disposed) throw new Error("Multi audio output backend is disposed");
		if (signal?.aborted) throw createAudioAbortError();
		const records = [...this.outputs.values()];
		const results = await Promise.allSettled(records.map((record) => record.backend.initialize(signal)));
		const failures = results.flatMap((result, index) =>
			result.status === "rejected" ? [{ record: records[index], reason: result.reason }] : [],
		);
		for (const failure of failures) {
			// Initializing a secondary output must not take down a healthy sink. Remove failed
			// outputs before track creation so format negotiation and pacing are recomputed.
			await this.removeBackend(failure.record.id).catch(() => false);
		}
		if (signal?.aborted) throw createAudioAbortError();
		if (this.outputs.size === 0) {
			if (failures.length === 1) throw failures[0].reason;
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"Every registered audio output failed to initialize",
			);
		}
	}

	public createSession(input: AudioOutputInput, context: AudioOutputContext = {}): AudioOutputHandle<AudioResource> {
		if (this.disposed) throw new Error("Multi audio output backend is disposed");
		if (context.signal?.aborted) {
			if (input.ownership === "transfer" && !input.stream.destroyed) input.stream.destroy();
			throw createAudioAbortError();
		}
		if (!this.outputs.size) {
			if (!input.stream.destroyed) input.stream.destroy();
			throw new Error("No audio output is registered for this player");
		}
		for (const record of this.outputs.values()) {
			if (!formatAccepted(record.backend, input.format)) {
				if (!input.stream.destroyed) input.stream.destroy();
				throw new TypeError(`Output "${record.id}" does not accept ${processOutputForFormat(input.format)} audio`);
			}
		}
		let handle: MultiAudioOutputHandle | undefined;
		const tee = new AudioStreamTee(
			input.stream,
			() => this.selectMasterRecord(handle?.getSinkIds())?.id,
			(error) => {
				for (const activeHandle of this.handles) {
					if (activeHandle.hasTee(tee)) activeHandle.reportTeeError(error);
				}
			},
		);
		handle = new MultiAudioOutputHandle(this, input, context, tee);
		try {
			for (const record of this.outputs.values()) handle.attachSink(record);
			handle.assignResource(this.resolveResource(handle.getSinkHandles(), context.metadata));
			this.handles.add(handle);
			return handle;
		} catch (error) {
			void handle.dispose();
			throw error;
		}
	}

	public async addBackend(backend: AudioOutputBackend<any>, options: AudioOutputRegistrationOptions): Promise<AudioOutputInfo> {
		if (this.disposed) throw new Error("Multi audio output backend is disposed");
		this.validateRegistration(options);
		this.validateBackend(backend);
		const current = this.outputs.get(options.id);
		if (current) {
			if (current.backend === backend) return this.getOutput(options.id)!;
			throw new Error(`Audio output id already exists: ${options.id}`);
		}
		const record: OutputRecord = {
			id: options.id,
			name: options.name ?? options.id,
			backend,
			playerVolume: options.playerVolume ?? false,
			droppedChunks: 0,
			droppedBytes: 0,
		};
		this.outputs.set(record.id, record);
		try {
			await backend.initialize();
			for (const handle of this.handles) await handle.attachSink(record);
			this.subscribePacingChanges(record);
			for (const handle of this.handles) handle.notifyPacingChanged();
			return this.getOutput(record.id)!;
		} catch (error) {
			for (const handle of this.handles) await handle.detachSink(record.id).catch(() => undefined);
			this.outputs.delete(record.id);
			try {
				await backend.dispose();
			} catch {}
			for (const handle of this.handles) handle.notifyPacingChanged();
			throw error;
		}
	}

	public async removeBackend(id: string): Promise<boolean> {
		const record = this.outputs.get(id);
		if (!record) return false;
		this.outputs.delete(id);
		record.detachPacingListener?.();
		const detachResults = await Promise.allSettled([...this.handles].map((handle) => handle.detachSink(id)));
		try {
			await record.backend.dispose();
		} finally {
			for (const handle of this.handles) handle.notifyPacingChanged();
		}
		for (const result of detachResults) {
			if (result.status === "rejected") {
				for (const handle of this.handles) handle.reportTeeError(normalizeError(result.reason));
			}
		}
		return true;
	}

	public listOutputs(): AudioOutputInfo[] {
		return [...this.outputs.values()].map((record) => {
			const snapshots = [...this.handles].map((handle) => handle.getSinkSnapshot(record.id)).filter(Boolean) as Array<{
				state: AudioOutputState;
				droppedChunks: number;
				droppedBytes: number;
			}>;
			return {
				id: record.id,
				name: record.name,
				state: snapshots.find((snapshot) => snapshot.state === "playing")?.state ?? snapshots[0]?.state ?? "ready",
				activeSessions: snapshots.filter(
					(snapshot) => snapshot.state === "playing" || snapshot.state === "buffering" || snapshot.state === "paused",
				).length,
				droppedChunks: record.droppedChunks + snapshots.reduce((total, snapshot) => total + snapshot.droppedChunks, 0),
				droppedBytes: record.droppedBytes + snapshots.reduce((total, snapshot) => total + snapshot.droppedBytes, 0),
				capabilities: record.backend.capabilities,
			};
		});
	}

	public getOutput(id: string): AudioOutputInfo | undefined {
		return this.listOutputs().find((output) => output.id === id);
	}

	public isPacingOutput(id: string, attachedIds?: Iterable<string>): boolean {
		if (attachedIds !== undefined) return this.selectMasterRecord(attachedIds)?.id === id;
		// Prefer sinks that are actually started on a live track. A registered Discord backend
		// may still report a ready voice connection after its current resource has ended; using
		// the registry alone would incorrectly keep it authoritative over a WebSocket sink.
		const startedIds = new Set<string>();
		for (const handle of this.handles) {
			for (const outputId of handle.getSinkIds()) startedIds.add(outputId);
		}
		return this.selectMasterRecord(startedIds.size > 0 ? startedIds : undefined)?.id === id;
	}

	public dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		const handles = [...this.handles];
		const records = [...this.outputs.values()];
		this.outputs.clear();
		for (const record of records) record.detachPacingListener?.();
		this.disposePromise = (async () => {
			await Promise.allSettled(handles.map((handle) => handle.dispose()));
			await Promise.allSettled(records.map((record) => Promise.resolve(record.backend.dispose())));
		})();
		return this.disposePromise;
	}

	public forgetHandle(handle: MultiAudioOutputHandle): void {
		this.handles.delete(handle);
	}

	public getSessionHandle(resource: AudioResource): AudioOutputHandle<AudioResource> {
		for (const handle of this.handles) {
			if (handle.resource === resource) return handle;
		}
		const discord = this.outputs.get("discord")?.backend;
		if (discord && typeof (discord as any).getSessionHandle === "function") {
			return (discord as any).getSessionHandle(resource);
		}
		for (const record of this.outputs.values()) {
			if (typeof (record.backend as any).getSessionHandle === "function") {
				return (record.backend as any).getSessionHandle(resource);
			}
		}
		throw new Error("No output handle is registered for the requested resource");
	}

	public resolveResource(sinks: ReadonlyMap<string, AudioOutputHandle<any>>, metadata: unknown): AudioResource {
		const voice = sinks.get("discord")?.resource;
		if (voice && isAudioResource(voice)) return voice;
		for (const sink of sinks.values()) if (isAudioResource(sink.resource)) return sink.resource;
		const defaultSink = sinks.get("default") ?? sinks.values().next().value;
		if (defaultSink?.resource != null) return defaultSink.resource;
		return createAudioResource(Readable.from([]), { metadata, inputType: StreamType.Arbitrary });
	}

	public selectMasterRecord(attachedIds?: Iterable<string>): OutputRecord | undefined {
		const attached = attachedIds === undefined ? undefined : new Set(attachedIds);
		const records = [...this.outputs.values()].filter((record) => !attached || attached.has(record.id));
		const available = records.filter((record) => record.backend.isAvailableForPacing?.() !== false);
		const sourceBackpressure = available.find((record) => record.backend.capabilities.backpressure === "source");
		return sourceBackpressure ?? available[0];
	}

	public getOutputRecord(id: string): OutputRecord | undefined {
		return this.outputs.get(id);
	}

	private subscribePacingChanges(record: OutputRecord): void {
		record.detachPacingListener = record.backend.onPacingChange?.(() => {
			for (const handle of this.handles) handle.notifyPacingChanged();
		});
	}

	private validateBackend(backend: AudioOutputBackend<any>): void {
		if (
			!backend ||
			typeof backend.createSession !== "function" ||
			typeof backend.initialize !== "function" ||
			!backend.capabilities
		) {
			throw new TypeError("Audio output backend must implement createSession(), initialize(), and capabilities");
		}
		if (backend.capabilities.ownership !== "transfer" && backend.capabilities.ownership !== "both") {
			throw new TypeError("Multi-output fan-out requires every sink to accept transferred stream ownership");
		}
	}

	private validateRegistration(options: AudioOutputRegistrationOptions): void {
		if (!options || typeof options.id !== "string" || !options.id.trim() || options.id.length > 128) {
			throw new TypeError("Audio output id must be a non-empty string of at most 128 characters");
		}
		if (options.name !== undefined && (typeof options.name !== "string" || options.name.length > 128)) {
			throw new TypeError("Audio output name must be a string of at most 128 characters");
		}
	}
}

class MultiAudioOutputHandle implements AudioOutputHandle<AudioResource> {
	private readonly sinks = new Map<string, AudioOutputHandle<any>>();
	private readonly sinkDetachers = new Map<string, () => void>();
	private readonly listeners = new Set<(event: AudioOutputEvent) => void>();
	private readonly branches = new Map<string, TeeBranch>();
	private readonly startedSinkIds = new Set<string>();
	private stateValue: AudioOutputState = "ready";
	private started = false;
	private starting = false;
	private disposed = false;
	private failed = false;
	private failureError?: Error;
	private readonly startPromises = new Map<string, Promise<void>>();
	private detachSignal?: () => void;
	public resource!: AudioResource;
	public readonly format: AudioFrameFormat;

	public constructor(
		private readonly owner: MultiAudioOutputBackend,
		private readonly input: AudioOutputInput,
		private readonly context: AudioOutputContext,
		private readonly tee: AudioStreamTee,
	) {
		this.format = input.format;
		if (context.signal) {
			const abort = () => void this.dispose();
			if (context.signal.aborted) abort();
			else {
				context.signal.addEventListener("abort", abort, { once: true });
				this.detachSignal = () => context.signal?.removeEventListener("abort", abort);
			}
		}
	}

	public get ready(): Promise<void> {
		return Promise.all([...this.sinks.values()].map((handle) => handle.ready)).then(() => undefined);
	}

	public assignResource(resource: AudioResource): void {
		this.resource = resource;
	}

	public getSinkHandles(): ReadonlyMap<string, AudioOutputHandle<any>> {
		return this.sinks;
	}

	public getSinkIds(): Iterable<string> {
		return this.startedSinkIds.size > 0 ? this.startedSinkIds.values() : this.sinks.keys();
	}

	public get state(): AudioOutputState {
		const master = this.owner.selectMasterRecord(this.getSinkIds());
		const masterState = master ? this.sinks.get(master.id)?.state : undefined;
		// A faster master (usually Discord) can finish slightly before the bounded secondary
		// queue drains. Keep reporting the live sink's state until every sink has finished.
		if (masterState === "ended") {
			const draining = [...this.sinks.values()].find((handle) => !["ended", "stopped", "failed"].includes(handle.state));
			if (draining) return draining.state;
		}
		if (!master && this.started && !["ended", "stopped", "failed"].includes(this.stateValue)) return "paused";
		return masterState ?? this.stateValue;
	}

	public get bufferedBytes(): number | null {
		const master = this.owner.selectMasterRecord(this.getSinkIds());
		return master ? (this.sinks.get(master.id)?.bufferedBytes ?? null) : null;
	}

	public hasTee(tee: AudioStreamTee): boolean {
		return this.tee === tee;
	}

	public reportTeeError(error: Error): void {
		if (this.disposed || this.failed) return;
		this.failed = true;
		this.failureError = error;
		this.stateValue = "failed";
		this.tee.close(error);
		this.emit({ type: "error", error });
	}

	public notifyPacingChanged(): void {
		this.tee.notifyMasterChanged();
		const nextState = this.state;
		if (!this.started || nextState === this.stateValue) return;
		if (nextState === "ended" && !this.areAllSinksFinished()) return;
		this.stateValue = nextState;
		this.emit({ type: "state", state: nextState });
		if (nextState === "ended") queueMicrotask(() => void this.dispose());
	}

	public attachSink(record: OutputRecord): void | Promise<void> {
		if (
			this.disposed ||
			this.stateValue === "ended" ||
			this.stateValue === "stopped" ||
			this.stateValue === "failed" ||
			this.tee.hasEnded()
		)
			return;
		if (this.sinks.has(record.id)) return;
		if (!formatAccepted(record.backend, this.format)) {
			throw new TypeError(
				`Cannot attach output "${record.id}" to an active ${processOutputForFormat(this.format)} track; connect it before the next track`,
			);
		}
		const configuredLimit = record.backend.capabilities.maxBufferedBytes;
		const branchLimit = configuredLimit == null ? DEFAULT_SECONDARY_QUEUE_BYTES : configuredLimit;
		const branch = this.tee.addBranch(record.id, branchLimit);
		try {
			const sinkInput: AudioOutputInput = { stream: branch.stream, format: this.format, ownership: "transfer" };
			const handle = record.backend.createSession(sinkInput, { ...this.context, metadata: this.context.metadata });
			this.sinks.set(record.id, handle);
			this.branches.set(record.id, branch);
			const detach = handle.onEvent((event) => this.onSinkEvent(record, handle, event));
			this.sinkDetachers.set(record.id, detach);
			this.notifyPacingChanged();
			if (this.started || this.starting) {
				return this.startSink(record.id, this.context.signal).catch(async (error) => {
					if (this.owner.isPacingOutput(record.id, this.sinks.keys())) {
						this.failed = true;
						this.stateValue = "failed";
						this.emit({ type: "error", error: normalizeError(error) });
						throw error;
					}
					this.emit({ type: "sinkError", sinkId: record.id, error: normalizeError(error) });
					await this.detachSink(record.id);
					throw error;
				});
			}
		} catch (error) {
			this.sinkDetachers.get(record.id)?.();
			this.sinkDetachers.delete(record.id);
			this.sinks.delete(record.id);
			this.branches.delete(record.id);
			this.tee.removeBranch(record.id);
			throw error;
		}
	}

	public async detachSink(id: string): Promise<void> {
		const handle = this.sinks.get(id);
		this.sinkDetachers.get(id)?.();
		this.sinkDetachers.delete(id);
		this.sinks.delete(id);
		this.startedSinkIds.delete(id);
		this.flushBranchStats(id);
		this.tee.removeBranch(id);
		this.startPromises.delete(id);
		if (handle) {
			try {
				await handle.stop();
			} catch {}
			try {
				await handle.dispose();
			} catch (error) {
				this.emit({ type: "sinkError", sinkId: id, error: normalizeError(error) });
			}
		}
		if (this.sinks.size === 0 && this.started && !this.disposed && this.stateValue !== "ended" && this.stateValue !== "stopped") {
			this.stateValue = "stopped";
			this.tee.close();
			this.emit({ type: "state", state: "stopped" });
		}
		this.notifyPacingChanged();
	}

	public getSinkSnapshot(id: string): { state: AudioOutputState; droppedChunks: number; droppedBytes: number } | null {
		const handle = this.sinks.get(id);
		if (!handle) return null;
		const branch = this.branches.get(id);
		return {
			state: handle.state,
			droppedChunks: branch?.droppedChunks ?? 0,
			droppedBytes: branch?.droppedBytes ?? 0,
		};
	}

	public start(signal?: AbortSignal): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Audio output handle is disposed"));
		if (signal?.aborted || this.context.signal?.aborted) return Promise.reject(createAudioAbortError());
		if (this.started) return Promise.resolve();
		if (this.starting) return Promise.all([...this.startPromises.values()]).then(() => undefined);
		this.starting = true;
		this.stateValue = "buffering";
		this.emit({ type: "state", state: "buffering" });
		for (const [id, sinkHandle] of this.sinks) {
			if (Boolean((sinkHandle as any).backend?.player)) {
				try {
					sinkHandle.start(signal ?? this.context.signal);
					this.startedSinkIds.add(id);
				} catch {}
			}
		}
		const start = async () => {
			try {
				await Promise.all(
					[...this.sinks.keys()].map(async (id) => {
						try {
							await this.startSink(id, signal);
						} catch (error) {
							if (this.owner.isPacingOutput(id, this.sinks.keys())) throw error;
							this.emit({ type: "sinkError", sinkId: id, error: normalizeError(error) });
							await this.owner.removeBackend(id);
						}
					}),
				);
				if (this.disposed || signal?.aborted || this.context.signal?.aborted) throw createAudioAbortError();
				this.started = true;
				this.tee.start();
				this.stateValue = this.state;
				this.emit({ type: "state", state: this.stateValue });
			} catch (error) {
				this.failed = true;
				this.stateValue = "failed";
				this.tee.close();
				throw error;
			} finally {
				this.starting = false;
			}
		};
		return start();
	}

	private startSink(id: string, signal?: AbortSignal): Promise<void> {
		const existing = this.startPromises.get(id);
		if (existing) return existing;
		const handle = this.sinks.get(id);
		const record = this.owner.getOutputRecord(id);
		if (!handle || !record) return Promise.resolve();
		const operation = Promise.resolve().then(async () => {
			await record.backend.initialize(signal ?? this.context.signal);
			await handle.ready;
			if (!this.started && !this.starting) return;
			if (!this.startedSinkIds.has(id)) {
				await handle.start(signal ?? this.context.signal);
				this.startedSinkIds.add(id);
			}
			this.notifyPacingChanged();
		});
		this.startPromises.set(id, operation);
		void operation.catch(() => {
			if (this.startPromises.get(id) === operation) this.startPromises.delete(id);
		});
		return operation;
	}

	public async pause(signal?: AbortSignal): Promise<boolean> {
		this.assertActive(signal);
		const results = await Promise.allSettled([...this.sinks.values()].map((handle) => Promise.resolve(handle.pause(signal))));
		const changed = results.some((result) => result.status === "fulfilled" && result.value);
		if (changed && this.stateValue !== "paused") {
			this.stateValue = "paused";
			this.emit({ type: "state", state: "paused" });
		}
		this.notifyPacingChanged();
		return changed;
	}

	public async resume(signal?: AbortSignal): Promise<boolean> {
		this.assertActive(signal);
		const results = await Promise.allSettled([...this.sinks.values()].map((handle) => Promise.resolve(handle.resume(signal))));
		const changed = results.some((result) => result.status === "fulfilled" && result.value);
		if (changed && this.stateValue !== "playing") {
			this.stateValue = "playing";
			this.emit({ type: "state", state: "playing" });
		}
		this.notifyPacingChanged();
		return changed;
	}

	public async stop(signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) throw createAudioAbortError();
		if (this.disposed || this.stateValue === "stopped" || this.stateValue === "ended") return false;
		this.stateValue = "stopped";
		this.tee.close();
		const sinkEntries = [...this.sinks.entries()];
		const results = await Promise.allSettled(sinkEntries.map(([, handle]) => Promise.resolve(handle.stop(signal))));
		this.emit({ type: "state", state: "stopped" });
		const master = this.owner.selectMasterRecord(this.getSinkIds());
		const masterIndex = master ? sinkEntries.findIndex(([id]) => id === master.id) : 0;
		if (masterIndex !== -1 && results[masterIndex]?.status === "rejected") {
			throw (results[masterIndex] as PromiseRejectedResult).reason;
		}
		return results.some((result) => result.status === "fulfilled" && result.value);
	}

	public async seek(positionMs: number, signal?: AbortSignal): Promise<boolean> {
		this.assertActive(signal);
		if (this.owner.capabilities.seek === "unsupported") throw new AudioOutputUnsupportedOperationError("seek");
		const results = await Promise.all([...this.sinks.values()].map((handle) => Promise.resolve(handle.seek(positionMs, signal))));
		return results.some(Boolean);
	}

	public async replace(input: AudioOutputInput, signal?: AbortSignal): Promise<AudioOutputHandle<AudioResource>> {
		this.assertActive(signal);
		const replacement = this.owner.createSession(input, this.context);
		await replacement.start(signal);
		await this.stop(signal);
		return replacement;
	}

	public async setVolume(value: number, signal?: AbortSignal): Promise<void> {
		this.assertActive(signal);
		const operations: Promise<void>[] = [];
		for (const [id, handle] of this.sinks) {
			const record = this.owner.getOutputRecord(id);
			if (!record?.playerVolume || record.backend.capabilities.volume !== "backend") continue;
			operations.push(Promise.resolve(handle.setVolume(value, signal)));
		}
		await Promise.all(operations);
	}

	public onEvent(listener: (event: AudioOutputEvent) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.detachSignal?.();
		this.detachSignal = undefined;
		this.tee.close(this.failureError);
		for (const detach of this.sinkDetachers.values()) detach();
		this.sinkDetachers.clear();
		const handles = [...this.sinks.values()];
		for (const id of this.branches.keys()) this.flushBranchStats(id);
		this.sinks.clear();
		this.startedSinkIds.clear();
		this.branches.clear();
		const disposeResults = await Promise.allSettled(handles.map((handle) => Promise.resolve(handle.dispose())));
		const failed = disposeResults.find((r): r is PromiseRejectedResult => r.status === "rejected");
		this.listeners.clear();
		this.owner.forgetHandle(this);
		if (this.resource?.playStream && !this.resource.playStream.destroyed) {
			this.resource.playStream.destroy(this.failureError);
		}
		if (failed) throw failed.reason;
	}

	private areAllSinksFinished(): boolean {
		return (
			this.sinks.size > 0 && [...this.sinks.values()].every((handle) => ["ended", "stopped", "failed"].includes(handle.state))
		);
	}

	private flushBranchStats(id: string): void {
		const branch = this.branches.get(id);
		const record = this.owner.getOutputRecord(id);
		if (branch && record) {
			record.droppedChunks += branch.droppedChunks;
			record.droppedBytes += branch.droppedBytes;
		}
		this.branches.delete(id);
	}

	private assertActive(signal?: AbortSignal): void {
		if (this.disposed || this.stateValue === "stopped" || this.stateValue === "ended" || this.stateValue === "failed") {
			throw new Error("Audio output handle is stopped or disposed");
		}
		if (signal?.aborted || this.context.signal?.aborted) throw createAudioAbortError();
	}

	private onSinkEvent(record: OutputRecord, handle: AudioOutputHandle<any>, event: AudioOutputEvent): void {
		if (this.disposed || this.failed || this.sinks.get(record.id) !== handle) return;
		if (event.type === "sinkError") {
			this.emit({ type: "sinkError", sinkId: event.sinkId, error: event.error });
			return;
		}
		if (event.type === "error") {
			if (this.owner.isPacingOutput(record.id, this.getSinkIds())) {
				this.failed = true;
				this.failureError = event.error;
				this.stateValue = "failed";
				this.tee.close(event.error);
				this.emit({ type: "error", error: event.error });
			} else {
				this.emit({ type: "sinkError", sinkId: record.id, error: event.error });
				void this.owner.removeBackend(record.id);
			}
			return;
		}
		if (event.state === "ended") {
			// An ended sink is no longer eligible to pace the shared stream. If it was
			// the master, move pacing to another live sink before the next source chunk.
			this.startedSinkIds.delete(record.id);
			this.tee.notifyMasterChanged();
			if (this.areAllSinksFinished() && this.stateValue !== "ended") {
				this.stateValue = "ended";
				this.emit({ type: "state", state: "ended" });
				queueMicrotask(() => void this.dispose());
			} else {
				this.notifyPacingChanged();
			}
			return;
		}
		if (!this.owner.isPacingOutput(record.id, this.getSinkIds()) || this.stateValue === event.state) return;
		this.stateValue = event.state;
		this.emit({ type: "state", state: event.state });
	}

	private emit(event: AudioOutputEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

function isAudioResource(value: unknown): value is AudioResource {
	return Boolean(
		value && typeof value === "object" && "playbackDuration" in value && "metadata" in value && "playStream" in value,
	);
}
