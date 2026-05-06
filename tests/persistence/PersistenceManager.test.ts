import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PersistenceManager } from "../../core/src/persistence/PersistenceManager";
import { MockPlayerManager, createMockPlayer, createMockTrack } from "./helpers/mock-manager";

describe("PersistenceManager", () => {
	let testDir: string;
	let mockManager: MockPlayerManager;
	let persistence: PersistenceManager;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `ziplayer_persist_test_${Date.now()}`);
		mockManager = new MockPlayerManager();

		persistence = new PersistenceManager(mockManager as any, {
			enabled: true,
			provider: "file",
			filePath: testDir,
			saveInterval: 1000, // Short interval for testing
			autoLoad: false, // Disable auto-load for testing
			compress: false,
			maxBackups: 3,
		});
	});

	afterEach(async () => {
		await persistence.shutdown();
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("savePlayer", () => {
		it("should save a single player", async () => {
			const mockPlayer = createMockPlayer({
				guildId: "guild123",
				volume: 75,
				isPlaying: true,
				loopMode: "track",
			});

			const result = await persistence.savePlayer(mockPlayer);

			assert.ok(result);

			// Verify file was created
			const files = fs.readdirSync(testDir);
			assert.ok(files.some((f) => f.includes("guild123")));
		});

		it("should return false when persistence is disabled", async () => {
			const disabledPersistence = new PersistenceManager(mockManager as any, {
				enabled: false,
				provider: "file",
				filePath: testDir,
			});

			const mockPlayer = createMockPlayer({ guildId: "guild123" });
			const result = await disabledPersistence.savePlayer(mockPlayer);

			assert.strictEqual(result, false);
			await disabledPersistence.shutdown();
		});

		it("should emit playerSaved event", async () => {
			const events: string[] = [];
			persistence.on("playerSaved", (guildId) => {
				events.push(guildId);
			});

			const mockPlayer = createMockPlayer({ guildId: "guild123" });
			await persistence.savePlayer(mockPlayer);

			assert.deepEqual(events, ["guild123"]);
		});

		it("should serialize track with all fields", async () => {
			const track = createMockTrack({
				id: "track123",
				title: "My Song",
				author: "Artist",
				artwork: "https://artwork.com/img.jpg",
			});

			const mockPlayer = createMockPlayer({
				guildId: "guild123",
				tracks: [track],
				currentTrack: track,
			});

			await persistence.savePlayer(mockPlayer);

			const savedData = JSON.parse(fs.readFileSync(path.join(testDir, "guild123.json"), "utf8"));

			assert.strictEqual(savedData.queue.tracks[0].id, "track123");
			assert.strictEqual(savedData.queue.tracks[0].title, "My Song");
			assert.strictEqual(savedData.queue.tracks[0].author, "Artist");
		});
	});

	describe("saveAll", () => {
		it("should save all players", async () => {
			const player1 = createMockPlayer({ guildId: "guild1" });
			const player2 = createMockPlayer({ guildId: "guild2" });

			// Add players to manager
			(mockManager as any).players.set("guild1", player1);
			(mockManager as any).players.set("guild2", player2);

			const results = await persistence.saveAll();

			assert.strictEqual(results.size, 2);
			assert.ok(results.get("guild1"));
			assert.ok(results.get("guild2"));
		});

		it("should not save when already saving", async () => {
			const player = createMockPlayer({ guildId: "guild1" });
			(mockManager as any).players.set("guild1", player);

			// Start first save
			const savePromise = persistence.saveAll();
			// Try second save while first is in progress
			const secondResult = await persistence.saveAll();

			assert.strictEqual(secondResult.size, 0);
			await savePromise;
		});

		it("should emit savedAll event", async () => {
			const player = createMockPlayer({ guildId: "guild1" });
			(mockManager as any).players.set("guild1", player);

			let eventFired = false;
			persistence.on("savedAll", (results) => {
				eventFired = true;
				assert.strictEqual(results.size, 1);
			});

			await persistence.saveAll();
			assert.ok(eventFired);
		});
	});

	describe("loadPlayer", () => {
		it("should load a saved player", async () => {
			const originalPlayer = createMockPlayer({
				guildId: "guild123",
				volume: 80,
				loopMode: "queue",
				autoPlay: true,
			});

			await persistence.savePlayer(originalPlayer);

			const loaded = await persistence.loadPlayer("guild123");

			assert.ok(loaded);
		});

		it("should return false for non-existent player", async () => {
			const loaded = await persistence.loadPlayer("non-existent");
			assert.strictEqual(loaded, false);
		});

		it("should restore playback position when requested", async () => {
			const player = createMockPlayer({
				guildId: "guild123",
				position: 45000, // 45 seconds
			});

			await persistence.savePlayer(player);

			let restoreCalled = false;
			(player as any).refreshPlayerResource = async (apply: boolean, position?: number) => {
				restoreCalled = true;
				assert.strictEqual(position, 45000);
				return true;
			};

			await persistence.loadPlayer("guild123", true);
			assert.ok(restoreCalled);
		});

		it("should not restore position when disabled", async () => {
			const player = createMockPlayer({
				guildId: "guild123",
				position: 45000,
			});

			await persistence.savePlayer(player);

			let restoreCalled = false;
			(player as any).refreshPlayerResource = async () => {
				restoreCalled = true;
				return true;
			};

			await persistence.loadPlayer("guild123", false);
			assert.strictEqual(restoreCalled, false);
		});

		it("should emit playerLoaded event", async () => {
			const player = createMockPlayer({ guildId: "guild123" });
			await persistence.savePlayer(player);

			let eventFired = false;
			persistence.on("playerLoaded", (guildId, data) => {
				eventFired = true;
				assert.strictEqual(guildId, "guild123");
				assert.ok(data);
			});

			await persistence.loadPlayer("guild123");
			assert.ok(eventFired);
		});
	});

	describe("loadAll", () => {
		it("should load all saved players", async () => {
			const player1 = createMockPlayer({ guildId: "guild1" });
			const player2 = createMockPlayer({ guildId: "guild2" });

			await persistence.savePlayer(player1);
			await persistence.savePlayer(player2);

			const results = await persistence.loadAll(false);

			assert.strictEqual(results.size, 2);
			assert.ok(results.get("guild1"));
			assert.ok(results.get("guild2"));
		});

		it("should emit loadedAll event", async () => {
			const player = createMockPlayer({ guildId: "guild1" });
			await persistence.savePlayer(player);

			let eventFired = false;
			persistence.on("loadedAll", (results) => {
				eventFired = true;
				assert.strictEqual(results.size, 1);
			});

			await persistence.loadAll(false);
			assert.ok(eventFired);
		});
	});

	describe("deletePlayer", () => {
		it("should delete saved player data", async () => {
			const player = createMockPlayer({ guildId: "guild123" });
			await persistence.savePlayer(player);

			// Verify file exists
			assert.ok(fs.existsSync(path.join(testDir, "guild123.json")));

			const deleted = await persistence.deletePlayer("guild123");

			assert.ok(deleted);
			assert.ok(!fs.existsSync(path.join(testDir, "guild123.json")));
		});

		it("should emit playerDeleted event", async () => {
			const player = createMockPlayer({ guildId: "guild123" });
			await persistence.savePlayer(player);

			let eventFired = false;
			persistence.on("playerDeleted", (guildId) => {
				eventFired = true;
				assert.strictEqual(guildId, "guild123");
			});

			await persistence.deletePlayer("guild123");
			assert.ok(eventFired);
		});
	});

	describe("auto-save", () => {
		it("should auto-save at configured interval", async () => {
			// Create new persistence with shorter interval
			const autoSavePersistence = new PersistenceManager(mockManager as any, {
				enabled: true,
				provider: "file",
				filePath: testDir,
				saveInterval: 500,
				autoLoad: false,
			});

			const player = createMockPlayer({ guildId: "guild123" });
			(mockManager as any).players.set("guild123", player);

			// Wait for auto-save to trigger
			await new Promise((resolve) => setTimeout(resolve, 1000));

			const files = fs.readdirSync(testDir);
			assert.ok(files.some((f) => f.includes("guild123")));

			await autoSavePersistence.shutdown();
		});
	});

	describe("error handling", () => {
		it("should handle save errors gracefully", async () => {
			// Create persistence with invalid path
			const invalidPersistence = new PersistenceManager(mockManager as any, {
				enabled: true,
				provider: "file",
				filePath: "/invalid/path/that/does/not/exist",
				saveInterval: 60000,
				autoLoad: false,
			});

			const player = createMockPlayer({ guildId: "guild123" });
			const result = await invalidPersistence.savePlayer(player);

			assert.strictEqual(result, false);
			await invalidPersistence.shutdown();
		});

		it("should emit error event on save failure", async () => {
			const errorPersistence = new PersistenceManager(mockManager as any, {
				enabled: true,
				provider: "file",
				filePath: "/invalid/path",
				saveInterval: 60000,
				autoLoad: false,
			});

			let errorEmitted = false;
			errorPersistence.on("error", () => {
				errorEmitted = true;
			});

			const player = createMockPlayer({ guildId: "guild123" });
			await errorPersistence.savePlayer(player);

			assert.ok(errorEmitted);
			await errorPersistence.shutdown();
		});
	});

	describe("track serialization", () => {
		it("should preserve custom track metadata", async () => {
			const track = createMockTrack({
				id: "track123",
				customField: "custom value",
				anotherField: 12345,
			});

			const player = createMockPlayer({
				guildId: "guild123",
				tracks: [track],
			});

			await persistence.savePlayer(player);

			const savedData = JSON.parse(fs.readFileSync(path.join(testDir, "guild123.json"), "utf8"));

			assert.strictEqual(savedData.queue.tracks[0].customField, "custom value");
			assert.strictEqual(savedData.queue.tracks[0].anotherField, 12345);
		});

		it("should handle tracks without optional fields", async () => {
			const track = createMockTrack({
				author: undefined,
				artwork: undefined,
			});

			const player = createMockPlayer({
				guildId: "guild123",
				tracks: [track],
			});

			// Should not throw
			await persistence.savePlayer(player);

			const savedData = JSON.parse(fs.readFileSync(path.join(testDir, "guild123.json"), "utf8"));

			assert.ok(savedData);
		});
	});

	describe("shutdown", () => {
		it("should save all players on shutdown", async () => {
			const player = createMockPlayer({ guildId: "guild123" });
			(mockManager as any).players.set("guild123", player);

			await persistence.shutdown();

			const files = fs.readdirSync(testDir);
			assert.ok(files.some((f) => f.includes("guild123")));
		});

		it("should clear save interval on shutdown", async () => {
			// @ts-ignore - access private property for testing
			assert.ok(persistence.saveInterval);

			await persistence.shutdown();

			// @ts-ignore
			assert.strictEqual(persistence.saveInterval, null);
		});
	});
});
