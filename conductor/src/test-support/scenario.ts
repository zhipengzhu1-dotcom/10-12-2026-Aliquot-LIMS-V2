import type { Event, NewEvent } from "../events.js";
import { gateDecision, requestGate } from "../gate/request.js";
import {
	AgentId,
	ArtifactId,
	EvaluationId,
	type GateId,
	RunId,
	ScriptId,
	type Seq,
	Sha256,
	type TaskId,
} from "../ids.js";
import {
	type Ledger,
	type LedgerOptions,
	openLedger,
	openMemoryLedger,
} from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import type { Storage } from "../storage.js";
import {
	assign,
	complete,
	propose,
	type Recorded,
	review as reviewTask,
	start,
} from "../task/lifecycle.js";
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
 * A seeded Ledger with a settable clock, and verbs that walk Tasks through
 * the Task lifecycle, so the Ledger records what production records: in
 * memory, on `storage` when given, or in SQLite under `home` for a test that
 * hands the home to the command line. For tests and demos only.
 */
export const scenario = (
	at = "2026-10-01T00:00:00.000Z",
	options: {
		storage?: Storage;
		home?: string;
		/**
		 * Write no follow-on tier Revisions, as a Ledger written before
		 * ADR-0011 did, for a test of the catch-up that repairs such a Ledger.
		 */
		beforeAdr0011?: boolean;
	} = {},
) => {
	let now = new Date(at);
	const { home, storage, beforeAdr0011 } = options;
	const opened: LedgerOptions = {
		writer: true,
		clock: () => now,
		...(beforeAdr0011 ? { followOns: [] } : {}),
	};
	const ledger: Ledger =
		home === undefined
			? openMemoryLedger({ ...opened, ...(storage && { storage }) })
			: openLedger({ ...opened, home });
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
	let runs = 0;

	const append = (e: NewEvent): Event => ledger.append(e);
	const on = (
		task_id: TaskId,
		body: Omit<NewEvent, "actor">,
		actor: Actor = operator,
	) => append({ actor, task_id, ...body } as NewEvent);

	// Each Task Event names the Task's Event before it as its cause, as the
	// stage 1 tracer's do.
	const causes = new Map<TaskId, Seq>();
	const chained = (r: Recorded): Recorded => {
		causes.set(r.task.id, r.seq);
		return r;
	};
	const cause = (task_id: TaskId) => ({ causation_id: causes.get(task_id) });

	const self = (agent: AgentId): Actor => ({ tag: "Agent", id: agent });

	/** Propose a Task, assign it to `agent`, and start it unless told not to. */
	const task = (agent: AgentId, { start: started = true } = {}): TaskId => {
		const { id } = chained(
			propose(ledger, {
				actor: operator,
				title: `Task ${ledger.projections.tasks.tasks.size + 1}`,
				goal: "Do the work",
				tat_class: "Regular",
				priority: 1,
			}),
		).task;
		chained(
			assign(ledger, {
				actor: operator,
				task_id: id,
				assignee: agent,
				...cause(id),
			}),
		);
		if (started) {
			chained(start(ledger, { actor: self(agent), task_id: id, ...cause(id) }));
		}
		return id;
	};

	/**
	 * Complete a started Task with review Required, so it is UnderReview,
	 * whether or not the sample for the Agent's tier picks it.
	 */
	const submit = (
		agent: AgentId,
		task_id: TaskId,
		reviewer: Actor = operator,
	) =>
		chained(
			complete(ledger, {
				actor: self(agent),
				task_id,
				outputs: [artifact],
				reviewer,
				reviewUnsampled: true,
				...cause(task_id),
			}),
		);

	const review = (
		task_id: TaskId,
		s: Scores,
		reviewer: Actor = operator,
	): Recorded =>
		chained(
			reviewTask(ledger, {
				task_id,
				reviewer,
				...s,
				note: "",
				...cause(task_id),
			}),
		);

	/** The Operator reviews a Task UnderReview with `s` and completes it. */
	const close = (task_id: TaskId, s: Scores) => {
		review(task_id, s);
		chained(complete(ledger, { actor: operator, task_id, ...cause(task_id) }));
	};

	/** A Task that `agent` finishes and the Operator reviews with `s`. */
	const reviewed = (agent: AgentId, s: Scores): TaskId => {
		const id = task(agent);
		submit(agent, id);
		close(id, s);
		return id;
	};

	/**
	 * A Task that `agent` completes with no reviewer. The Ledger refuses it
	 * unless the sample for the Agent's tier leaves the next Task id out.
	 */
	const skipped = (agent: AgentId): TaskId => {
		const id = task(agent);
		chained(
			complete(ledger, {
				actor: self(agent),
				task_id: id,
				outputs: [artifact],
				...cause(id),
			}),
		);
		return id;
	};

	/**
	 * A Task that `agent` completes for the Operator to review when the
	 * sample for its tier picks it: reviewed with `s` then, skipped otherwise.
	 */
	const worked = (agent: AgentId, s: Scores): TaskId => {
		const id = task(agent);
		const { task: completed } = chained(
			complete(ledger, {
				actor: self(agent),
				task_id: id,
				outputs: [artifact],
				reviewer: operator,
				...cause(id),
			}),
		);
		if (completed.state.tag === "UnderReview") close(id, s);
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

	/** A Gate the Operator requests and leaves Open. */
	const requested = (kind: GateKind, payload: { agent_id: string }): GateId =>
		requestGate(ledger, { actor: operator, kind, payload }).gate_id;

	/** The Operator's decision on an Open Gate at the current time. */
	const decided = (
		gate_id: GateId,
		meaning: "approve" | "reject" = "approve",
	): Event => {
		const open = ledger.projections.gates.gates.get(gate_id);
		if (open === undefined) throw new Error(`${gate_id} was not stored`);
		return append(gateDecision(open, meaning, "Checked"));
	};

	/** A Gate the Operator requests and decides at the current time. */
	const gate = (
		kind: GateKind,
		payload: { agent_id: string },
		meaning: "approve" | "reject" = "approve",
	): GateId => {
		const gate_id = requested(kind, payload);
		decided(gate_id, meaning);
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
		ledger,
		append,
		requested,
		decided,
		gate,
		retire,
		task,
		submit,
		review,
		reviewed,
		skipped,
		worked,
		run,
		events: () => ledger.all(),
		now: () => now,
		at: (iso: string) => {
			now = new Date(iso);
		},
		advanceDays: (days: number) => {
			now = new Date(now.getTime() + days * 86_400_000);
		},
		close: () => ledger.close(),
	};
};

export type Scenario = ReturnType<typeof scenario>;
