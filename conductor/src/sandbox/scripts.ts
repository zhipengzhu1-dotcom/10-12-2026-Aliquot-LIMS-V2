import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AgentId, ScriptId, type Sha256 } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { type Projection, Refusal } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { ArtifactType } from "../types/artifact.js";
import type { Script, ScriptRef } from "../types/script.js";

/** Every registered Script, each with its versions in order. */
export type ScriptProjection = {
	readonly scripts: ReadonlyMap<ScriptId, readonly Script[]>;
};

/**
 * A Script is registered once, at version 1, and each revision is the next
 * version.
 */
export const scriptProjection: Projection<ScriptProjection> = {
	init: { scripts: new Map() },
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
export const registerScript = (options: RegisterScript): Script => {
	const { ledger, home, name } = options;
	const entrypoint = options.entrypoint ?? "main.py";
	if (!statSync(options.scriptDir).isDirectory()) {
		throw new Error(`${options.scriptDir} is not a directory`);
	}
	if (!existsSync(join(options.scriptDir, entrypoint))) {
		throw new Error(`${options.scriptDir} has no entrypoint ${entrypoint}`);
	}
	const id = ScriptId.parse(`S-${name}`);
	const latest = ledger.projections.scripts.scripts.get(id)?.at(-1);
	const script: Script = {
		id,
		version: (latest?.version ?? 0) + 1,
		name,
		owner_agent: options.owner_agent,
		input_types: [...options.input_types],
		output_types: [...options.output_types],
		entrypoint,
		fixtures: [],
		image_digest: options.image_digest,
	};
	const target = scriptDir(home, script);
	mkdirSync(join(target, ".."), { recursive: true });
	cpSync(options.scriptDir, target, {
		recursive: true,
		force: true,
		filter: (source) => !source.includes("__pycache__"),
	});
	const event = ledger.append({
		actor: options.actor,
		kind: latest ? "ScriptRevised" : "ScriptRegistered",
		payload: script,
	});
	if (event.kind !== "ScriptRegistered" && event.kind !== "ScriptRevised") {
		throw new Error("unreachable");
	}
	return event.payload;
};
