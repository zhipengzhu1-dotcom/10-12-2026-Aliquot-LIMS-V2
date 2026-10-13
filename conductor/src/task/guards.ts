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
import { currentMood } from "../vitality/mood.js";
import { policyOf } from "../vitality/policy.js";
import { reviewerRefusal } from "../vitality/reviewers.js";
import { REVIEW_ONE_IN, reviewSampleOf } from "../vitality/trust.js";
import { reviewsBy } from "../vitality/work.js";

/**
 * An Agent takes a Task, by assignment or Hand-off, only while the Policy of
 * its current Mood lets it accept one: never when it is `strained` or worse
 * (docs/design/vitality-and-merit.md, "Allocation favors trusted, unloaded
 * Agents").
 */
export const assigneeRefusal = (
	projections: Projections,
	agent: AgentId,
): Refusal | undefined => {
	const mood = currentMood(projections, agent);
	return policyOf(mood).mayAcceptTasks
		? undefined
		: new Refusal(`${agent} is ${mood} and may not accept a Task`);
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
 * The Review rules on completion, the Mood rule on whoever takes a Task, and
 * whom help is requested of. The Task state machine itself, and who may
 * request help, are the Task Projection's, which refuses every Event it
 * cannot express.
 */
const taskRules: AppendGuard = (projections, event) => {
	switch (event.kind) {
		case "TaskAssigned":
			return reasonOf(assigneeRefusal(projections, event.payload.assignee));
		case "TaskHandedOff":
			return reasonOf(assigneeRefusal(projections, event.payload.to));
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
