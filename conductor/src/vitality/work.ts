import type { Event, PayloadOf } from "../events.js";
import { canonicalJson } from "../hash.js";
import type { AgentId, EvaluationId, Seq, TaskId } from "../ids.js";
import type { Projections } from "../projections.js";
import type { Projection } from "../reduce.js";
import { assigneeOf, type TaskView } from "../task/projection.js";
import type { Actor } from "../types/actor.js";
import type { Review } from "../types/merit.js";
import type { Vitality } from "../types/vitality.js";

/** A Review of a Task, with when it was recorded. */
export type DatedReview = {
	readonly review: Review;
	readonly seq: Seq;
	readonly ts: string;
};

/**
 * One Agent's work: the Tasks last assigned or handed off to it, each with
 * the seq of that assignment, and the Reviews counted toward its Merit, in
 * Ledger order.
 */
export type AgentWork = {
	readonly assigned: ReadonlyMap<TaskId, Seq>;
	readonly reviews: readonly DatedReview[];
};

/** What the Ledger says about the society's work, as Vitality reads it. */
export type WorkState = {
	readonly agents: ReadonlyMap<AgentId, AgentWork>;
	/** Every Review of each Task, in Ledger order. */
	readonly reviews: ReadonlyMap<TaskId, readonly DatedReview[]>;
	/** Tasks completed with Review skipped. */
	readonly skipped: ReadonlySet<TaskId>;
	/** Agents whose latest RestOrdered is a `begin`. */
	readonly resting: ReadonlySet<AgentId>;
	/** Each Agent's latest VitalitySampled. */
	readonly samples: ReadonlyMap<AgentId, Vitality>;
	/** How many Runs for each Task finished with a nonzero exit code. */
	readonly failedRuns: ReadonlyMap<TaskId, number>;
	/** Every Evaluation, in Ledger order. */
	readonly evaluations: ReadonlyMap<
		EvaluationId,
		PayloadOf<"EvaluationRecorded">
	>;
};

const NO_WORK: AgentWork = { assigned: new Map(), reviews: [] };

const withWork = (
	agents: ReadonlyMap<AgentId, AgentWork>,
	agent: AgentId,
	change: (work: AgentWork) => AgentWork,
) => new Map(agents).set(agent, change(agents.get(agent) ?? NO_WORK));

/** `task` leaves its previous assignee's work and joins `to`'s at `seq`. */
const reassigned = (
	agents: ReadonlyMap<AgentId, AgentWork>,
	tasks: TaskView,
	task: TaskId,
	to: AgentId,
	seq: Seq,
) => {
	const from = assigneeOf(tasks.tasks.get(task));
	const left =
		from === undefined || from === to
			? agents
			: withWork(agents, from, (w) => {
					const assigned = new Map(w.assigned);
					assigned.delete(task);
					return { ...w, assigned };
				});
	return withWork(left, to, (w) => ({
		...w,
		assigned: new Map(w.assigned).set(task, seq),
	}));
};

/**
 * The Agent a ReviewRecorded counts toward, with the Review: the Task's
 * assignee, unless the Trust tier rules skipped the Task for Review (an
 * Auditor may still add one), so that such a Review never counts toward
 * Merit.
 */
export const countedReview = (
	projections: Projections,
	event: Event,
): { readonly agent: AgentId; readonly review: DatedReview } | undefined => {
	if (event.kind !== "ReviewRecorded") return undefined;
	const { task_id } = event.payload;
	const agent = assigneeOf(projections.tasks.tasks.get(task_id));
	if (agent === undefined || projections.work.skipped.has(task_id)) {
		return undefined;
	}
	return { agent, review: datedReview(event) };
};

const datedReview = (
	event: Extract<Event, { kind: "ReviewRecorded" }>,
): DatedReview => ({ review: event.payload, seq: event.seq, ts: event.ts });

/** The Reviews of `task_id` that `reviewer` recorded, in Ledger order. */
export const reviewsBy = (
	work: WorkState,
	task_id: TaskId,
	reviewer: Actor,
): readonly DatedReview[] => {
	const by = canonicalJson(reviewer);
	return (work.reviews.get(task_id) ?? []).filter(
		(r) => canonicalJson(r.review.reviewer) === by,
	);
};

export const WorkProjection: Projection<WorkState> = {
	init: {
		agents: new Map(),
		reviews: new Map(),
		skipped: new Set(),
		resting: new Set(),
		samples: new Map(),
		failedRuns: new Map(),
		evaluations: new Map(),
	},
	reduce: (state, event, projections) => {
		switch (event.kind) {
			case "TaskAssigned": {
				const { task_id, assignee } = event.payload;
				return {
					...state,
					agents: reassigned(
						state.agents,
						projections.tasks,
						task_id,
						assignee,
						event.seq,
					),
				};
			}
			case "TaskHandedOff": {
				const { task_id, to } = event.payload;
				return {
					...state,
					agents: reassigned(
						state.agents,
						projections.tasks,
						task_id,
						to,
						event.seq,
					),
				};
			}
			case "TaskCompleted": {
				const { task_id, review } = event.payload;
				return review.tag === "Skipped"
					? { ...state, skipped: new Set(state.skipped).add(task_id) }
					: state;
			}
			case "ReviewRecorded": {
				const { task_id } = event.payload;
				const counted = countedReview(projections, event);
				return {
					...state,
					reviews: new Map(state.reviews).set(task_id, [
						...(state.reviews.get(task_id) ?? []),
						datedReview(event),
					]),
					agents:
						counted === undefined
							? state.agents
							: withWork(state.agents, counted.agent, (w) => ({
									...w,
									reviews: [...w.reviews, counted.review],
								})),
				};
			}
			case "RestOrdered": {
				const { agent_id, action } = event.payload;
				const resting = new Set(state.resting);
				if (action === "begin") resting.add(agent_id);
				else resting.delete(agent_id);
				return { ...state, resting };
			}
			case "VitalitySampled":
				return {
					...state,
					samples: new Map(state.samples).set(
						event.payload.agent,
						event.payload,
					),
				};
			case "RunFinished": {
				const { task_id } = event;
				if (task_id === undefined || event.payload.exit_code === 0) {
					return state;
				}
				return {
					...state,
					failedRuns: new Map(state.failedRuns).set(
						task_id,
						(state.failedRuns.get(task_id) ?? 0) + 1,
					),
				};
			}
			case "EvaluationRecorded":
				return {
					...state,
					evaluations: new Map(state.evaluations).set(
						event.payload.eval_id,
						event.payload,
					),
				};
			default:
				return state;
		}
	},
};

/**
 * The Agent's open Tasks (Assigned, InProgress or Blocked) and how many of
 * them are InProgress. An UnderReview Task is not open for its assignee: the
 * work is with the reviewer.
 */
export const openTasks = (
	tasks: TaskView,
	agent: AgentId,
): { open: number; inProgress: number } => {
	let open = 0;
	let inProgress = 0;
	for (const { state } of tasks.tasks.values()) {
		if (
			(state.tag === "Assigned" ||
				state.tag === "InProgress" ||
				state.tag === "Blocked") &&
			state.assignee === agent
		) {
			open += 1;
			if (state.tag === "InProgress") inProgress += 1;
		}
	}
	return { open, inProgress };
};

/**
 * One Agent's work: its Tasks, most recently assigned last, and the Reviews
 * counted toward its Merit, in Ledger order.
 */
export const workOf = (
	work: WorkState,
	agent: AgentId,
): { tasks: TaskId[]; reviews: readonly DatedReview[] } => {
	const { assigned, reviews } = work.agents.get(agent) ?? NO_WORK;
	const tasks = [...assigned.entries()]
		.sort(([, a], [, b]) => a - b)
		.map(([task]) => task);
	return { tasks, reviews };
};

/** The five dimension scores of a Review. */
export const scoresOf = (r: Review): number[] => [
	r.quality,
	r.traceability,
	r.boundary_adherence,
	r.collaboration,
	r.timeliness,
];

export const mean = (xs: readonly number[]): number =>
	xs.reduce((sum, x) => sum + x, 0) / xs.length;
