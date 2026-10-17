const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createOpusAudioResource, demuxOggOpusToPackets, demuxWebmOpusToPackets } = require("../core/dist");

function createOggPage(headerType, granulePosition, serialNumber, pageSeq, segments) {
	const segmentTable = [];
	const body = [];
	for (const segment of segments) {
		let remaining = segment.length;
		while (remaining >= 255) {
			segmentTable.push(255);
			remaining -= 255;
		}
		segmentTable.push(remaining);
		body.push(segment);
	}
	const header = Buffer.alloc(27 + segmentTable.length);
	header.write("OggS", 0);
	header.writeUInt8(0, 4);
	header.writeUInt8(headerType, 5);
	header.writeBigInt64LE(BigInt(granulePosition), 6);
	header.writeUInt32BE(serialNumber, 14);
	header.writeUInt32LE(pageSeq, 18);
	header.writeUInt32LE(0, 22);
	header.writeUInt8(segmentTable.length, 26);
	Buffer.from(segmentTable).copy(header, 27);
	return Buffer.concat([header, ...body]);
}

function createWebmOpus(packets) {
	function encodeVint(value) {
		if (value < 127) return Buffer.from([0x80 | value]);
		if (value < 16383) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
		return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
	}
	function ebmlTag(idHex, data) {
		return Buffer.concat([Buffer.from(idHex, "hex"), encodeVint(data.length), data]);
	}

	const ebml = ebmlTag("1a45dfa3", Buffer.alloc(0));
	const trackNum = ebmlTag("d7", Buffer.from([1]));
	const trackType = ebmlTag("83", Buffer.from([2]));
	const codecPrivate = ebmlTag("63a2", Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11)]));
	const tracks = ebmlTag("1654ae6b", ebmlTag("ae", Buffer.concat([trackNum, trackType, codecPrivate])));
	const blocks = packets.map((packet, index) =>
		ebmlTag("a3", Buffer.concat([Buffer.from([0x81, 0x00, index * 0x14, 0x80]), packet])),
	);
	const cluster = ebmlTag("1f43b675", Buffer.concat(blocks));
	return Buffer.concat([ebml, ebmlTag("18538067", Buffer.concat([tracks, cluster]))]);
}

async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return chunks;
}

test("naturally ended source drains all buffered Opus packets from AudioResource", async () => {
	const packets = [
		Buffer.from([0xf8, 0xff, 0xfe, 0x01]),
		Buffer.from([0xf8, 0xff, 0xfe, 0x02]),
		Buffer.from([0xf8, 0xff, 0xfe, 0x03]),
	];
	const source = Readable.from(packets, { objectMode: true });
	const resource = createOpusAudioResource(source);
	const sourceClosed = new Promise((resolve) => source.once("close", resolve));
	await sourceClosed;

	assert.equal(source.readableEnded, true);
	assert.deepEqual(await collect(resource.playStream), packets);
});

test("naturally ended Ogg source drains final demuxed packets", async () => {
	const serial = 0xabcdef12;
	const page1 = createOggPage(2, 0, serial, 0, [Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11)])]);
	const page2 = createOggPage(0, 0, serial, 1, [Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)])]);
	const packets = [Buffer.from([0xf8, 0xff, 0xfe, 0x01]), Buffer.from([0xf8, 0xff, 0xfe, 0x02])];
	const page3 = createOggPage(0, 960, serial, 2, packets);
	const source = Readable.from([page1, page2, page3]);
	const demuxed = demuxOggOpusToPackets(source);
	const sourceClosed = new Promise((resolve) => source.once("close", resolve));
	await sourceClosed;

	assert.equal(source.readableEnded, true);
	assert.deepEqual(await collect(demuxed), packets);
});

test("naturally ended WebM source drains final demuxed packets", async () => {
	const packets = [Buffer.from([0xf8, 0xff, 0xfe, 0x11]), Buffer.from([0xf8, 0xff, 0xfe, 0x22])];
	const source = Readable.from([createWebmOpus(packets)]);
	const demuxed = demuxWebmOpusToPackets(source);
	const sourceClosed = new Promise((resolve) => source.once("close", resolve));
	await sourceClosed;

	assert.equal(source.readableEnded, true);
	assert.deepEqual(await collect(demuxed), packets);
});

test("prematurely destroyed source closes validator and both demuxers", async () => {
	const source = new Readable({ objectMode: true, read() {} });
	const resource = createOpusAudioResource(source);
	resource.playStream.on("error", () => {});
	const resourceClosed = new Promise((resolve) => resource.playStream.once("close", resolve));
	source.destroy();
	await resourceClosed;
	assert.equal(resource.playStream.destroyed, true);

	for (const demux of [demuxOggOpusToPackets, demuxWebmOpusToPackets]) {
		const upstream = new Readable({ read() {} });
		const downstream = demux(upstream);
		downstream.on("error", () => {});
		const downstreamClosed = new Promise((resolve) => downstream.once("close", resolve));
		upstream.destroy();
		await downstreamClosed;
		assert.equal(downstream.destroyed, true);
	}
});

test("validateDuration false still rejects invalid packets and normalizes Uint8Array packets", async () => {
	const valid10ms = new Uint8Array([0x00, 0x01]);
	const resource = createOpusAudioResource(Readable.from([valid10ms], { objectMode: true }), {
		validateDuration: false,
	});
	const [packet] = await collect(resource.playStream);
	assert.ok(Buffer.isBuffer(packet));
	assert.deepEqual(packet, Buffer.from(valid10ms));

	for (const invalid of [new Uint8Array(0), new Uint8Array([0xf9, 0x01]), "not-an-opus-packet"]) {
		const invalidResource = createOpusAudioResource(Readable.from([invalid], { objectMode: true }), {
			validateDuration: false,
		});
		await assert.rejects(collect(invalidResource.playStream), /Invalid Opus packet/i);
	}
});

test("rejecting byte streams destroys transferred sources but preserves borrowed sources", () => {
	const transferred = new Readable({ read() {} });
	assert.throws(() => createOpusAudioResource(transferred), /object-mode Readable/i);
	assert.equal(transferred.destroyed, true);

	const borrowed = new Readable({ read() {} });
	assert.throws(() => createOpusAudioResource(borrowed, { ownership: "borrow" }), /object-mode Readable/i);
	assert.equal(borrowed.destroyed, false);
	borrowed.destroy();
});

test("transferred iterable packet sources are consumed lazily and closed on cancellation", async () => {
	let yielded = 0;
	let finalized = false;
	function* packets() {
		try {
			for (let index = 0; index < 1000; index++) {
				yielded++;
				yield Buffer.from([0xf8, 0xff, 0xfe, index & 0xff]);
			}
		} finally {
			finalized = true;
		}
	}
	const resource = createOpusAudioResource(packets());
	resource.playStream.on("error", () => {});
	assert.equal(yielded, 0);
	resource.playStream.read();
	assert.ok(yielded < 1000);

	const streamClosed = new Promise((resolve) => resource.playStream.once("close", resolve));
	resource.playStream.destroy();
	await streamClosed;
	assert.equal(finalized, true);
});

test("borrowed iterable packet sources remain open when their adapter is destroyed", async () => {
	let finalized = false;
	function* packets() {
		try {
			yield Buffer.from([0xf8, 0xff, 0xfe, 0x01]);
			yield Buffer.from([0xf8, 0xff, 0xfe, 0x02]);
		} finally {
			finalized = true;
		}
	}
	const source = packets();
	const resource = createOpusAudioResource(source, { ownership: "borrow" });
	resource.playStream.on("error", () => {});
	resource.playStream.read();

	const streamClosed = new Promise((resolve) => resource.playStream.once("close", resolve));
	resource.playStream.destroy();
	await streamClosed;
	assert.equal(finalized, false);
	assert.deepEqual(source.next().value, Buffer.from([0xf8, 0xff, 0xfe, 0x02]));
	assert.equal(finalized, false);
	source.return();
	assert.equal(finalized, true);
});

test("naturally exhausted borrowed iterable is not explicitly returned again", async () => {
	let returnCalls = 0;
	let yielded = false;
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					if (yielded) return { value: undefined, done: true };
					yielded = true;
					return { value: Buffer.from([0xf8, 0xff, 0xfe, 0x01]), done: false };
				},
				return() {
					returnCalls++;
					return { value: undefined, done: true };
				},
			};
		},
	};
	const resource = createOpusAudioResource(source, { ownership: "borrow" });
	assert.deepEqual(await collect(resource.playStream), [Buffer.from([0xf8, 0xff, 0xfe, 0x01])]);
	assert.equal(returnCalls, 0);
});
