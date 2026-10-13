import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, ScriptId, Seq, Sha256 } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { type Projection, Refusal } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { ArtifactType } from "../types/artifact.js";
import type { Script, ScriptRef } from "../types/script.js";
import { register } from "./lifecycle.js";

/** Every registered Script, each with its versions in order. */
export type ScriptProjection = {
	readonly scripts: ReadonlyMap<ScriptId, readonly Script[]>;
	/** The seq of each Script's latest version. */
	readonly lastSeq: ReadonlyMap<ScriptId, Seq>;
};

/**
 * A Script is registered once, at version 1, and each revision is the next
 * version.
 */
export const scriptProjection: Projection<ScriptProjection> = {
	init: { scripts: new Map(), lastSeq: new Map() },
	reduce: (state, event) => {
		if (event.kind !== "ScriptRegistered" && event.kind !== "ScriptRevised") {
			return state;
		}
		const script = event.payload;
		const versions = state.scripts.get(script.id) ?? [];
		const latest = versions.at(-1)?.version;
		if (event.kind === "ScriptRegistered") {
			if (latest !== undefined) {
				return new Refusal(
					`${script.id} is already registered (latest version ${latest}); use ScriptRevised`,
				);
			}
			if (script.version !== 1) {
				return new Refusal(
					`${script.id} must start at version 1, got ${script.version}`,
				);
			}
		} else if (latest === undefined) {
			return new Refusal(`${script.id} is not registered`);
		} else if (script.version !== latest + 1) {
			return new Refusal(
				`${script.id} is at version ${latest}, so the revision must be version ${latest + 1}, got ${script.version}`,
			);
		}
		return {
			scripts: new Map(state.scripts).set(script.id, [...versions, script]),
			lastSeq: new Map(state.lastSeq).set(script.id, event.seq),
		};
	},
};

export const findScript = (
	state: ScriptProjection,
	ref: ScriptRef,
): Script | undefined =>
	state.scripts.get(ref.id)?.find((s) => s.version === ref.version);

/**
 * Where a registered Script version's code lives: a copy taken at
 * registration, so editing `sandbox/scripts/<name>` later never changes what
 * an existing version runs. The runner mounts it read-only at `/script`.
 */
export const scriptDir = (home: string, ref: ScriptRef): string =>
	join(home, "scripts", ref.id, String(ref.version));

export type RegisterScript = {
	ledger: Ledger;
	home: string;
	actor: Actor;
	name: string;
	/** The directory holding the Script's code, such as `sandbox/scripts/copy`. */
	scriptDir: string;
	owner_agent: AgentId;
	input_types: readonly ArtifactType[];
	output_types: readonly ArtifactType[];
	entrypoint?: string;
	image_digest: Sha256;
};

/**
 * Record a Script version: ScriptRegistered (version 1) for a new name, else
 * ScriptRevised with the next version. The code is copied under `home` first.
 */
export const registerScript = ({
	ledger,
	home,
	scriptDir: source,
	entrypoint = "main.py",
	...fields
}: RegisterScript): Script => {
	if (!statSync(source).isDirectory()) {
		throw new Error(`${source} is not a directory`);
	}
	if (!existsSync(join(source, entrypoint))) {
		throw new Error(`${source} has no entrypoint ${entrypoint}`);
	}
	return register(ledger, { ...fields, entrypoint }, (script) => {
		const target = scriptDir(home, script);
		mkdirSync(join(target, ".."), { recursive: true });
		cpSync(source, target, {
			recursive: true,
			force: true,
			filter: (path) => !path.includes("__pycache__"),
		});
	}).script;
};
