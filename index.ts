import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ThinkingMemory } from "./memory.ts";
import { PreferenceStore, type ModelIdentity } from "./preferences.ts";

interface ModelLike {
	provider: string;
	id: string;
}

function modelIdentity(model: ModelLike | undefined): ModelIdentity | undefined {
	return model ? { provider: model.provider, model: model.id } : undefined;
}

export default function piThinkingMemory(pi: ExtensionAPI) {
	const store = new PreferenceStore(join(getAgentDir(), "pi-thinking-memory.json"));
	const memory = new ThinkingMemory(store);

	pi.on("session_start", (_event, ctx) => {
		memory.start(modelIdentity(ctx.model), pi.getThinkingLevel());
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await memory.thinkingLevelSelected(modelIdentity(ctx.model), event.level, pi.getThinkingLevel());
	});

	pi.on("model_select", async (event, ctx) => {
		const identity = modelIdentity(event.model)!;
		const pinnedThinkingLevel = ctx.scopedModels.find(
			(entry) => entry.model.provider === identity.provider && entry.model.id === identity.model,
		)?.thinkingLevel;

		await memory.modelSelected({
			identity,
			source: event.source,
			pinnedThinkingLevel,
			getCurrentIdentity: () => modelIdentity(ctx.model),
			getEffectiveLevel: () => pi.getThinkingLevel(),
			applyThinkingLevel: (level) => pi.setThinkingLevel(level),
		});
	});

	pi.on("session_shutdown", async () => {
		await memory.shutdown();
	});
}
