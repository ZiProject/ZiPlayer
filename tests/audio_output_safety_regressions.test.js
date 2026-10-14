const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	isBlockedIpAddress,
	parseMediaUrl,
	resolveFfmpegExecutable,
	resolveAudioProcessingOptions,
	getFfmpegProcessStats,
} = require("../core/dist");

test("URL safety distinguishes domain names from IP literals and blocks private address ranges", () => {
	assert.equal(isBlockedIpAddress("example.com"), false);
	assert.equal(parseMediaUrl("https://example.com/audio.mp3").hostname, "example.com");
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.1.2",
		"192.168.1.5",
		"169.254.169.254",
		"100.64.1.2",
		"224.0.0.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"ff02::1",
		"::ffff:192.168.1.4",
		"::ffff:c0a8:0104",
		"64:ff9b::a9fe:a9fe",
	]) {
		assert.equal(isBlockedIpAddress(address), true, `${address} should be blocked`);
	}
	for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
		assert.equal(isBlockedIpAddress(address), false, `${address} should be allowed as public IP`);
	}
	assert.throws(() => parseMediaUrl("http://192.168.1.2/private"), /blocked address/i);
	assert.throws(() => parseMediaUrl("file:///etc/passwd"), /http or https/i);
});

test("FFmpeg executable resolution honors explicit path, environment path, bundle, and PATH order without cwd scans", () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ziplayer-ffmpeg-resolution-"));
	const explicit = path.join(temp, "explicit-ffmpeg");
	const environment = path.join(temp, "env-ffmpeg");
	const bundled = path.join(temp, "bundled-ffmpeg");
	for (const candidate of [explicit, environment, bundled]) {
		fs.writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(candidate, 0o755);
	}
	const previous = process.env.FFMPEG_PATH;
	try {
		process.env.FFMPEG_PATH = environment;
		assert.equal(resolveFfmpegExecutable(explicit, bundled), explicit);
		assert.equal(resolveFfmpegExecutable(undefined, bundled), environment);
		delete process.env.FFMPEG_PATH;
		assert.equal(resolveFfmpegExecutable(undefined, bundled), bundled);
		assert.equal(resolveFfmpegExecutable(undefined, undefined), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
	} finally {
		if (previous === undefined) delete process.env.FFMPEG_PATH;
		else process.env.FFMPEG_PATH = previous;
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test("per-engine concurrency validation does not mutate the process-wide FFmpeg limit", () => {
	const before = getFfmpegProcessStats();
	resolveAudioProcessingOptions({ maxConcurrentProcesses: 1 });
	assert.equal(getFfmpegProcessStats().max, before.max);
});

test("FFmpeg cannot bypass redirect-safe URL input using direct URL mode", () => {
	assert.throws(
		() => resolveAudioProcessingOptions({ allowFfmpegUrlInput: true }),
		/disabled.*redirect-by-redirect/i,
	);
});
