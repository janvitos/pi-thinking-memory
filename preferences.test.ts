import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import lockfile from "proper-lockfile";
import {
	decodePreferences,
	encodePreferences,
	modelIdentityKey,
	PreferenceStore,
	type PreferenceRecord,
} from "./preferences.ts";

async function withTempFile(run: (filePath: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-thinking-memory-"));
	try {
		await run(join(directory, "preferences.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("decodePreferences validates entries and keeps the last duplicate", () => {
	const decoded = decodePreferences({
		version: 1,
		preferences: [
			{ provider: "openai", model: "sol", thinkingLevel: "medium" },
			{ provider: "openai", model: "sol", thinkingLevel: "high" },
			{ provider: "", model: "bad", thinkingLevel: "low" },
			{ provider: "openai", model: "bad", thinkingLevel: "turbo" },
		],
	});

	assert.equal(decoded.kind, "current");
	if (decoded.kind !== "current") return;
	assert.deepEqual(decoded.preferences, [{ provider: "openai", model: "sol", thinkingLevel: "high" }]);
	assert.equal(decoded.issues.length, 3);
});

test("decodePreferences distinguishes invalid and future schemas", () => {
	assert.equal(decodePreferences(null).kind, "invalid");
	assert.equal(decodePreferences({ version: 1, preferences: {} }).kind, "invalid");
	assert.deepEqual(decodePreferences({ version: 2, preferences: [] }), { kind: "future", version: 2 });
});

test("model identities and encoding are collision-safe and deterministic", () => {
	assert.notEqual(
		modelIdentityKey({ provider: "a/b", model: "c" }),
		modelIdentityKey({ provider: "a", model: "b/c" }),
	);

	const records: PreferenceRecord[] = [
		{ provider: "z", model: "b", thinkingLevel: "high" },
		{ provider: "a", model: "c", thinkingLevel: "low" },
		{ provider: "a", model: "b", thinkingLevel: "medium" },
	];
	const parsed = JSON.parse(encodePreferences(records));
	assert.deepEqual(
		parsed.preferences.map(({ provider, model }: PreferenceRecord) => `${provider}/${model}`),
		["a/b", "a/c", "z/b"],
	);
});

test("PreferenceStore treats a missing file as empty and writes private state", async () => {
	await withTempFile(async (filePath) => {
		const store = new PreferenceStore(filePath);
		const sol = { provider: "openai", model: "gpt-5.6-sol" };

		assert.equal(await store.get(sol), undefined);
		assert.equal(await store.set(sol, "medium"), true);
		assert.equal(await store.get(sol), "medium");
		assert.equal((await stat(filePath)).mode & 0o777, 0o600);
	});
});

test("concurrent store instances merge updates under the file lock", async () => {
	await withTempFile(async (filePath) => {
		const first = new PreferenceStore(filePath);
		const second = new PreferenceStore(filePath);
		const sol = { provider: "openai", model: "sol" };
		const luna = { provider: "openai", model: "luna" };

		await Promise.all([first.set(sol, "medium"), second.set(luna, "high")]);

		assert.equal(await first.get(sol), "medium");
		assert.equal(await second.get(luna), "high");
		const parsed = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(parsed.preferences.length, 2);
	});
});

test("lock contention longer than the old retry window does not drop an update", async () => {
	await withTempFile(async (filePath) => {
		const release = await lockfile.lock(filePath, { realpath: false });
		const store = new PreferenceStore(filePath);
		const update = store.set({ provider: "openai", model: "sol" }, "medium");

		await delay(750);
		await release();

		assert.equal(await update, true);
		assert.equal(await store.get({ provider: "openai", model: "sol" }), "medium");
	});
});

test("a current malformed file self-heals while retaining valid entries", async () => {
	await withTempFile(async (filePath) => {
		const messages: string[] = [];
		await writeFile(
			filePath,
			JSON.stringify({
				version: 1,
				preferences: [
					{ provider: "openai", model: "sol", thinkingLevel: "medium" },
					{ provider: "openai", model: "bad", thinkingLevel: "turbo" },
				],
			}),
		);
		const store = new PreferenceStore(filePath, (message) => messages.push(message));

		assert.equal(await store.get({ provider: "openai", model: "sol" }), "medium");
		assert.equal(await store.set({ provider: "openai", model: "luna" }, "high"), true);

		const decoded = decodePreferences(JSON.parse(await readFile(filePath, "utf8")));
		assert.equal(decoded.kind, "current");
		if (decoded.kind === "current") {
			assert.equal(decoded.issues.length, 0);
			assert.equal(decoded.preferences.length, 2);
		}
		assert.ok(messages.some((message) => message.includes("with corrections")));
	});
});

test("a future schema remains untouched", async () => {
	await withTempFile(async (filePath) => {
		const source = `${JSON.stringify({ version: 99, preferences: [] })}\n`;
		const messages: string[] = [];
		await writeFile(filePath, source);
		const store = new PreferenceStore(filePath, (message) => messages.push(message));

		assert.equal(await store.set({ provider: "openai", model: "sol" }, "medium"), false);
		assert.equal(await readFile(filePath, "utf8"), source);
		assert.ok(messages.some((message) => message.includes("Refusing to overwrite")));
	});
});
