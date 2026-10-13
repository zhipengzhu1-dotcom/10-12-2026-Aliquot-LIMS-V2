import type { EventBody, PayloadOf } from "../events.js";
import { type GateRequest, requestGate } from "../gate/request.js";
import {
	type AgentId,
	type ArtifactId,
	type GateId,
	nextId,
	RubricId,
	type Seq,
	type Sha256,
	TaskId,
} from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Projections } from "../projections.js";
import type { Actor } from "../types/actor.js";
import type { Review } from "../types/merit.js";
import type { Task, TatClass } from "../types/task.js";
import { reviewSampleOf } from "../vitality/trust.js";

/** The rubric a Task is proposed with when none is named: the five-dimension rubric. */
const DEFAULT_RUBRIC = RubricId.parse("default");

/** Who appends a Task Event, and the Event that caused it. */
type Step = { readonly actor: Actor; readonly causation_id?: Seq | undefined };

/** The Task as the Event left it, and the Event's seq. */
export type Recorded = { readonly task: Task; readonly seq: Seq };

type TaskBody = Extract<EventBody, { payload: { task_id: TaskId } }>;

const taskOf = (ledger: Ledger, task_id: TaskId): Task => {
	const task = ledger.projections.tasks.tasks.get(task_id);
	if (task === undefined) throw new Error(`${task_id} vanished`);
	return task;
};

const record = (
	ledger: Ledger,
	{ actor, causation_id }: Step,
	body: TaskBody,
): Recorded => {
	const { task_id } = body.payload;
	const { seq } = ledger.append({
		actor,
		task_id,
		...(causation_id === undefined ? {} : { causation_id }),
		...body,
	});
	return { task: taskOf(ledger, task_id), seq };
};

/** Propose a Task under the next free Task id. */
export const propose = (
	ledger: Ledger,
	{
		actor,
		causation_id,
		inputs = [],
		rubric_id = DEFAULT_RUBRIC,
		...fields
	}: Step & {
		readonly title: string;
		readonly goal: string;
		readonly tat_class: TatClass;
		readonly priority: number;
		readonly inputs?: readonly ArtifactId[];
		readonly rubric_id?: RubricId;
		readonly parent_task?: TaskId;
	},
): Recorded =>
	record(
		ledger,
		{ actor, causation_id },
		{
			kind: "TaskProposed",
			payload: {
				task_id: TaskId.parse(
					nextId("T", ledger.projections.tasks.tasks.keys()),
				),
				...fields,
				inputs: [...inputs],
				rubric_id,
			},
		},
	);

export const assign = (
	ledger: Ledger,
	{
		task_id,
		assignee,
		...step
	}: Step & { readonly task_id: TaskId; readonly assignee: AgentId },
): Recorded =>
	record(ledger, step, {
		kind: "TaskAssigned",
		payload: { task_id, assignee },
	});

export const start = (
	ledger: Ledger,
	{ task_id, ...step }: Step & { readonly task_id: TaskId },
): Recorded =>
	record(ledger, step, { kind: "TaskStarted", payload: { task_id } });

type Completion = Step & {
	readonly task_id: TaskId;
	readonly outputs?: readonly ArtifactId[];
	/** Who reviews the Task when the Trust tier samples it for Review. */
	readonly reviewer?: Actor;
	/**
	 * Review the Task even when the sample leaves it out, as the Auditor may
	 * add a Review to any Task.
	 */
	readonly reviewUnsampled?: boolean;
};

/**
 * The Review a completion records: Reviewed for a Task UnderReview; for an
 * InProgress one, Required from the reviewer when the Trust tier samples it,
 * else Skipped.
 */
const reviewFor = (
	projections: Projections,
	{ task_id, reviewer, reviewUnsampled }: Completion,
): PayloadOf<"TaskCompleted">["review"] => {
	const state = projections.tasks.tasks.get(task_id)?.state;
	if (state?.tag === "UnderReview") return { tag: "Reviewed" };
	// The Ledger refuses a Task in any other state on its state alone.
	if (state?.tag !== "InProgress") return { tag: "Skipped", reason: "" };
	const { tier, sampled } = reviewSampleOf(
		projections.trust,
		state.assignee,
		task_id,
	);
	if (reviewer !== undefined && (sampled || reviewUnsampled)) {
		return { tag: "Required", reviewer };
	}
	// The Ledger refuses this skip for a sampled Task, saying it was sampled
	// for Review.
	return { tag: "Skipped", reason: `not sampled for Review at tier ${tier}` };
};

/**
 * Complete a Task. An InProgress Task goes UnderReview or, when the Trust
 * tier leaves it out of the sample, skips Review to Done; a Task UnderReview
 * goes Done once its reviewer has recorded a Review.
 */
export const complete = (ledger: Ledger, completion: Completion): Recorded =>
	record(ledger, completion, {
		kind: "TaskCompleted",
		payload: {
			task_id: completion.task_id,
			outputs: [...(completion.outputs ?? [])],
			review: reviewFor(ledger.projections, completion),
		},
	});

/** The reviewer records a Review of a Task UnderReview. */
export const review = (
	ledger: Ledger,
	{
		causation_id,
		...payload
	}: Review & { readonly causation_id?: Seq | undefined },
): Recorded =>
	record(
		ledger,
		{ actor: payload.reviewer, causation_id },
		{ kind: "ReviewRecorded", payload },
	);

/**
 * Hand an InProgress Task off from its assignee to `to`, which returns it to
 * Assigned.
 */
export const handOff = (
	ledger: Ledger,
	{
		task_id,
		to,
		reason,
		...step
	}: Step & {
		readonly task_id: TaskId;
		readonly to: AgentId;
		readonly reason: string;
	},
): Recorded => {
	const state = ledger.projections.tasks.tasks.get(task_id)?.state;
	// A Task with no assignee is not InProgress, so the Ledger refuses it on
	// its state before `from` matters.
	const from = state && "assignee" in state ? state.assignee : to;
	return record(ledger, step, {
		kind: "TaskHandedOff",
		payload: { task_id, from, to, reason },
	});
};

export const escalate = (
	ledger: Ledger,
	{
		task_id,
		to,
		reason,
		...step
	}: Step & {
		readonly task_id: TaskId;
		readonly to: Actor;
		readonly reason: string;
	},
): Recorded =>
	record(ledger, step, {
		kind: "TaskEscalated",
		payload: { task_id, to, reason },
	});

export const fail = (
	ledger: Ledger,
	{
		task_id,
		reason,
		...step
	}: Step & { readonly task_id: TaskId; readonly reason: string },
): Recorded =>
	record(ledger, step, { kind: "TaskFailed", payload: { task_id, reason } });

/**
 * Block an InProgress Task on a Gate it requests under the next free gate
 * id. The Gate's decision returns the Task to InProgress.
 */
export const block = (
	ledger: Ledger,
	request: GateRequest & { readonly task_id: TaskId },
): Recorded & { readonly gate_id: GateId; readonly payload_hash: Sha256 } => {
	const { gate_id, payload_hash, seq } = requestGate(ledger, request);
	return { task: taskOf(ledger, request.task_id), seq, gate_id, payload_hash };
};
