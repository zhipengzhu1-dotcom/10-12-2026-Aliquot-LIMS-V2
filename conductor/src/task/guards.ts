import type { AppendGuard } from "../append-guard.js";
import type { Event } from "../events.js";
import { canonicalJson } from "../hash.js";
import type { Projections } from "../projections.js";
import { actorText } from "../types/actor.js";
import type { Task } from "../types/task.js";
import { REVIEW_ONE_IN, reviewSampleOf } from "../vitality/trust.js";

/**
 * Review follows the Trust tier (docs/design/vitality-and-merit.md): a Task
 * skips Review only when the sample for its assignee's tier does not pick
 * it, and a Task completes after Review only once the reviewer it names has
 * recorded a Review, and only by that reviewer.
 */
const reviewRefusal = (
	ledger: Projections,
	task: Task,
	event: Extract<Event, { kind: "TaskCompleted" }>,
): string | undefined => {
	const { state } = task;
	const { review } = event.payload;
	if (review.tag === "Skipped" && state.tag === "InProgress") {
		const { tier, sampled } = reviewSampleOf(
			ledger.trust,
			state.assignee,
			task.id,
		);
		if (!sampled) return undefined;
		const share =
			tier === "Probation"
				? `every Task of ${state.assignee} on Probation is`
				: `1 in ${REVIEW_ONE_IN[tier]} Tasks of ${state.assignee} at ${tier} are`;
		return `${task.id} is sampled for Review, as ${share}; its completion names a reviewer`;
	}
	if (review.tag === "Reviewed" && state.tag === "UnderReview") {
		const reviewer = canonicalJson(state.reviewer);
		const recorded = (ledger.work.reviews.get(task.id) ?? []).some(
			(r) => canonicalJson(r.review.reviewer) === reviewer,
		);
		if (!recorded) {
			return `${task.id} has no Review by ${actorText(state.reviewer)}, its reviewer`;
		}
		if (canonicalJson(event.actor) !== reviewer) {
			return `only ${actorText(state.reviewer)}, the reviewer of ${task.id}, completes it after Review; the actor is ${actorText(event.actor)}`;
		}
	}
	return undefined;
};

/**
 * The Review rules on completion. The Task state machine itself is the Task
 * Projection's, which refuses every Event it cannot express.
 */
const taskRules: AppendGuard = (ledger, event) => {
	if (event.kind !== "TaskCompleted") return undefined;
	const task = ledger.tasks.tasks.get(event.payload.task_id);
	return task === undefined ? undefined : reviewRefusal(ledger, task, event);
};

export const taskGuards: readonly AppendGuard[] = [taskRules];
