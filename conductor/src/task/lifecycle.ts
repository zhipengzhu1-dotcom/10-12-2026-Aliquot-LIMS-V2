import { orRefuse } from "../append-guard.js";
import type { EventBody, EventKind, NewEvent, PayloadOf } from "../events.js";
import { type GateRequest, requestGateForTask } from "../gate/lifecycle.js";
import type { Gate } from "../gate/projection.js";
import {
	type AgentId,
	type ArtifactId,
	nextId,
	RubricId,
	type Seq,
	TaskId,
} from "../ids.js";
import type { Ledger } from "../ledger.js";
import { type Origin, type Recorded, readBack } from "../lifecycle-support.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { Review } from "../types/merit.js";
import type { Task, TaskState, TatClass } from "../types/task.js";
import { reviewRefusal } from "../vitality/guards.js";
import { reviewerRefusal } from "../vitality/reviewers.js";
import { reviewSampleOf } from "../vitality/trust.js";
import { reviewsBy } from "../vitality/work.js";
import {
	assigneeRefusal,
	helpTargetRefusal,
	sampledRefusal,
} from "./guards.js";
import { helpRequester, stateIn } from "./projection.js";

/** The Event kinds that only the Task lifecycle appends. */
export const TASK_EVENT_KINDS = [
	"TaskProposed",
	"TaskAssigned",
	"TaskStarted",
	"TaskHandedOff",
	"TaskCompleted",
	"TaskFailed",
	"TaskEscalated",
	"ReviewRecorded",
	"HelpRequested",
] as const satisfies readonly EventKind[];
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/**
 * The kind of `event` when only the Task lifecycle may append it: a Task
 * Event kind, or a GateRequested that blocks a Task.
 */
export const taskEventKind = (
	event: NewEvent,
): TaskEventKind | "GateRequested" | undefined =>
	event.kind === "GateRequested"
		? event.task_id === undefined
			? undefined
			: event.kind
		: TASK_EVENT_KINDS.find((kind) => kind === event.kind);

/** The rubric a Task is proposed with when none is named: the five-dimension rubric. */
const DEFAULT_RUBRIC = RubricId.parse("default");

type TaskBody = Extract<EventBody, { payload: { task_id: TaskId } }>;

export const taskOf = (projections: Projections, task_id: TaskId): Task =>
	readBack(projections.tasks.tasks.get(task_id), task_id);

/**
 * Append `body`, naming the caller's cause, such as the Evaluation a
 * completion follows, or else the Task's previous Event; a proposal has none.
 */
const record = (
	ledger: Ledger,
	{ actor, causation_id }: Origin,
	body: TaskBody,
): Recorded<"task", Task> => {
	const { task_id } = body.payload;
	const cause = causation_id ?? ledger.projections.tasks.lastSeq.get(task_id);
	const { seq } = ledger.append({
		actor,
		task_id,
		...(cause === undefined ? {} : { causation_id: cause }),
		...body,
	});
	return { task: taskOf(ledger.projections, task_id), seq };
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
	}: Origin & {
		readonly title: string;
		readonly goal: string;
		readonly tat_class: TatClass;
		readonly priority: number;
		readonly inputs?: readonly ArtifactId[];
		readonly rubric_id?: RubricId;
		readonly parent_task?: TaskId;
	},
): Recorded<"task", Task> =>
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

/** Assign a Task to `assignee`, refused when it is strained or worse. */
export const assign = (
	ledger: Ledger,
	{
		task_id,
		assignee,
		...origin
	}: Origin & { readonly task_id: TaskId; readonly assignee: AgentId },
): Recorded<"task", Task> => {
	orRefuse("TaskAssigned", assigneeRefusal(ledger.projections, assignee));
	return record(ledger, origin, {
		kind: "TaskAssigned",
		payload: { task_id, assignee },
	});
};

export const start = (
	ledger: Ledger,
	{ task_id, ...origin }: Origin & { readonly task_id: TaskId },
): Recorded<"task", Task> =>
	record(ledger, origin, { kind: "TaskStarted", payload: { task_id } });

type ReviewDecision = PayloadOf<"TaskCompleted">["review"];

/** A completion, and the Review it decided on. */
export type Completed = Recorded<"task", Task> & {
	readonly review: ReviewDecision;
};

/**
 * The Review a completion records: Reviewed for a Task UnderReview; for an
 * InProgress one, Required from `reviewer` when the Trust tier samples it,
 * refused without a reviewer or with one the reviewer rule does not allow,
 * and Skipped when the sample leaves it out.
 */
const reviewFor = (
	projections: Projections,
	task_id: TaskId,
	state: Extract<TaskState, { tag: "InProgress" | "UnderReview" }>,
	reviewer: Actor | undefined,
): ReviewDecision | Refusal => {
	if (state.tag === "UnderReview") return { tag: "Reviewed" };
	const { tier, sampled } = reviewSampleOf(
		projections.trust,
		state.assignee,
		task_id,
	);
	if (!sampled) {
		return { tag: "Skipped", reason: `not sampled for Review at tier ${tier}` };
	}
	if (reviewer === undefined) {
		return new Refusal(sampledRefusal(task_id, state.assignee, tier));
	}
	return (
		reviewerRefusal(projections, task_id, state.assignee, reviewer) ?? {
			tag: "Required",
			reviewer,
		}
	);
};

/**
 * Complete a Task. An InProgress Task goes UnderReview to `reviewer` when the
 * Trust tier samples it for Review, and is refused without one or with one
 * that the assignee's role does not allow; otherwise it
 * skips Review to Done, leaving `reviewer` unused. A Task UnderReview goes
 * Done once its reviewer has recorded a Review, which the completion names
 * as its cause.
 */
export const complete = (
	ledger: Ledger,
	{
		task_id,
		outputs = [],
		reviewer,
		...origin
	}: Origin & {
		readonly task_id: TaskId;
		readonly outputs?: readonly ArtifactId[];
		/** Who reviews the Task when the Trust tier samples it for Review. */
		readonly reviewer?: Actor | undefined;
	},
): Completed => {
	const { projections } = ledger;
	const state = orRefuse(
		"TaskCompleted",
		stateIn(projections.tasks, task_id, ["InProgress", "UnderReview"]),
	);
	const review = orRefuse(
		"TaskCompleted",
		reviewFor(projections, task_id, state, reviewer),
	);
	const causation_id =
		origin.causation_id ??
		(state.tag === "UnderReview"
			? reviewsBy(projections.work, task_id, state.reviewer).at(-1)?.seq
			: undefined);
	const recorded = record(
		ledger,
		{ actor: origin.actor, causation_id },
		{
			kind: "TaskCompleted",
			payload: { task_id, outputs: [...outputs], review },
		},
	);
	return { ...recorded, review };
};

/**
 * The reviewer records a Review of a Task UnderReview, or Done, when the
 * reviewer rule allows it for the assignee.
 */
export const review = (
	ledger: Ledger,
	{
		causation_id,
		...payload
	}: Review & { readonly causation_id?: Seq | undefined },
): Recorded<"task", Task> => {
	orRefuse(
		"ReviewRecorded",
		reviewRefusal(ledger.projections, payload, payload.reviewer),
	);
	return record(
		ledger,
		{ actor: payload.reviewer, causation_id },
		{ kind: "ReviewRecorded", payload },
	);
};

/**
 * Hand an InProgress Task off from its assignee to `to`, which returns it to
 * Assigned. Refused when `to` is strained or worse.
 */
export const handOff = (
	ledger: Ledger,
	{
		task_id,
		to,
		reason,
		...origin
	}: Origin & {
		readonly task_id: TaskId;
		readonly to: AgentId;
		readonly reason: string;
	},
): Recorded<"task", Task> => {
	const { assignee: from } = orRefuse(
		"TaskHandedOff",
		stateIn(ledger.projections.tasks, task_id, ["InProgress"]),
	);
	orRefuse("TaskHandedOff", assigneeRefusal(ledger.projections, to));
	return record(ledger, origin, {
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
		...origin
	}: Origin & {
		readonly task_id: TaskId;
		readonly to: Actor;
		readonly reason: string;
	},
): Recorded<"task", Task> =>
	record(ledger, origin, {
		kind: "TaskEscalated",
		payload: { task_id, to, reason },
	});

/**
 * The assignee of a live Task requests help on it from the Operator or
 * another Agent. The Task keeps its state.
 */
export const requestHelp = (
	ledger: Ledger,
	{
		task_id,
		to,
		question,
		...origin
	}: Origin & {
		readonly task_id: TaskId;
		readonly to: Actor;
		readonly question: string;
	},
): Recorded<"task", Task> => {
	const { projections } = ledger;
	orRefuse(
		"HelpRequested",
		helpRequester(projections.tasks, task_id, origin.actor),
	);
	orRefuse("HelpRequested", helpTargetRefusal(projections, to));
	return record(ledger, origin, {
		kind: "HelpRequested",
		payload: { task_id, to, question },
	});
};

export const fail = (
	ledger: Ledger,
	{
		task_id,
		reason,
		...origin
	}: Origin & { readonly task_id: TaskId; readonly reason: string },
): Recorded<"task", Task> =>
	record(ledger, origin, {
		kind: "TaskFailed",
		payload: { task_id, reason },
	});

/**
 * Block an InProgress Task on a Gate it requests under the next free gate
 * id. The Gate's decision returns the Task to InProgress.
 */
export const block = (
	ledger: Ledger,
	{
		task_id,
		causation_id,
		...request
	}: Origin & GateRequest & { readonly task_id: TaskId },
): Recorded<"task", Task> & { readonly gate: Gate } => {
	const { gate, seq } = requestGateForTask(ledger, {
		...request,
		task_id,
		causation_id: causation_id ?? ledger.projections.tasks.lastSeq.get(task_id),
	});
	return { task: taskOf(ledger.projections, task_id), gate, seq };
};
