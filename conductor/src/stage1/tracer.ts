import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { sha256Hex } from "../hash.js";
import {
	type AgentId,
	type ArtifactId,
	type EvaluationId,
	ScriptId,
	type Sha256,
	type TaskId,
} from "../ids.js";
import type { Ledger } from "../ledger.js";
import { revisedBetween } from "../org/projection.js";
import { seedOrg } from "../org/seed.js";
import type { Projections } from "../projections.js";
import { openArtifacts, productionOf } from "../sandbox/artifacts.js";
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
import type { Run, Script, ScriptRef } from "../types/script.js";
import type { TaskState } from "../types/task.js";
import { evaluateSubmission, type SubmissionEvaluation } from "./evaluate.js";
import { recordEvaluation } from "./lifecycle.js";

const OPERATOR: Actor = { tag: "Operator" };
const SCRIPT_NAME = "parse_submission";
const RECORD_FILENAME = "submission.json";

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
 * The `parse_submission` version to run: the latest one when it was
 * registered on `image` from the same code as `source`, else a new version
 * (ScriptRegistered for the first, ScriptRevised after).
 */
export const ensureScript = (options: {
	ledger: Ledger;
	home: string;
	source: string;
	owner: AgentId;
	image: Sha256;
}): Script => {
	const { ledger, home, source, owner, image } = options;
	const latest = ledger.projections.scripts.scripts
		.get(ScriptId.parse(`S-${SCRIPT_NAME}`))
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
		name: SCRIPT_NAME,
		scriptDir: source,
		owner_agent: owner,
		input_types: ["SubmissionForm"],
		output_types: ["Other"],
		image_digest: image,
	});
};

/**
 * Who reviews the tracer's Task when the Trust tier samples it: the owner's
 * Supervisor (Pia, the intake Supervisor, for a Specialist), or the Operator
 * when it has none.
 */
export const reviewerOf = (projections: Projections, owner: AgentId): Actor => {
	const supervisor =
		projections.org.agents.get(owner)?.definition.supervisor_id;
	return supervisor ? { tag: "Agent", id: supervisor } : OPERATOR;
};

export type Stage1Result = {
	fixture: ArtifactId;
	task_id: TaskId;
	run: Run;
	/** The `submission.json` Artifact, when the Run wrote one. */
	record?: ArtifactId;
	eval_id: EvaluationId;
	evaluation: SubmissionEvaluation;
	/** Trust tier Revisions the tracer's Review brought about. */
	revisions: readonly AgentDefinition[];
	state: TaskState;
};

/** Read the Run's `submission.json` and evaluate it; a Run without one scores 0. */
const evaluateRun = (
	ledger: Ledger,
	home: string,
	run: Run,
): { record?: ArtifactId; evaluation: SubmissionEvaluation } => {
	const failed = (finding: string) => ({
		evaluation: { score: 0, passed: false, findings: [finding] },
	});
	if (run.exit_code !== 0) {
		return failed(
			`${run.id} exited ${run.exit_code}; its stderr is Artifact ${run.stderr_ref}`,
		);
	}
	const projection = ledger.projections.artifacts;
	const record = run.outputs.find(
		(id) =>
			productionOf(projection, id, { tag: "Run", id: run.id })?.record
				.filename === RECORD_FILENAME,
	);
	if (!record) return failed(`${run.id} wrote no ${RECORD_FILENAME}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			openArtifacts({ ledger, home }).read(record).toString("utf8"),
		);
	} catch (error) {
		return {
			record,
			...failed(`${RECORD_FILENAME} is not JSON: ${(error as Error).message}`),
		};
	}
	return { record, evaluation: evaluateSubmission(parsed) };
};

/**
 * Stage 1 end to end for one Submission Form: store it as a Fixture, propose
 * a Task for it, assign and start the Task, run `script` on it in the
 * Sandbox, evaluate the record, record the Evaluation, and complete the
 * Task (through Review when the owner's Trust tier samples it) or fail it.
 * From TaskProposed on, every Event names the Event before it as its
 * `causation_id`; TaskProposed names the Fixture's ArtifactStored.
 */
export const runStage1 = async (options: {
	ledger: Ledger;
	home: string;
	formPath: string;
	script: ScriptRef;
	owner: AgentId;
	timeoutMs: number;
}): Promise<Stage1Result> => {
	const { ledger, home, owner } = options;
	const ownerActor: Actor = { tag: "Agent", id: owner };
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

	const task_id = propose(ledger, {
		actor: OPERATOR,
		causation_id: stored,
		title: `Parse Submission Form ${filename}`,
		goal: "Extract the submission record and pass the stage 1 Evaluation",
		inputs: [fixture.id],
		priority: 1,
		tat_class: "Regular",
	}).task.id;
	const state = (): TaskState => taskOf(ledger.projections, task_id).state;
	assign(ledger, { actor: OPERATOR, task_id, assignee: owner });
	const started = start(ledger, { actor: ownerActor, task_id });

	const revisions: AgentDefinition[] = [];
	try {
		const run = await runScript({
			ledger,
			home,
			script: options.script,
			inputs: [fixture.id],
			actor: ownerActor,
			task_id,
			causation_id: started.seq,
			timeoutMs: options.timeoutMs,
		});
		const { record, evaluation } = evaluateRun(ledger, home, run);
		const evaluated = recordEvaluation(ledger, {
			actor: OPERATOR,
			task_id,
			run_id: run.id,
			...evaluation,
		});
		const { eval_id } = evaluated.evaluation;
		if (evaluation.passed) {
			const completed = complete(ledger, {
				actor: ownerActor,
				task_id,
				outputs: record ? [record] : [],
				reviewer: reviewerOf(ledger.projections, owner),
				causation_id: evaluated.seq,
			}).task;
			if (completed.state.tag === "UnderReview") {
				const { reviewer } = completed.state;
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
				complete(ledger, { actor: reviewer, task_id });
			}
		} else {
			fail(ledger, {
				actor: ownerActor,
				task_id,
				reason: `Evaluation ${eval_id} failed (score ${evaluation.score.toFixed(3)}): ${evaluation.findings.join("; ")}`,
				causation_id: evaluated.seq,
			});
		}
		return {
			fixture: fixture.id,
			task_id,
			run,
			...(record ? { record } : {}),
			eval_id,
			evaluation,
			revisions,
			state: state(),
		};
	} catch (error) {
		// Do not leave the Task InProgress when the chain breaks underneath it.
		if ((LIVE_TAGS as readonly string[]).includes(state().tag)) {
			fail(ledger, {
				actor: ownerActor,
				task_id,
				reason: `stage1 tracer stopped: ${(error as Error).message}`,
			});
		}
		throw error;
	}
};

/** Recruit the starting roster when the Ledger has no Agents yet. */
export const ensureOwner = (ledger: Ledger, owner: AgentId): void => {
	if (ledger.projections.org.agents.size === 0) seedOrg(ledger);
	if (!ledger.projections.org.agents.has(owner)) {
		throw new Error(`${owner} is not an Agent in the Org`);
	}
};
