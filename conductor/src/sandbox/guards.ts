import { type AppendGuard, AppendRefused } from "../append-guard.js";
import { fold } from "../reduce.js";
import { artifactProjection } from "./artifacts.js";
import { runProjection } from "./runs.js";
import { findScript, scriptProjection } from "./scripts.js";

const refuse = (message: string): never => {
	throw new AppendRefused(message);
};

const scriptVersions: AppendGuard = (ctx, event) => {
	if (event.kind !== "ScriptRegistered" && event.kind !== "ScriptRevised") {
		return;
	}
	const script = event.payload;
	if (script.id !== `S-${script.name}`) {
		refuse(
			`${event.kind}: Script "${script.name}" must have id S-${script.name}, got ${script.id}`,
		);
	}
	const { scripts } = fold(
		ctx.events,
		scriptProjection.reduce,
		scriptProjection.init,
	);
	const latest = scripts.get(script.id)?.at(-1)?.version;
	if (event.kind === "ScriptRegistered") {
		if (latest !== undefined) {
			refuse(
				`ScriptRegistered: ${script.id} is already registered (latest version ${latest}); use ScriptRevised`,
			);
		}
		if (script.version !== 1) {
			refuse(
				`ScriptRegistered: ${script.id} must start at version 1, got ${script.version}`,
			);
		}
		return;
	}
	if (latest === undefined) {
		refuse(`ScriptRevised: ${script.id} is not registered`);
	} else if (script.version !== latest + 1) {
		refuse(
			`ScriptRevised: ${script.id} is at version ${latest}, so the revision must be version ${latest + 1}, got ${script.version}`,
		);
	}
};

const artifacts: AppendGuard = (ctx, event) => {
	if (event.kind !== "ArtifactStored") return;
	const artifact = event.payload;
	if (String(artifact.sha256) !== String(artifact.id)) {
		refuse(
			`ArtifactStored: id ${artifact.id} must equal its sha256 ${artifact.sha256}`,
		);
	}
	const known = fold(
		ctx.events,
		artifactProjection.reduce,
		artifactProjection.init,
	).artifacts;
	if (known.has(artifact.id)) {
		refuse(`ArtifactStored: ${artifact.id} is already stored`);
	}
	const unknown = artifact.lineage.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		refuse(
			`ArtifactStored: Lineage of ${artifact.id} names unknown Artifacts ${unknown.join(", ")}`,
		);
	}
	if (artifact.produced_by.tag === "Run") {
		const { runs } = fold(ctx.events, runProjection.reduce, runProjection.init);
		const run = runs.get(artifact.produced_by.id);
		if (!run)
			refuse(`ArtifactStored: ${artifact.produced_by.id} has not started`);
		if (run?.finished)
			refuse(`ArtifactStored: ${artifact.produced_by.id} has already finished`);
	}
};

const runs: AppendGuard = (ctx, event) => {
	if (event.kind !== "RunStarted" && event.kind !== "RunFinished") return;
	const { runs } = fold(ctx.events, runProjection.reduce, runProjection.init);
	const known = fold(
		ctx.events,
		artifactProjection.reduce,
		artifactProjection.init,
	).artifacts;
	const missing = (ids: readonly string[]) =>
		ids.filter((id) => !known.has(id as never));

	if (event.kind === "RunStarted") {
		const { run_id, script, inputs } = event.payload;
		if (runs.has(run_id)) refuse(`RunStarted: ${run_id} has already started`);
		const scripts = fold(
			ctx.events,
			scriptProjection.reduce,
			scriptProjection.init,
		);
		if (!findScript(scripts, script)) {
			refuse(`RunStarted: ${script.id} v${script.version} is not registered`);
		}
		const unknown = missing(inputs);
		if (unknown.length > 0)
			refuse(
				`RunStarted: ${run_id} names unknown input Artifacts ${unknown.join(", ")}`,
			);
		return;
	}

	const run = event.payload;
	const record = runs.get(run.id);
	if (!record) return refuse(`RunFinished: ${run.id} has no RunStarted`);
	if (record.finished) refuse(`RunFinished: ${run.id} has already finished`);
	const { started } = record;
	if (
		started.script.id !== run.script.id ||
		started.script.version !== run.script.version ||
		started.inputs.join() !== run.inputs.join()
	) {
		refuse(
			`RunFinished: ${run.id} must name the Script version and inputs its RunStarted named`,
		);
	}
	const unknown = missing([...run.outputs, run.stdout_ref, run.stderr_ref]);
	if (unknown.length > 0)
		refuse(
			`RunFinished: ${run.id} names unknown Artifacts ${unknown.join(", ")}`,
		);
};

export const sandboxGuards: readonly AppendGuard[] = [
	scriptVersions,
	artifacts,
	runs,
];
