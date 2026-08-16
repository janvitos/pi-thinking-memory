import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelIdentity {
	provider: string;
	model: string;
}

export interface PreferenceRecord extends ModelIdentity {
	thinkingLevel: ThinkingLevel;
}

interface PreferencesFile {
	version: 1;
	preferences: PreferenceRecord[];
}

export type DecodeResult =
	| { kind: "current"; preferences: PreferenceRecord[]; issues: string[] }
	| { kind: "future"; version: number }
	| { kind: "invalid"; issues: string[] };

export type PreferenceLogger = (message: string, error?: unknown) => void;

const FILE_VERSION = 1;
const LOCK_OPTIONS = {
	realpath: false,
	stale: 10_000,
	update: 2_000,
	retries: {
		// Wait beyond the stale-lock window so brief long-running updates do not
		// silently lose a preference under normal contention.
		retries: 60,
		factor: 1.2,
		minTimeout: 25,
		maxTimeout: 250,
	},
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function modelIdentityKey(identity: ModelIdentity): string {
	return JSON.stringify([identity.provider, identity.model]);
}

export function sameModel(left: ModelIdentity | undefined, right: ModelIdentity | undefined): boolean {
	return left?.provider === right?.provider && left?.model === right?.model;
}

export function decodePreferences(value: unknown): DecodeResult {
	if (!isRecord(value)) {
		return { kind: "invalid", issues: ["root must be an object"] };
	}

	const version = value.version;
	if (typeof version === "number" && Number.isInteger(version) && version > FILE_VERSION) {
		return { kind: "future", version };
	}
	if (version !== FILE_VERSION) {
		return { kind: "invalid", issues: [`version must be ${FILE_VERSION}`] };
	}
	if (!Array.isArray(value.preferences)) {
		return { kind: "invalid", issues: ["preferences must be an array"] };
	}

	const issues: string[] = [];
	const byModel = new Map<string, PreferenceRecord>();
	for (const [index, candidate] of value.preferences.entries()) {
		if (!isRecord(candidate)) {
			issues.push(`preferences[${index}] must be an object`);
			continue;
		}

		const provider = candidate.provider;
		const model = candidate.model;
		const thinkingLevel = candidate.thinkingLevel;
		if (typeof provider !== "string" || provider.trim().length === 0) {
			issues.push(`preferences[${index}].provider must be a non-empty string`);
			continue;
		}
		if (typeof model !== "string" || model.trim().length === 0) {
			issues.push(`preferences[${index}].model must be a non-empty string`);
			continue;
		}
		if (!isThinkingLevel(thinkingLevel)) {
			issues.push(`preferences[${index}].thinkingLevel is unsupported`);
			continue;
		}

		const preference = { provider, model, thinkingLevel };
		const key = modelIdentityKey(preference);
		if (byModel.has(key)) {
			issues.push(`preferences[${index}] duplicates ${provider}/${model}; the last value wins`);
		}
		byModel.set(key, preference);
	}

	return { kind: "current", preferences: [...byModel.values()], issues };
}

export function encodePreferences(preferences: Iterable<PreferenceRecord>): string {
	const sorted = [...preferences].sort(
		(left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
	);
	const value: PreferencesFile = { version: FILE_VERSION, preferences: sorted };
	return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultLogger(message: string, error?: unknown): void {
	const suffix = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
	console.error(`[pi-thinking-memory] ${message}${suffix}`);
}

export class PreferenceStore {
	readonly filePath: string;
	private readonly logger: PreferenceLogger;
	private queue: Promise<void> = Promise.resolve();

	constructor(filePath: string, logger: PreferenceLogger = defaultLogger) {
		this.filePath = filePath;
		this.logger = logger;
	}

	get(identity: ModelIdentity): Promise<ThinkingLevel | undefined> {
		return this.enqueue(async () => {
			try {
				return await this.withLock(async (assertLockHealthy) => {
					const decoded = await this.readDecoded();
					assertLockHealthy();
					if (decoded.kind !== "current") return undefined;
					return decoded.preferences.find((entry) => sameModel(entry, identity))?.thinkingLevel;
				});
			} catch (error) {
				this.logger(`Could not read ${this.filePath}`, error);
				return undefined;
			}
		});
	}

	set(identity: ModelIdentity, thinkingLevel: ThinkingLevel): Promise<boolean> {
		return this.enqueue(async () => {
			try {
				return await this.withLock(async (assertLockHealthy) => {
					const decoded = await this.readDecoded();
					assertLockHealthy();
					if (decoded.kind === "future") {
						this.logger(
							`Refusing to overwrite ${this.filePath}: schema version ${decoded.version} is newer than ${FILE_VERSION}`,
						);
						return false;
					}

					const preferences = new Map<string, PreferenceRecord>();
					if (decoded.kind === "current") {
						for (const preference of decoded.preferences) {
							preferences.set(modelIdentityKey(preference), preference);
						}
					}
					preferences.set(modelIdentityKey(identity), { ...identity, thinkingLevel });
					await this.writeAtomic(encodePreferences(preferences.values()), assertLockHealthy);
					return true;
				});
			} catch (error) {
				this.logger(`Could not update ${this.filePath}`, error);
				return false;
			}
		});
	}

	async drain(): Promise<void> {
		await this.queue;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async withLock<T>(operation: (assertLockHealthy: () => void) => Promise<T>): Promise<T> {
		await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
		let compromisedError: Error | undefined;
		const assertLockHealthy = () => {
			if (compromisedError) throw compromisedError;
		};
		const release = await lockfile.lock(this.filePath, {
			...LOCK_OPTIONS,
			onCompromised: (error) => {
				compromisedError = error;
				this.logger(`Lock for ${this.filePath} was compromised`, error);
			},
		});
		try {
			const result = await operation(assertLockHealthy);
			assertLockHealthy();
			return result;
		} finally {
			try {
				await release();
			} catch (error) {
				if (compromisedError) {
					this.logger(`Could not release compromised lock for ${this.filePath}`, error);
				} else {
					throw error;
				}
			}
		}
	}

	private async readDecoded(): Promise<DecodeResult> {
		let source: string;
		try {
			source = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { kind: "current", preferences: [], issues: [] };
			}
			throw error;
		}

		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch (error) {
			this.logger(`Ignoring malformed JSON in ${this.filePath}`, error);
			return { kind: "invalid", issues: ["file is not valid JSON"] };
		}

		const decoded = decodePreferences(value);
		if (decoded.kind === "invalid") {
			this.logger(`Ignoring invalid preferences in ${this.filePath}: ${decoded.issues.join("; ")}`);
		} else if (decoded.kind === "current" && decoded.issues.length > 0) {
			this.logger(`Loaded ${this.filePath} with corrections: ${decoded.issues.join("; ")}`);
		}
		return decoded;
	}

	private async writeAtomic(content: string, assertLockHealthy: () => void): Promise<void> {
		const directory = dirname(this.filePath);
		const temporaryPath = join(directory, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			assertLockHealthy();
			await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
			assertLockHealthy();
			await rename(temporaryPath, this.filePath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}
}
