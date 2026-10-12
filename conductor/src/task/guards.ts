import { type AppendGuard, AppendRefused } from "../append-guard.js";
import type { Event } from "../events.js";
import { canonicalJson } from "../hash.js";
import { fold } from "../reduce.js";
import { actorText } from "../types/actor.js";
import type { Task } from "../types/task.js";
import {
	REVIEW_ONE_IN,
	reviewSampled,
	trustTierOf,
} from "../vitality/trust.js";
import {
	applyTaskEvent,
	TaskProjection,
	TransitionError,
} from "./projection.js";

type Completed = Extract<Event, { kind: "TaskCompleted" }>;

const refuse = (completed: Completed, reason: string): never => {
	throw new AppendRefused(
		`TaskCompleted (review ${completed.payload.review.tag}) refused: ${reason}`,
	);
};

/**
 * Review follows the Trust tier (docs/design/vitality-and-merit.md): a Task
 * skips Review only when the sample for its assignee's tier does not pick
 * it, and a Task completes after Review only once the reviewer it names has
 * recorded a Review, and only by that reviewer.
 */
const checkReview = (
	events: readonly Event[],
	task: Task,
	event: Completed,
) => {
	const { state } = task;
	const { review } = event.payload;
	if (review.tag === "Skipped" && state.tag === "InProgress") {
		const { tier } = trustTierOf(events, state.assignee);
		if (!reviewSampled(task.id, tier)) return;
		refuse(
			event,
			tier === "Probation"
				? `${state.assignee} is on Probation; every Task is reviewed`
				: `${state.assignee} is ${tier}, and ${task.id} is one of the 1 in ${REVIEW_ONE_IN[tier]} Tasks sampled for Review`,
		);
	}
	if (review.tag === "Reviewed" && state.tag === "UnderReview") {
		const reviewer = canonicalJson(state.reviewer);
		const recorded = events.some(
			(e) =>
				e.kind === "ReviewRecorded" &&
				e.payload.task_id === task.id &&
				canonicalJson(e.payload.reviewer) === reviewer,
		);
		if (!recorded) {
			refuse(
				event,
				`${task.id} has no Review by ${actorText(state.reviewer)}, its reviewer`,
			);
		}
		if (canonicalJson(event.actor) !== reviewer) {
			refuse(
				event,
				`only ${actorText(state.reviewer)}, the reviewer of ${task.id}, completes it after Review; the actor is ${actorText(event.actor)}`,
			);
		}
	}
};

/**
 * Refuse any Event the Task state machine cannot express, then any
 * completion the Review rules forbid.
 */
const taskRules: AppendGuard = (ctx, event) => {
	const view = fold(ctx.events, TaskProjection.reduce, TaskProjection.init);
	const next = applyTaskEvent(view, event);
	if (next instanceof TransitionError) throw new AppendRefused(next.message);
	if (event.kind !== "TaskCompleted") return;
	const task = view.tasks.get(event.payload.task_id);
	if (task !== undefined) checkReview(ctx.events, task, event);
};

export const taskGuards: readonly AppendGuard[] = [taskRules];
