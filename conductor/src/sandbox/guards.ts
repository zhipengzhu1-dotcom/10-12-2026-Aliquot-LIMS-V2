import type { AppendGuard } from "../append-guard.js";
import type { ArtifactId } from "../ids.js";
import type { Projections } from "../projections.js";
import { findScript } from "./scripts.js";

/** A Script's id is `S-` and its name. Its versions are the Script Projection's. */
const scriptIds: AppendGuard = (_, event) => {
	if (event.kind !== "ScriptRegistered" && event.kind !== "ScriptRevised") {
		return undefined;
	}
	const script = event.payload;
	return script.id === `S-${script.name}`
		? undefined
		: `Script "${script.name}" must have id S-${script.name}, got ${script.id}`;
};

const unknownArtifacts = (
	projections: Projections,
	ids: readonly ArtifactId[],
) => ids.filter((id) => !projections.artifacts.artifacts.has(id));

/**
 * An Artifact is named by its sha256, made from stored Artifacts, and
 * produced by a Run while it runs. Who may store the same bytes again is the
 * Artifact Projection's to say.
 */
const artifacts: AppendGuard = (projections, event) => {
	if (event.kind !== "ArtifactStored") return undefined;
	const artifact = event.payload;
	if (String(artifact.sha256) !== String(artifact.id)) {
		return `id ${artifact.id} must equal its sha256 ${artifact.sha256}`;
	}
	const unknown = unknownArtifacts(projections, artifact.lineage);
	if (unknown.length > 0) {
		return `Lineage of ${artifact.id} names unknown Artifacts ${unknown.join(", ")}`;
	}
	if (artifact.produced_by.tag === "Run") {
		const run = projections.runs.runs.get(artifact.produced_by.id);
		if (!run) return `${artifact.produced_by.id} has not started`;
		if (run.finished) return `${artifact.produced_by.id} has already finished`;
	}
	return undefined;
};

/**
 * A Run runs a registered Script version on stored Artifacts, and finishes
 * as it started. That it starts once and finishes once is the Run
 * Projection's to say.
 */
const runs: AppendGuard = (projections, event) => {
	if (event.kind === "RunStarted") {
		const { run_id, script, inputs } = event.payload;
		if (!findScript(projections.scripts, script)) {
			return `${script.id} v${script.version} is not registered`;
		}
		const unknown = unknownArtifacts(projections, inputs);
		return unknown.length > 0
			? `${run_id} names unknown input Artifacts ${unknown.join(", ")}`
			: undefined;
	}
	if (event.kind !== "RunFinished") return undefined;
	const run = event.payload;
	const started = projections.runs.runs.get(run.id)?.started;
	if (started === undefined) return undefined;
	if (
		started.script.id !== run.script.id ||
		started.script.version !== run.script.version ||
		started.inputs.join() !== run.inputs.join()
	) {
		return `${run.id} must name the Script version and inputs its RunStarted named`;
	}
	const unknown = unknownArtifacts(projections, [
		...run.outputs,
		run.stdout_ref,
		run.stderr_ref,
	]);
	return unknown.length > 0
		? `${run.id} names unknown Artifacts ${unknown.join(", ")}`
		: undefined;
};

export const sandboxGuards: readonly AppendGuard[] = [
	scriptIds,
	artifacts,
	runs,
];
