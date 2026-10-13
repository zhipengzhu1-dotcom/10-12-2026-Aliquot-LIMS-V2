import { AppendRefused, refusalText } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import {
	ArtifactId,
	nextId,
	RunId,
	ScriptId,
	type Seq,
	type Sha256,
	type TaskId,
} from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import type { ArtifactType, StoredArtifact } from "../types/artifact.js";
import type { Run, Script, ScriptRef } from "../types/script.js";
import { type ArtifactMeta, productionOf } from "./artifacts.js";

/**
 * Who appends a Sandbox Event, and the cause it names when that cause lies
 * outside the Sandbox, such as the TaskStarted a Run works on.
 */
export type Origin = {
	readonly actor: Actor;
	readonly task_id?: TaskId | undefined;
	readonly causation_id?: Seq | undefined;
};

/**
 * Record a Script version: ScriptRegistered at version 1 for a new name, else
 * ScriptRevised at the next version, naming the version before as its cause.
 * `place` puts the version's code where the runner mounts it, before the
 * Ledger says the version exists.
 */
export const register = (
	ledger: Ledger,
	{
		actor,
		causation_id,
		...fields
	}: Omit<Origin, "task_id"> &
		Omit<
			Script,
			"id" | "version" | "fixtures" | "input_types" | "output_types"
		> & {
			readonly input_types: readonly ArtifactType[];
			readonly output_types: readonly ArtifactType[];
		},
	place?: (script: Script) => void,
): { readonly script: Script; readonly seq: Seq } => {
	const { scripts } = ledger.projections;
	const id = ScriptId.parse(`S-${fields.name}`);
	const latest = scripts.scripts.get(id)?.at(-1);
	const script: Script = {
		id,
		version: (latest?.version ?? 0) + 1,
		...fields,
		input_types: [...fields.input_types],
		output_types: [...fields.output_types],
		fixtures: [],
	};
	place?.(script);
	const { seq } = ledger.append({
		actor,
		causation_id: causation_id ?? scripts.lastSeq.get(id),
		kind: latest ? "ScriptRevised" : "ScriptRegistered",
		payload: script,
	});
	return { script, seq };
};

/**
 * Store an Artifact. Bytes the Ledger already holds get a new ArtifactStored
 * only when a Run produces them that has not stored them yet; otherwise
 * nothing is appended, and the ArtifactStored that already records them comes
 * back: the producer's own, else the first. An Artifact a Run produces names
 * the Run's RunStarted as its cause and the Run's Task.
 */
export const store = (
	ledger: Ledger,
	origin: Origin,
	facts: ArtifactMeta & { readonly sha256: Sha256 },
): { readonly artifact: StoredArtifact; readonly seq: Seq } => {
	const { artifacts, runs } = ledger.projections;
	const id = ArtifactId.parse(facts.sha256);
	const { produced_by } = facts;
	const existing =
		productionOf(artifacts, id, produced_by) ??
		(produced_by.tag === "Operator"
			? artifacts.productions.get(id)?.[0]
			: undefined);
	if (existing !== undefined) {
		return { artifact: existing.record, seq: existing.seq };
	}
	const run =
		produced_by.tag === "Run" ? runs.runs.get(produced_by.id) : undefined;
	if (produced_by.tag === "Run" && run === undefined) {
		throw new AppendRefused(
			refusalText("ArtifactStored", `${produced_by.id} has not started`),
		);
	}
	const artifact: StoredArtifact = {
		id,
		...facts,
		lineage: [...facts.lineage],
	};
	const { seq } = ledger.append({
		actor: origin.actor,
		task_id: origin.task_id ?? run?.task_id,
		causation_id: origin.causation_id ?? run?.seq,
		kind: "ArtifactStored",
		payload: artifact,
	});
	return { artifact, seq };
};

/** Start a Run of a registered Script version under the next free Run id. */
export const startRun = (
	ledger: Ledger,
	{
		script,
		inputs,
		...origin
	}: Origin & {
		readonly script: ScriptRef;
		readonly inputs: readonly ArtifactId[];
	},
): PayloadOf<"RunStarted"> & { readonly seq: Seq } => {
	const payload = {
		run_id: RunId.parse(nextId("R", ledger.projections.runs.runs.keys())),
		script: { id: script.id, version: script.version },
		inputs: [...inputs],
	};
	const { seq } = ledger.append({
		...origin,
		kind: "RunStarted",
		payload,
	});
	return { ...payload, seq };
};

/** Finish a started Run, naming its RunStarted as the cause and its Task. */
export const finishRun = (
	ledger: Ledger,
	{ actor, causation_id, run }: Omit<Origin, "task_id"> & { readonly run: Run },
): { readonly run: Run; readonly seq: Seq } => {
	const started = ledger.projections.runs.runs.get(run.id);
	if (started === undefined) {
		throw new AppendRefused(
			refusalText("RunFinished", `${run.id} has no RunStarted`),
		);
	}
	const { seq } = ledger.append({
		actor,
		task_id: started.task_id,
		causation_id: causation_id ?? started.seq,
		kind: "RunFinished",
		payload: run,
	});
	return { run, seq };
};
