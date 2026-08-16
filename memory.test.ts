import assert from "node:assert/strict";
import test from "node:test";
import { ThinkingMemory, type ThinkingPreferenceStore } from "./memory.ts";
import { modelIdentityKey, type ModelIdentity, type ThinkingLevel } from "./preferences.ts";

class FakeStore implements ThinkingPreferenceStore {
	readonly values = new Map<string, ThinkingLevel>();
	readonly gets: ModelIdentity[] = [];
	readonly sets: Array<{ identity: ModelIdentity; level: ThinkingLevel }> = [];
	getOverride?: (identity: ModelIdentity) => Promise<ThinkingLevel | undefined>;

	async get(identity: ModelIdentity): Promise<ThinkingLevel | undefined> {
		this.gets.push(identity);
		return this.getOverride ? this.getOverride(identity) : this.values.get(modelIdentityKey(identity));
	}

	async set(identity: ModelIdentity, level: ThinkingLevel): Promise<boolean> {
		this.sets.push({ identity, level });
		this.values.set(modelIdentityKey(identity), level);
		return true;
	}

	async drain(): Promise<void> {}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const sol = { provider: "openai", model: "gpt-5.6-sol" };
const luna = { provider: "openai", model: "gpt-5.6-luna" };

function selection(
	identity: ModelIdentity,
	state: { identity: ModelIdentity; level: ThinkingLevel },
	overrides: { source?: "set" | "cycle" | "restore"; pinned?: ThinkingLevel; clamp?: ThinkingLevel } = {},
) {
	return {
		identity,
		source: overrides.source ?? ("set" as const),
		pinnedThinkingLevel: overrides.pinned,
		getCurrentIdentity: () => state.identity,
		getEffectiveLevel: () => state.level,
		applyThinkingLevel: (level: ThinkingLevel) => {
			state.level = overrides.clamp ?? level;
		},
	};
}

test("startup and unseen models preserve Pi's effective level", async () => {
	const store = new FakeStore();
	const memory = new ThinkingMemory(store);
	const state = { identity: luna, level: "high" as ThinkingLevel };

	memory.start(sol, "medium");
	await memory.modelSelected(selection(luna, state));

	assert.equal(state.level, "high");
	assert.deepEqual(store.sets, []);
});

test("ordinary switching restores an exact provider/model preference", async () => {
	const store = new FakeStore();
	store.values.set(modelIdentityKey(sol), "medium");
	const memory = new ThinkingMemory(store);
	const state = { identity: sol, level: "high" as ThinkingLevel };

	memory.start(luna, "high");
	await memory.modelSelected(selection(sol, state, { source: "cycle" }));

	assert.equal(state.level, "medium");
	assert.equal(store.gets.length, 1);
});

test("session restore takes precedence over memory", async () => {
	const store = new FakeStore();
	store.values.set(modelIdentityKey(sol), "medium");
	const memory = new ThinkingMemory(store);
	const state = { identity: sol, level: "high" as ThinkingLevel };
	memory.start(luna, "high");

	await memory.modelSelected(selection(sol, state, { source: "restore" }));

	assert.equal(state.level, "high");
	assert.equal(store.gets.length, 0);
});

test("scoped pins apply for direct selection and remain authoritative for cycling", async () => {
	for (const source of ["set", "cycle"] as const) {
		const store = new FakeStore();
		store.values.set(modelIdentityKey(sol), "medium");
		const memory = new ThinkingMemory(store);
		const state = { identity: sol, level: (source === "set" ? "low" : "high") as ThinkingLevel };
		memory.start(luna, "medium");

		await memory.modelSelected(selection(sol, state, { source, pinned: "high" }));

		assert.equal(state.level, "high");
		assert.equal(store.gets.length, 0);
	}
});

test("clamped restoration normalizes the persisted preference", async () => {
	const store = new FakeStore();
	store.values.set(modelIdentityKey(sol), "max");
	const memory = new ThinkingMemory(store);
	const state = { identity: sol, level: "low" as ThinkingLevel };
	memory.start(luna, "high");

	await memory.modelSelected(selection(sol, state, { clamp: "high" }));

	assert.equal(state.level, "high");
	assert.deepEqual(store.sets, [{ identity: sol, level: "high" }]);
});

test("explicit thinking changes persist while stale and duplicate events do not", async () => {
	const store = new FakeStore();
	const memory = new ThinkingMemory(store);
	memory.start(sol, "medium");

	await memory.thinkingLevelSelected(sol, "medium", "medium");
	await memory.thinkingLevelSelected(sol, "high", "medium");
	await memory.thinkingLevelSelected(luna, "high", "high");
	await memory.thinkingLevelSelected(sol, "high", "high");

	assert.deepEqual(store.sets, [{ identity: sol, level: "high" }]);
});

test("an explicit change during lookup prevents restoration", async () => {
	const store = new FakeStore();
	const pending = deferred<ThinkingLevel | undefined>();
	store.getOverride = () => pending.promise;
	const memory = new ThinkingMemory(store);
	const state = { identity: sol, level: "low" as ThinkingLevel };
	memory.start(luna, "high");

	const switching = memory.modelSelected(selection(sol, state));
	state.level = "high";
	await memory.thinkingLevelSelected(sol, "high", "high");
	pending.resolve("medium");
	await switching;

	assert.equal(state.level, "high");
	assert.deepEqual(store.sets, [{ identity: sol, level: "high" }]);
});

test("a later model switch invalidates an earlier pending restoration", async () => {
	const store = new FakeStore();
	const solLookup = deferred<ThinkingLevel | undefined>();
	store.values.set(modelIdentityKey(luna), "high");
	store.getOverride = (identity) =>
		modelIdentityKey(identity) === modelIdentityKey(sol)
			? solLookup.promise
			: Promise.resolve(store.values.get(modelIdentityKey(identity)));
	const memory = new ThinkingMemory(store);
	const state = { identity: sol, level: "low" as ThinkingLevel };
	memory.start(luna, "medium");

	const firstSwitch = memory.modelSelected(selection(sol, state));
	state.identity = luna;
	state.level = "medium";
	await memory.modelSelected(selection(luna, state));
	assert.equal(state.level, "high");

	solLookup.resolve("max");
	await firstSwitch;
	assert.equal(state.identity, luna);
	assert.equal(state.level, "high");
});

test("provider is part of model identity", async () => {
	const store = new FakeStore();
	const proxySol = { provider: "proxy", model: sol.model };
	store.values.set(modelIdentityKey(sol), "medium");
	const memory = new ThinkingMemory(store);
	const state = { identity: proxySol, level: "high" as ThinkingLevel };
	memory.start(sol, "medium");

	await memory.modelSelected(selection(proxySol, state));

	assert.equal(state.level, "high");
});
