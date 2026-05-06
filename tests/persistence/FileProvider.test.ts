import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileProvider } from "../../core/src/persistence/PersistenceManager";

// Note: You'll need to export FileProvider from PersistenceManager
// or create a separate file for it

describe("FileProvider", () => {
	let testDir: string;
	let provider: FileProvider;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `ziplayer_test_${Date.now()}`);
		provider = new FileProvider(testDir, 3);
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should save and load data", async () => {
		const testData = { name: "test", value: 123 };

		await provider.save("test-key", testData);
		const loaded = await provider.load("test-key");

		assert.deepEqual(loaded, testData);
	});

	it("should return null for non-existent key", async () => {
		const loaded = await provider.load("non-existent");
		assert.strictEqual(loaded, null);
	});

	it("should delete data", async () => {
		await provider.save("test-key", { data: "test" });
		await provider.delete("test-key");
		const loaded = await provider.load("test-key");

		assert.strictEqual(loaded, null);
	});

	it("should list all keys", async () => {
		await provider.save("key1", { data: 1 });
		await provider.save("key2", { data: 2 });
		await provider.save("key3", { data: 3 });

		const keys = await provider.list();
		assert.deepEqual(keys.sort(), ["key1", "key2", "key3"]);
	});

	it("should compress data when enabled", async () => {
		const testData = { name: "test", content: "x".repeat(1000) };

		await provider.save("compressed-key", testData, true);

		// Check that .gz file exists
		const gzPath = path.join(testDir, "compressed-key.json.gz");
		assert.ok(fs.existsSync(gzPath));

		// Should still load correctly
		const loaded = await provider.load("compressed-key");
		assert.deepEqual(loaded, testData);
	});

	it("should create backup before overwriting", async () => {
		await provider.save("backup-test", { version: 1 });
		await provider.save("backup-test", { version: 2 });

		const files = fs.readdirSync(testDir);
		const backups = files.filter((f) => f.includes("backup"));

		assert.ok(backups.length >= 1);
	});

	it("should limit number of backups", async () => {
		// Save multiple times to create backups
		for (let i = 0; i < 10; i++) {
			await provider.save("backup-limit", { version: i });
		}

		const files = fs.readdirSync(testDir);
		const backups = files.filter((f) => f.startsWith("backup-limit") && f.includes("backup"));

		// Should keep only maxBackups (3) most recent
		assert.ok(backups.length <= 3);
	});

	it("should restore from backup", async () => {
		await provider.save("restore-test", { version: 1 });
		await provider.save("restore-test", { version: 2 });
		await provider.save("restore-test", { version: 3 });

		const restored = await provider.restoreBackup("restore-test");

		assert.ok(restored);
		const loaded = await provider.load("restore-test");
		assert.notDeepEqual(loaded, { version: 3 });
	});
});
