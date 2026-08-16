import type { ModelIdentity, ThinkingLevel } from "./preferences.ts";
import { sameModel } from "./preferences.ts";

export interface ThinkingPreferenceStore {
	get(identity: ModelIdentity): Promise<ThinkingLevel | undefined>;
	set(identity: ModelIdentity, thinkingLevel: ThinkingLevel): Promise<boolean>;
	drain(): Promise<void>;
}

export type ModelSelectSource = "set" | "cycle" | "restore";

export interface ModelSelection {
	identity: ModelIdentity;
	source: ModelSelectSource;
	pinnedThinkingLevel: ThinkingLevel | undefined;
	getCurrentIdentity(): ModelIdentity | undefined;
	getEffectiveLevel(): ThinkingLevel;
	applyThinkingLevel(level: ThinkingLevel): void;
}

interface ActiveModel {
	identity: ModelIdentity;
	effectiveLevel: ThinkingLevel;
	generation: number;
	revision: number;
}

export class ThinkingMemory {
	private readonly store: ThinkingPreferenceStore;
	private active: ActiveModel | undefined;
	private nextGeneration = 0;

	constructor(store: ThinkingPreferenceStore) {
		this.store = store;
	}

	start(identity: ModelIdentity | undefined, effectiveLevel: ThinkingLevel): void {
		this.active = identity
			? {
					identity,
					effectiveLevel,
					generation: ++this.nextGeneration,
					revision: 0,
				}
			: undefined;
	}

	async thinkingLevelSelected(
		identity: ModelIdentity | undefined,
		level: ThinkingLevel,
		currentEffectiveLevel: ThinkingLevel,
	): Promise<void> {
		const active = this.active;
		if (!active || !identity || !sameModel(active.identity, identity)) return;

		// Pi emits thinking events without awaiting extension handlers. Ignore an event
		// that has already been superseded by a newer effective level.
		if (level !== currentEffectiveLevel) return;

		// Model switching and our own restoration may emit a delayed event for the
		// level already represented by the active state.
		if (level === active.effectiveLevel) return;

		active.effectiveLevel = level;
		active.revision += 1;
		await this.store.set(active.identity, level);
	}

	async modelSelected(selection: ModelSelection): Promise<void> {
		const generation = ++this.nextGeneration;
		const inheritedLevel = selection.getEffectiveLevel();
		const active: ActiveModel = {
			identity: selection.identity,
			effectiveLevel: inheritedLevel,
			generation,
			revision: 0,
		};
		this.active = active;

		if (selection.source === "restore") return;

		if (selection.pinnedThinkingLevel !== undefined) {
			// Scoped cycling applies its pin inside Pi before model_select. Direct
			// selection uses setModel(), so apply the scoped pin here as well.
			if (selection.source === "set") {
				selection.applyThinkingLevel(selection.pinnedThinkingLevel);
				if (this.isCurrentGeneration(selection, generation)) {
					active.effectiveLevel = selection.getEffectiveLevel();
				}
			}
			return;
		}

		const savedLevel = await this.store.get(selection.identity);
		if (savedLevel === undefined) return;

		if (!this.canRestore(selection, generation, 0, inheritedLevel)) return;

		selection.applyThinkingLevel(savedLevel);
		const effectiveLevel = selection.getEffectiveLevel();
		if (!this.isCurrentGeneration(selection, generation)) return;

		active.effectiveLevel = effectiveLevel;
		if (effectiveLevel !== savedLevel) {
			await this.store.set(selection.identity, effectiveLevel);
		}
	}

	async shutdown(): Promise<void> {
		this.active = undefined;
		this.nextGeneration += 1;
		await this.store.drain();
	}

	private canRestore(
		selection: ModelSelection,
		generation: number,
		revision: number,
		inheritedLevel: ThinkingLevel,
	): boolean {
		const active = this.active;
		return (
			active?.generation === generation &&
			active.revision === revision &&
			sameModel(active.identity, selection.identity) &&
			sameModel(selection.getCurrentIdentity(), selection.identity) &&
			selection.getEffectiveLevel() === inheritedLevel
		);
	}

	private isCurrentGeneration(selection: ModelSelection, generation: number): boolean {
		return (
			this.active?.generation === generation &&
			sameModel(this.active.identity, selection.identity) &&
			sameModel(selection.getCurrentIdentity(), selection.identity)
		);
	}
}
