import type { ArtifactId, ScriptId, Seq, TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { openArtifacts, productionOf } from "../sandbox/artifacts.js";
import { runScript } from "../sandbox/runner.js";
import type { EventActor } from "../types/actor.js";
import type { Run } from "../types/script.js";
import { recordEvaluation, type Scored } from "../workflow/lifecycle.js";
import type { RunArtifacts, Stage } from "../workflow/stages.js";
import { type ToolContext, ToolRefused } from "./tool.js";

export const stageOfScript = (
	stages: readonly Stage[],
	script: ScriptId,
): Stage | undefined => stages.find((s) => `S-${s.script}` === script);

// The scoring below copies the workflow tracer's private `artifactsOf` and
// `evaluateRun`; issue #51 keeps one copy.

/** The Run's input Artifacts and every Artifact it wrote, typed as this Run recorded them. */
export const runArtifacts = (
	ledger: Ledger,
	home: string,
	run: Run,
): RunArtifacts => {
	const artifacts = openArtifacts({ ledger, home });
	const { projections } = ledger;
	const inputs = run.inputs.flatMap((id) => {
		const stored = projections.artifacts.artifacts.get(id);
		if (!stored) return [];
		const { artifact_type, filename } = stored;
		return [{ id, artifact_type, filename, bytes: artifacts.read(id) }];
	});
	const outputs = run.outputs.flatMap((id) => {
		const production = productionOf(projections.artifacts, id, {
			tag: "Run",
			id: run.id,
		});
		if (!production) return [];
		const { artifact_type, filename } = production.record;
		return [{ id, artifact_type, filename, bytes: artifacts.read(id) }];
	});
	return { inputs, outputs };
};

/** A failed Run, or one that wrote none of an output type, scores 0; else the stage scores it. */
const scoreRun = (stage: Stage, run: Run, artifacts: RunArtifacts): Scored => {
	const failed = (finding: string): Scored => ({
		score: 0,
		passed: false,
		findings: [finding],
	});
	if (run.exit_code !== 0) {
		return failed(
			`${run.id} exited ${run.exit_code}; its stderr is Artifact ${run.stderr_ref}`,
		);
	}
	const missing = stage.outputs.filter(
		(type) => !artifacts.outputs.some((o) => o.artifact_type === type),
	);
	if (missing.length > 0) {
		return failed(`${run.id} wrote no ${missing.join(", ")}`);
	}
	return stage.evaluate(artifacts);
};

type RunInput = {
	readonly script: ScriptId;
	readonly version?: number | undefined;
	readonly inputs: readonly ArtifactId[];
	readonly task_id?: TaskId | undefined;
};

/**
 * Run a Script version as the Agent, as `runScriptBy` does. This is the
 * `run_script` Tool's path.
 */
export const runScriptAs = (ctx: ToolContext, input: RunInput) =>
	runScriptBy({ ...ctx, actor: { tag: "Agent", id: ctx.agent } }, input);

/**
 * Run a Script version, the latest when none is named, in the Sandbox as
 * `actor`, on a Task when one is named, whose previous Event is the Run's
 * cause; without a Task, the Run names `causation_id`. A stage Script's Run
 * then records the stage's Evaluation, as the workflow tracer does, so it
 * needs the Task the Evaluation scores.
 */
export const runScriptBy = async (
	ctx: Omit<ToolContext, "agent"> & {
		readonly actor: EventActor;
		readonly causation_id?: Seq | undefined;
	},
	input: RunInput,
) => {
	const { ledger, home, actor, stages, timeoutMs } = ctx;
	const { script, task_id } = input;
	const versions = ledger.projections.scripts.scripts.get(script) ?? [];
	const version = input.version ?? versions.at(-1)?.version;
	if (version === undefined || !versions.some((s) => s.version === version)) {
		throw new ToolRefused(
			`${script}${input.version === undefined ? "" : ` v${input.version}`} is not registered`,
		);
	}
	const stage = stageOfScript(stages, script);
	if (stage !== undefined && task_id === undefined) {
		throw new ToolRefused(
			`${script} is the Script of stage ${stage.number} ${stage.name}, so its Run names the Task its Evaluation scores`,
		);
	}
	const run = await runScript({
		ledger,
		home,
		script: { id: script, version },
		inputs: input.inputs,
		actor,
		task_id,
		causation_id:
			task_id === undefined
				? ctx.causation_id
				: ledger.projections.tasks.lastSeq.get(task_id),
		timeoutMs,
	});
	if (stage === undefined || task_id === undefined) return { run };
	const scored = scoreRun(stage, run, runArtifacts(ledger, home, run));
	const { evaluation, seq } = recordEvaluation(ledger, {
		actor,
		stage: stage.number,
		task_id,
		run_id: run.id,
		...scored,
	});
	return { run, evaluation, seq };
};
