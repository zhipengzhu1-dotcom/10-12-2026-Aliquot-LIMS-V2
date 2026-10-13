import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { sha256Hex } from "../hash.js";
import {
	type ArtifactId,
	type EvaluationId,
	ScriptId,
	type Seq,
	type Sha256,
	type TaskId,
} from "../ids.js";
import type { Ledger } from "../ledger.js";
import { revisedBetween } from "../org/projection.js";
import { seedOrg } from "../org/seed.js";
import type { Projections } from "../projections.js";
import {
	openArtifacts,
	type Production,
	productionOf,
} from "../sandbox/artifacts.js";
import { guessMediaType, runScript } from "../sandbox/runner.js";
import { registerScript, scriptDir } from "../sandbox/scripts.js";
import {
	assign,
	complete,
	fail,
	propose,
	review,
	start,
	taskOf,
} from "../task/lifecycle.js";
import { LIVE_TAGS } from "../task/projection.js";
import type { Actor } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import type { ArtifactType } from "../types/artifact.js";
import type { Run, Script, ScriptRef } from "../types/script.js";
import type { TaskState } from "../types/task.js";
import { recordEvaluation, type Scored } from "./lifecycle.js";
import type { RunArtifacts, Stage, StageArtifact } from "./stages.js";

const OPERATOR: Actor = { tag: "Operator" };

/** sha256 over every file's relative path and bytes, `__pycache__` skipped. */
const treeDigest = (dir: string): string => {
	const hash = createHash("sha256");
	const files = readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && !e.parentPath.includes("__pycache__"))
		.map((e) => join(e.parentPath, e.name))
		.sort();
	for (const file of files) {
		hash.update(`${relative(dir, file).split(sep).join("/")}\0`);
		hash.update(sha256Hex(readFileSync(file)));
	}
	return hash.digest("hex");
};

/**
 * The version of a stage's Script to run: the latest one when it was
 * registered on `image` from the same code as `source`, else a new version
 * (ScriptRegistered for the first, ScriptRevised after), owned by the Agent
 * that works the stage.
 */
export const ensureScript = (options: {
	ledger: Ledger;
	home: string;
	stage: Stage;
	source: string;
	image: Sha256;
}): Script => {
	const { ledger, home, stage, source, image } = options;
	const latest = ledger.projections.scripts.scripts
		.get(ScriptId.parse(`S-${stage.script}`))
		?.at(-1);
	if (
		latest &&
		latest.image_digest === image &&
		treeDigest(scriptDir(home, latest)) === treeDigest(source)
	) {
		return latest;
	}
	return registerScript({
		ledger,
		home,
		actor: OPERATOR,
		name: stage.script,
		scriptDir: source,
		owner_agent: stage.worked_by,
		input_types: [...stage.inputs, ...stage.carried],
		output_types: [...stage.outputs],
		image_digest: image,
	});
};

/** A stage and the version of its Script to run. */
export type StagePlan = { readonly stage: Stage; readonly script: ScriptRef };

export type StageRun = {
	readonly stage: Stage;
	readonly task_id: TaskId;
	readonly run: Run;
	/** Every Artifact the Run wrote; the next stage takes those of its input types. */
	readonly outputs: readonly StageArtifact[];
	readonly eval_id: EvaluationId;
	readonly evaluation: Scored;
	/** Trust tier Revisions the stage's Review brought about. */
	readonly revisions: readonly AgentDefinition[];
	readonly state: TaskState;
};

export type WorkflowRun = {
	readonly fixture: ArtifactId;
	/** One per stage run, in order; the last is the first that did not end Done. */
	readonly stages: readonly StageRun[];
};

type Typed = { readonly id: ArtifactId; readonly artifact_type: ArtifactType };

/**
 * The input type a stage takes the weighings as. A stage's own `Other`
 * outputs are read-backs for its Evaluation, never a later stage's input.
 */
const WEIGHINGS: ArtifactType = "Other";

/**
 * Store the synthetic weighings the Operator keeps beside a Fixture,
 * `<fixture stem>.weighings.json`, as the Operator's `Other` with no
 * Lineage, or refuse the stage that takes them, naming the file.
 */
const storeWeighings = (
	ledger: Ledger,
	home: string,
	stage: Stage,
	formPath: string,
): Typed => {
	const stem = basename(formPath, extname(formPath));
	const path = join(dirname(formPath), `${stem}.weighings.json`);
	if (!existsSync(path)) {
		throw new Error(
			`stage ${stage.number} ${stage.name} refused: it takes the weighings beside the Fixture as input, and ${path} does not exist`,
		);
	}
	return openArtifacts({ ledger, home }).store(
		readFileSync(path),
		{
			artifact_type: WEIGHINGS,
			media_type: "application/json",
			produced_by: OPERATOR,
			lineage: [],
			filename: basename(path),
		},
		{ actor: OPERATOR },
	).artifact;
};

/** The Fixture, or one Done stage's outputs. */
type Given = { readonly from: string; readonly artifacts: readonly Typed[] };

/**
 * The Artifacts of the stage's input types, each type from the latest of
 * the Fixture and the earlier stages' outputs that holds one, and the
 * weighings; or a refusal naming the stage and the types none of them gave.
 */
const inputsFor = (
	stage: Stage,
	earlier: readonly Given[],
	weighings: Typed | undefined,
): ArtifactId[] => {
	const given = (type: ArtifactType): readonly Typed[] => {
		if (type === WEIGHINGS) return weighings ? [weighings] : [];
		const holds = (a: Typed) => a.artifact_type === type;
		const latest = earlier.filter((g) => g.artifacts.some(holds)).at(-1);
		return latest?.artifacts.filter(holds) ?? [];
	};
	const missing = stage.inputs.filter((type) => given(type).length === 0);
	if (missing.length > 0) {
		throw new Error(
			`stage ${stage.number} ${stage.name} refused: it takes ${missing.join(", ")} as input, and ${earlier.map((g) => g.from).join(", ")} gave none`,
		);
	}
	return stage.inputs.flatMap((type) => given(type).map((a) => a.id));
};

/**
 * The Artifact of `type` most recently written by a Run whose Task is Done,
 * if there is one. A version a failed Task's Run wrote, which no Evaluation
 * accepted, never becomes the one a later stage carries.
 */
const latestAccepted = (
	projections: Projections,
	type: ArtifactType,
): ArtifactId | undefined => {
	const done = ({ record }: Production) => {
		if (record.produced_by.tag !== "Run") return false;
		const task_id = projections.runs.runs.get(record.produced_by.id)?.task_id;
		return (
			task_id !== undefined &&
			projections.tasks.tasks.get(task_id)?.state.tag === "Done"
		);
	};
	let latest: Production | undefined;
	for (const productions of projections.artifacts.productions.values()) {
		for (const p of productions) {
			if (
				p.record.artifact_type === type &&
				(!latest || p.seq > latest.seq) &&
				done(p)
			) {
				latest = p;
			}
		}
	}
	return latest?.record.id;
};

/** The Run's input Artifacts and every Artifact it wrote, typed as this Run recorded them. */
const artifactsOf = (ledger: Ledger, home: string, run: Run): RunArtifacts => {
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

/**
 * A Run that failed, or wrote none of an output type, scores 0; otherwise
 * the stage's own Evaluation scores it.
 */
const evaluateRun = (
	stage: Stage,
	run: Run,
	artifacts: RunArtifacts,
): Scored => {
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

/**
 * One stage as a Task: propose it on `inputs` and any carried Artifacts,
 * assign and start it as the stage's Agent, run the Script, record the
 * Evaluation, and complete it (through Review by the stage's reviewer when
 * the Trust tier samples it) or fail it. Returns the stage's result and the
 * seq of the Task's last Event.
 */
const runStage = async (options: {
	ledger: Ledger;
	home: string;
	plan: StagePlan;
	inputs: readonly ArtifactId[];
	causation_id: Seq;
	filename: string;
	timeoutMs: number;
}): Promise<{ result: StageRun; seq: Seq }> => {
	const { ledger, home, plan, filename } = options;
	const { stage } = plan;
	const agent: Actor = { tag: "Agent", id: stage.worked_by };
	const carried = stage.carried.flatMap(
		(type) => latestAccepted(ledger.projections, type) ?? [],
	);
	const inputs = [...options.inputs, ...carried];

	const task_id = propose(ledger, {
		actor: OPERATOR,
		causation_id: options.causation_id,
		title: `Stage ${stage.number} ${stage.name}: ${filename}`,
		goal: `Run ${stage.script} and pass the stage ${stage.number} Evaluation`,
		inputs,
		priority: 1,
		tat_class: "Regular",
	}).task.id;
	const state = (): TaskState => taskOf(ledger.projections, task_id).state;
	assign(ledger, { actor: OPERATOR, task_id, assignee: stage.worked_by });
	const started = start(ledger, { actor: agent, task_id });

	const revisions: AgentDefinition[] = [];
	try {
		const run = await runScript({
			ledger,
			home,
			script: plan.script,
			inputs,
			actor: agent,
			task_id,
			causation_id: started.seq,
			timeoutMs: options.timeoutMs,
		});
		const artifacts = artifactsOf(ledger, home, run);
		const { outputs } = artifacts;
		const evaluation = evaluateRun(stage, run, artifacts);
		const evaluated = recordEvaluation(ledger, {
			actor: OPERATOR,
			stage: stage.number,
			task_id,
			run_id: run.id,
			...evaluation,
		});
		const { eval_id } = evaluated.evaluation;
		let last: Seq;
		if (evaluation.passed) {
			const completed = complete(ledger, {
				actor: agent,
				task_id,
				outputs: outputs.map((o) => o.id),
				reviewer: { tag: "Agent", id: stage.reviewed_by },
				causation_id: evaluated.seq,
			});
			last = completed.seq;
			if (completed.task.state.tag === "UnderReview") {
				const { reviewer } = completed.task.state;
				// The tracer has no reviewing Agent yet, so the Review stands in
				// for one: a passed Evaluation scores 3 on every dimension.
				const before = ledger.projections.org;
				review(ledger, {
					task_id,
					reviewer,
					quality: 3,
					traceability: 3,
					boundary_adherence: 3,
					collaboration: 3,
					timeliness: 3,
					note: `Evaluation ${eval_id} passed with score ${evaluation.score.toFixed(3)}; 3 on every dimension`,
				});
				revisions.push(...revisedBetween(before, ledger.projections.org));
				last = complete(ledger, { actor: reviewer, task_id }).seq;
			}
		} else {
			last = fail(ledger, {
				actor: agent,
				task_id,
				reason: `Evaluation ${eval_id} failed (score ${evaluation.score.toFixed(3)}): ${evaluation.findings.join("; ")}`,
				causation_id: evaluated.seq,
			}).seq;
		}
		return {
			result: {
				stage,
				task_id,
				run,
				outputs,
				eval_id,
				evaluation,
				revisions,
				state: state(),
			},
			seq: last,
		};
	} catch (error) {
		// Do not leave the Task InProgress when the chain breaks underneath it.
		if ((LIVE_TAGS as readonly string[]).includes(state().tag)) {
			fail(ledger, {
				actor: agent,
				task_id,
				reason: `workflow tracer stopped: ${(error as Error).message}`,
			});
		}
		throw error;
	}
};

/**
 * The toy workflow on one Submission Form: store it as a Fixture, then run
 * each planned stage in order on the Artifacts of its input types, each
 * from the latest earlier stage that wrote one (the Fixture for the first),
 * until the plan ends or a Task does not end Done. Before the first stage that takes the weighings, store them
 * from beside the Fixture. Each stage's TaskProposed names as its cause the
 * Fixture's ArtifactStored, then the previous stage's last TaskCompleted.
 */
export const runWorkflow = async (options: {
	ledger: Ledger;
	home: string;
	formPath: string;
	plan: readonly StagePlan[];
	timeoutMs: number;
}): Promise<WorkflowRun> => {
	const { ledger, home } = options;
	const filename = basename(options.formPath);
	const { artifact: fixture, seq: stored } = openArtifacts({
		ledger,
		home,
	}).store(
		readFileSync(options.formPath),
		{
			artifact_type: "SubmissionForm",
			media_type: guessMediaType(filename),
			produced_by: OPERATOR,
			lineage: [],
			filename,
		},
		{ actor: OPERATOR },
	);

	const stages: StageRun[] = [];
	const earlier: Given[] = [{ from: "the Fixture", artifacts: [fixture] }];
	let causation_id = stored;
	let weighings: Typed | undefined;
	for (const plan of options.plan) {
		if (plan.stage.inputs.includes(WEIGHINGS) && !weighings) {
			weighings = storeWeighings(ledger, home, plan.stage, options.formPath);
		}
		const { result, seq } = await runStage({
			ledger,
			home,
			plan,
			inputs: inputsFor(plan.stage, earlier, weighings),
			causation_id,
			filename,
			timeoutMs: options.timeoutMs,
		});
		stages.push(result);
		if (result.state.tag !== "Done") break;
		earlier.push({
			from: `stage ${plan.stage.number} ${plan.stage.name}`,
			artifacts: result.outputs,
		});
		causation_id = seq;
	}
	return { fixture: fixture.id, stages };
};

/**
 * Recruit the starting roster when the Ledger has no Agents yet, and refuse
 * a table that names an Agent the Org lacks.
 */
export const ensureRoster = (
	ledger: Ledger,
	stages: readonly Stage[],
): void => {
	if (ledger.projections.org.agents.size === 0) seedOrg(ledger);
	for (const stage of stages) {
		for (const agent of [stage.worked_by, stage.reviewed_by]) {
			if (!ledger.projections.org.agents.has(agent)) {
				throw new Error(
					`stage ${stage.number} ${stage.name} names ${agent}, who is not an Agent in the Org`,
				);
			}
		}
	}
};
