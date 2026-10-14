import { orRefuse } from "../append-guard.js";
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
import type { Origin, Recorded } from "../lifecycle-support.js";
import type { Actor, EventActor } from "../types/actor.js";
import type { ArtifactType, StoredArtifact } from "../types/artifact.js";
import type { Run, Script, ScriptRef } from "../types/script.js";
import { type ArtifactMeta, productionOf } from "./artifacts.js";
import { runningRun, startedRun } from "./runs.js";

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
		...fields
	}: { readonly actor: Actor } & Omit<
		Script,
		"id" | "version" | "fixtures" | "input_types" | "output_types"
	> & {
			readonly input_types: readonly ArtifactType[];
			readonly output_types: readonly ArtifactType[];
		},
	place?: (script: Script) => void,
): Recorded<"script", Script> => {
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
		causation_id: scripts.lastSeq.get(id),
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
 * the Run's RunStarted as its cause and the Run's Task; any other names the
 * `cause` its caller gives, such as the Message it holds.
 */
export const store = (
	ledger: Ledger,
	{ actor, cause }: { readonly actor: EventActor; readonly cause?: Seq },
	facts: ArtifactMeta & { readonly sha256: Sha256 },
): Recorded<"artifact", StoredArtifact> => {
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
		produced_by.tag === "Run"
			? orRefuse("ArtifactStored", runningRun(runs, produced_by.id))
			: undefined;
	const artifact: StoredArtifact = {
		id,
		...facts,
		lineage: [...facts.lineage],
	};
	const { seq } = ledger.append({
		actor,
		task_id: run?.task_id,
		causation_id: run?.seq ?? cause,
		kind: "ArtifactStored",
		payload: artifact,
	});
	return { artifact, seq };
};

/**
 * Start a Run of a registered Script version under the next free Run id, for
 * the Task and on the cause the caller names: the TaskStarted a Run works on
 * lies outside the Sandbox. It returns the RunStarted payload with its seq,
 * not a Run, which exists only once the Run finishes.
 */
export const startRun = (
	ledger: Ledger,
	{
		script,
		inputs,
		...origin
	}: Origin & {
		readonly task_id?: TaskId | undefined;
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
	{ actor, run }: { readonly actor: EventActor; readonly run: Run },
): Recorded<"run", Run> => {
	const started = orRefuse(
		"RunFinished",
		startedRun(ledger.projections.runs, run.id),
	);
	const { seq } = ledger.append({
		actor,
		task_id: started.task_id,
		causation_id: started.seq,
		kind: "RunFinished",
		payload: run,
	});
	return { run, seq };
};
