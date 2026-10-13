import { type AppendGuard, reasonOf } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import { canonicalJson } from "../hash.js";
import { notInOrg } from "../org/projection.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { actorText, type EventActor } from "../types/actor.js";
import type { Review } from "../types/merit.js";
import { reviewerRefusal } from "./reviewers.js";
import { restInEffect } from "./vitality.js";

/**
 * A Review scores a completed Task (UnderReview, or Done when the Auditor
 * adds one), is recorded by the reviewer it names, and only by a reviewer
 * that the assignee's role allows.
 */
export const reviewRefusal = (
	projections: Projections,
	{ task_id, reviewer }: Review,
	actor: EventActor,
): Refusal | undefined => {
	const task = projections.tasks.tasks.get(task_id);
	if (task === undefined) return new Refusal(`${task_id} does not exist`);
	const { state } = task;
	if (state.tag !== "UnderReview" && state.tag !== "Done") {
		return new Refusal(
			`${task_id} is ${state.tag}; only an UnderReview or Done Task gets a Review`,
		);
	}
	if (canonicalJson(reviewer) !== canonicalJson(actor)) {
		return new Refusal(
			`the reviewer ${actorText(reviewer)} is not the actor ${actorText(actor)}`,
		);
	}
	return reviewerRefusal(projections, task_id, state.assignee, reviewer);
};

const reviewRules: AppendGuard = (projections, event) =>
	event.kind === "ReviewRecorded"
		? reasonOf(reviewRefusal(projections, event.payload, event.actor))
		: undefined;

/** Rest is ordered for an Agent in the Org, and begins and ends in turn. */
export const restRefusal = (
	projections: Projections,
	{ agent_id, action }: PayloadOf<"RestOrdered">,
): Refusal | undefined => {
	if (!projections.org.agents.has(agent_id)) {
		return new Refusal(notInOrg(agent_id));
	}
	const resting = restInEffect(projections.work, agent_id);
	if (action === "begin" && resting) {
		return new Refusal(`${agent_id} is already resting`);
	}
	if (action === "end" && !resting) {
		return new Refusal(`${agent_id} is not resting`);
	}
	return undefined;
};

const restRules: AppendGuard = (projections, event) =>
	event.kind === "RestOrdered"
		? reasonOf(restRefusal(projections, event.payload))
		: undefined;

export const vitalityGuards: readonly AppendGuard[] = [reviewRules, restRules];
