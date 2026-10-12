import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, NewEvent } from "../events.js";
import { projectGates } from "../gate/projection.js";
import { gateDecision, requestGate } from "../gate/request.js";
import {
	AgentId,
	ArtifactId,
	EvaluationId,
	type GateId,
	RubricId,
	RunId,
	ScriptId,
	Sha256,
	TaskId,
} from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import type { Actor } from "../types/actor.js";
import type { GateKind } from "../types/gate.js";
import type { Review, Score } from "../types/merit.js";

export type Scores = Pick<
	Review,
	| "quality"
	| "traceability"
	| "boundary_adherence"
	| "collaboration"
	| "timeliness"
>;

/** Every dimension at `score`, then any overrides. */
export const scores = (score: Score, overrides: Partial<Scores> = {}) => ({
	quality: score,
	traceability: score,
	boundary_adherence: score,
	collaboration: score,
	timeliness: score,
	...overrides,
});

const operator: Actor = { tag: "Operator" };
const artifact = ArtifactId.parse("a".repeat(64));

/**
 * A seeded Ledger in a temp home with a settable clock, and verbs that walk
 * Tasks through the real Task state machine. For tests and demos only.
 */
export const scenario = (start = "2026-10-01T00:00:00.000Z") => {
	const home = mkdtempSync(join(tmpdir(), "aliquot-vitality-"));
	let now = new Date(start);
	const ledger: Ledger = openLedger({
		home,
		writer: true,
		clock: () => now,
	});
	seedOrg(ledger);
	// One stored Artifact and one registered Script, so Runs pass the Sandbox guards.
	ledger.append({
		actor: operator,
		kind: "ArtifactStored",
		payload: {
			id: artifact,
			sha256: Sha256.parse(artifact),
			media_type: "text/plain",
			artifact_type: "Other",
			produced_by: { tag: "Operator" },
			lineage: [],
		},
	});
	ledger.append({
		actor: operator,
		kind: "ScriptRegistered",
		payload: {
			id: ScriptId.parse("S-copy"),
			version: 1,
			name: "copy",
			owner_agent: AgentId.parse("A-bram"),
			input_types: [],
			output_types: [],
			entrypoint: "main.py",
			fixtures: [],
			image_digest: Sha256.parse("b".repeat(64)),
		},
	});
	let tasks = 0;
	let runs = 0;

	const append = (e: NewEvent): Event => ledger.append(e);
	const on = (
		task_id: TaskId,
		body: Omit<NewEvent, "actor">,
		actor: Actor = operator,
	) => append({ actor, task_id, ...body } as NewEvent);

	/** Propose a Task, assign it to `agent`, and start it unless told not to. */
	const task = (agent: AgentId, { start = true } = {}): TaskId => {
		tasks += 1;
		const task_id = TaskId.parse(`T-${tasks}`);
		on(task_id, {
			kind: "TaskProposed",
			payload: {
				task_id,
				title: `Task ${tasks}`,
				goal: "Do the work",
				inputs: [],
				rubric_id: RubricId.parse("rubric-1"),
				priority: 1,
				tat_class: "Regular",
			},
		});
		on(task_id, {
			kind: "TaskAssigned",
			payload: { task_id, assignee: agent },
		});
		if (start) on(task_id, { kind: "TaskStarted", payload: { task_id } });
		return task_id;
	};

	const self = (agent: AgentId): Actor => ({ tag: "Agent", id: agent });

	/** Complete a started Task with review Required, so it is UnderReview. */
	const submit = (
		agent: AgentId,
		task_id: TaskId,
		reviewer: Actor = operator,
	) =>
		on(
			task_id,
			{
				kind: "TaskCompleted",
				payload: {
					task_id,
					outputs: [artifact],
					review: { tag: "Required", reviewer },
				},
			},
			self(agent),
		);

	const review = (
		task_id: TaskId,
		s: Scores,
		reviewer: Actor = operator,
	): Event =>
		on(
			task_id,
			{
				kind: "ReviewRecorded",
				payload: { task_id, reviewer, ...s, note: "" },
			},
			reviewer,
		);

	/** A Task that `agent` finishes and the Operator reviews with `s`. */
	const reviewed = (agent: AgentId, s: Scores): TaskId => {
		const id = task(agent);
		submit(agent, id);
		review(id, s);
		on(id, {
			kind: "TaskCompleted",
			payload: { task_id: id, outputs: [], review: { tag: "Reviewed" } },
		});
		return id;
	};

	/** A Task that the Trust tier rules skip for Review. */
	const skipped = (agent: AgentId): TaskId => {
		const id = task(agent);
		on(
			id,
			{
				kind: "TaskCompleted",
				payload: {
					task_id: id,
					outputs: [artifact],
					review: { tag: "Skipped", reason: "not sampled" },
				},
			},
			self(agent),
		);
		return id;
	};

	/** A Run on `task_id` that exits with `exit_code`, and its Evaluation. */
	const run = (task_id: TaskId, exit_code: number, score?: number) => {
		runs += 1;
		const id = RunId.parse(`R-${runs}`);
		const script = { id: ScriptId.parse("S-copy"), version: 1 };
		on(task_id, {
			kind: "RunStarted",
			payload: { run_id: id, script, inputs: [] },
		});
		on(task_id, {
			kind: "RunFinished",
			payload: {
				id,
				script,
				inputs: [],
				outputs: [],
				exit_code,
				stdout_ref: artifact,
				stderr_ref: artifact,
				duration_ms: 1,
			},
		});
		if (score === undefined) return;
		on(task_id, {
			kind: "EvaluationRecorded",
			payload: {
				eval_id: EvaluationId.parse(`E-${runs}`),
				run_id: id,
				task_id,
				score,
				passed: score >= 0.5,
				findings: [],
			},
		});
	};

	/** A Gate the Operator requests and decides at the current time. */
	const gate = (
		kind: GateKind,
		payload: { agent_id: string },
		meaning: "approve" | "reject" = "approve",
	): GateId => {
		const { gate_id } = requestGate(ledger, { actor: operator, kind, payload });
		const requested = projectGates(ledger.events()).gates.get(gate_id);
		if (requested === undefined) throw new Error(`${gate_id} was not stored`);
		append(gateDecision(requested, now, meaning, "Checked"));
		return gate_id;
	};

	/** Retire `agent` through an approved RetireAgent Gate. */
	const retire = (agent: AgentId, reason: string) =>
		append({
			actor: operator,
			kind: "AgentRetired",
			payload: {
				agent_id: agent,
				reason,
				gate_id: gate("RetireAgent", { agent_id: agent }),
			},
		});

	return {
		home,
		ledger,
		append,
		gate,
		retire,
		task,
		submit,
		review,
		reviewed,
		skipped,
		run,
		events: () => ledger.all(),
		now: () => now,
		at: (iso: string) => {
			now = new Date(iso);
		},
		advanceDays: (days: number) => {
			now = new Date(now.getTime() + days * 86_400_000);
		},
		close: () => {
			ledger.close();
			rmSync(home, { recursive: true, force: true });
		},
	};
};

export type Scenario = ReturnType<typeof scenario>;
