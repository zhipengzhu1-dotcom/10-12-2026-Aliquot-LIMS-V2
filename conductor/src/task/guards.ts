import { type AppendGuard, reasonOf } from "../append-guard.js";
import type { Event } from "../events.js";
import { canonicalJson } from "../hash.js";
import type { AgentId, TaskId } from "../ids.js";
import { liveAgent } from "../org/projection.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { type Actor, actorText } from "../types/actor.js";
import type { TrustTier } from "../types/merit.js";
import type { Task } from "../types/task.js";
import { reviewerRefusal } from "../vitality/reviewers.js";
import { REVIEW_ONE_IN, reviewSampleOf } from "../vitality/trust.js";
import { reviewsBy } from "../vitality/work.js";
import { stateIn } from "./projection.js";

/**
 * The Conductor assigns a Task only while it is Proposed, so it never
 * overrides an assignment an Agent or the Operator made (ADR-0013).
 */
export const conductorAssignRefusal = (
	projections: Projections,
	task_id: TaskId,
): Refusal | undefined => {
	const state = stateIn(projections.tasks, task_id, ["Proposed"]);
	return state instanceof Refusal
		? new Refusal(`the Conductor assigns only a Proposed Task; ${state.reason}`)
		: undefined;
};

/**
 * The Conductor's assignment is its own act (ADR-0013): of a Proposed Task,
 * naming the Task's previous Event as its cause.
 */
const conductorAssignment = (
	projections: Projections,
	event: Extract<Event, { kind: "TaskAssigned" }>,
): string | undefined => {
	if (event.actor.tag !== "Conductor") return undefined;
	const { task_id } = event.payload;
	const refusal = conductorAssignRefusal(projections, task_id);
	if (refusal !== undefined) return refusal.reason;
	const previous = projections.tasks.lastSeq.get(task_id);
	return event.causation_id === previous
		? undefined
		: `the Conductor's assignment of ${task_id} names its previous Event, seq ${previous}, as its cause, not ${event.causation_id ?? "none"}`;
};

/** Why a Task the sample picks for Review may not complete without a reviewer. */
export const sampledRefusal = (
	task_id: TaskId,
	assignee: AgentId,
	tier: TrustTier,
): string => {
	const share =
		tier === "Probation"
			? `every Task of ${assignee} on Probation is`
			: `1 in ${REVIEW_ONE_IN[tier]} Tasks of ${assignee} at ${tier} are`;
	return `${task_id} is sampled for Review, as ${share}; its completion names a reviewer`;
};

/**
 * Review follows the Trust tier (docs/design/vitality-and-merit.md): a Task
 * skips Review only when the sample for its assignee's tier does not pick
 * it, goes UnderReview only to a reviewer that the assignee's role allows,
 * and completes after Review only once that reviewer has recorded a Review,
 * and only by that reviewer.
 */
const reviewRefusal = (
	projections: Projections,
	task: Task,
	event: Extract<Event, { kind: "TaskCompleted" }>,
): string | undefined => {
	const { state } = task;
	const { review } = event.payload;
	if (review.tag === "Skipped" && state.tag === "InProgress") {
		const { tier, sampled } = reviewSampleOf(
			projections.trust,
			state.assignee,
			task.id,
		);
		return sampled ? sampledRefusal(task.id, state.assignee, tier) : undefined;
	}
	if (review.tag === "Required" && state.tag === "InProgress") {
		return reasonOf(
			reviewerRefusal(projections, task.id, state.assignee, review.reviewer),
		);
	}
	if (review.tag === "Reviewed" && state.tag === "UnderReview") {
		if (reviewsBy(projections.work, task.id, state.reviewer).length === 0) {
			return `${task.id} has no Review by ${actorText(state.reviewer)}, its reviewer`;
		}
		if (canonicalJson(event.actor) !== canonicalJson(state.reviewer)) {
			return `only ${actorText(state.reviewer)}, the reviewer of ${task.id}, completes it after Review; the actor is ${actorText(event.actor)}`;
		}
	}
	return undefined;
};

/** Help is requested of the Operator or of a live Agent. */
export const helpTargetRefusal = (
	projections: Projections,
	to: Actor,
): Refusal | undefined => {
	if (to.tag === "Operator") return undefined;
	const live = liveAgent(projections.org, to.id);
	return live instanceof Refusal ? live : undefined;
};

/**
 * The Conductor's assignments, the Review rules on completion, and whom help
 * is requested of. The Task state machine itself, and who may request help,
 * are the Task Projection's, which refuses every Event it cannot express.
 */
const taskRules: AppendGuard = (projections, event) => {
	switch (event.kind) {
		case "TaskAssigned":
			return conductorAssignment(projections, event);
		case "TaskCompleted": {
			const task = projections.tasks.tasks.get(event.payload.task_id);
			return task === undefined
				? undefined
				: reviewRefusal(projections, task, event);
		}
		case "HelpRequested":
			return reasonOf(helpTargetRefusal(projections, event.payload.to));
		default:
			return undefined;
	}
};

export const taskGuards: readonly AppendGuard[] = [taskRules];
