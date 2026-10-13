import type { Event, NewEvent } from "../events.js";
import { gateDecision, requestGate } from "../gate/request.js";
import {
	AgentId,
	ArtifactId,
	type GateId,
	Sha256,
	type TaskId,
} from "../ids.js";
import {
	type Ledger,
	type LedgerOptions,
	openLedger,
	openMemoryLedger,
} from "../ledger.js";
import { retire as retireAgent } from "../org/lifecycle.js";
import { seedOrg } from "../org/seed.js";
import { finishRun, register, startRun, store } from "../sandbox/lifecycle.js";
import { recordEvaluation } from "../stage1/lifecycle.js";
import type { Storage } from "../storage.js";
import {
	assign,
	complete,
	propose,
	type Recorded,
	review as reviewTask,
	start,
	type TaskEventKind,
	taskEventKind,
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

/** An Event that the Task lifecycle does not own, which a test may append itself. */
export type NonTaskEvent = Exclude<NewEvent, { kind: TaskEventKind }>;

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
	options: { storage?: Storage; home?: string } = {},
) => {
	let now = new Date(at);
	const { home, storage } = options;
	const opened: LedgerOptions = { writer: true, clock: () => now };
	const ledger: Ledger =
		home === undefined
			? openMemoryLedger({ ...opened, ...(storage && { storage }) })
			: openLedger({ ...opened, home });
	seedOrg(ledger);
	// One stored Artifact and one registered Script, so Runs pass the Sandbox guards.
	store(
		ledger,
		{ actor: operator },
		{
			sha256: Sha256.parse(artifact),
			media_type: "text/plain",
			artifact_type: "Other",
			produced_by: operator,
			lineage: [],
		},
	);
	const { script } = register(ledger, {
		actor: operator,
		name: "copy",
		owner_agent: AgentId.parse("A-bram"),
		input_types: [],
		output_types: [],
		entrypoint: "main.py",
		image_digest: Sha256.parse("b".repeat(64)),
	});

	/** Append an Event outside the Task lifecycle, such as a Gate decision. */
	const appendNonTask = (event: NonTaskEvent): Event => {
		const kind = taskEventKind(event);
		if (kind !== undefined) {
			throw new Error(`only the Task lifecycle appends ${kind}`);
		}
		return ledger.append(event);
	};

	const self = (agent: AgentId): Actor => ({ tag: "Agent", id: agent });

	/** Propose a Task, assign it to `agent`, and start it unless told not to. */
	const task = (agent: AgentId, { start: started = true } = {}): TaskId => {
		const { id } = propose(ledger, {
			actor: operator,
			title: `Task ${ledger.projections.tasks.tasks.size + 1}`,
			goal: "Do the work",
			tat_class: "Regular",
			priority: 1,
		}).task;
		assign(ledger, { actor: operator, task_id: id, assignee: agent });
		if (started) start(ledger, { actor: self(agent), task_id: id });
		return id;
	};

	/** `agent` completes `task_id`, naming `reviewer` for when it is sampled. */
	const completed = (agent: AgentId, task_id: TaskId, reviewer?: Actor) =>
		complete(ledger, {
			actor: self(agent),
			task_id,
			outputs: [artifact],
			reviewer,
		});

	/**
	 * The next Task of `agent` that the sample for its tier picks for Review,
	 * completed for `reviewer` to review, so it is UnderReview. Each Task the
	 * sample leaves out on the way is completed with Review skipped, as
	 * production records it. On Probation the sample picks every Task.
	 */
	const submitted = (agent: AgentId, reviewer: Actor = operator): TaskId => {
		for (;;) {
			const id = task(agent);
			const { task: done } = completed(agent, id, reviewer);
			if (done.state.tag === "UnderReview") return id;
		}
	};

	const review = (
		task_id: TaskId,
		s: Scores,
		reviewer: Actor = operator,
	): Recorded => reviewTask(ledger, { task_id, reviewer, ...s, note: "" });

	/** The Operator reviews a Task UnderReview with `s` and completes it. */
	const close = (task_id: TaskId, s: Scores) => {
		review(task_id, s);
		complete(ledger, { actor: operator, task_id });
	};

	/**
	 * The next Task of `agent` that the sample picks for Review, which the
	 * Operator reviews with `s`; see `submitted`.
	 */
	const reviewed = (agent: AgentId, s: Scores): TaskId => {
		const id = submitted(agent);
		close(id, s);
		return id;
	};

	/**
	 * A Task that `agent` completes with no reviewer. The lifecycle refuses it
	 * unless the sample for the Agent's tier leaves the next Task id out.
	 */
	const skipped = (agent: AgentId): TaskId => {
		const id = task(agent);
		completed(agent, id);
		return id;
	};

	/**
	 * A Task that `agent` completes for the Operator to review when the
	 * sample for its tier picks it: reviewed with `s` then, skipped otherwise.
	 */
	const worked = (agent: AgentId, s: Scores): TaskId => {
		const id = task(agent);
		const { task: done } = completed(agent, id, operator);
		if (done.state.tag === "UnderReview") close(id, s);
		return id;
	};

	/** A Run on `task_id` that exits with `exit_code`, and its Evaluation. */
	const run = (task_id: TaskId, exit_code: number, score?: number) => {
		const { run_id: id } = startRun(ledger, {
			actor: operator,
			task_id,
			script,
			inputs: [],
		});
		finishRun(ledger, {
			actor: operator,
			run: {
				id,
				script: { id: script.id, version: script.version },
				inputs: [],
				outputs: [],
				exit_code,
				stdout_ref: artifact,
				stderr_ref: artifact,
				duration_ms: 1,
			},
		});
		if (score === undefined) return;
		recordEvaluation(ledger, {
			actor: operator,
			task_id,
			run_id: id,
			score,
			passed: score >= 0.5,
			findings: [],
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
		return appendNonTask(gateDecision(open, meaning, "Checked"));
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
		retireAgent(ledger, {
			actor: operator,
			agent_id: agent,
			gate_id: gate("RetireAgent", { agent_id: agent }),
			reason,
		});

	return {
		ledger,
		appendNonTask,
		requested,
		decided,
		gate,
		retire,
		task,
		submitted,
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
