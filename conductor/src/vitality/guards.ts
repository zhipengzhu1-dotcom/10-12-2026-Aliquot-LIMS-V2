import type { AppendGuard } from "../append-guard.js";
import { canonicalJson } from "../hash.js";
import { notInOrg } from "../org/projection.js";
import { assigneeOf } from "../task/projection.js";
import { actorText } from "../types/actor.js";
import { restInEffect } from "./vitality.js";

/**
 * A Review scores a completed Task (UnderReview, or Done when the Auditor
 * adds one), is recorded by the reviewer it names, and never by the assignee.
 */
const reviewRules: AppendGuard = (projections, event) => {
	if (event.kind !== "ReviewRecorded") return undefined;
	const { task_id, reviewer } = event.payload;
	const task = projections.tasks.tasks.get(task_id);
	if (task === undefined) return `${task_id} does not exist`;
	if (task.state.tag !== "UnderReview" && task.state.tag !== "Done") {
		return `${task_id} is ${task.state.tag}; only an UnderReview or Done Task gets a Review`;
	}
	if (canonicalJson(reviewer) !== canonicalJson(event.actor)) {
		return `the reviewer ${actorText(reviewer)} is not the actor ${actorText(event.actor)}`;
	}
	const assignee = assigneeOf(task);
	if (reviewer.tag === "Agent" && reviewer.id === assignee) {
		return `${assignee} is the assignee of ${task_id} and cannot review it`;
	}
	return undefined;
};

/** Rest is ordered for an Agent in the Org, and begins and ends in turn. */
const restRules: AppendGuard = (projections, event) => {
	if (event.kind !== "RestOrdered") return undefined;
	const { agent_id, action } = event.payload;
	if (!projections.org.agents.has(agent_id)) return notInOrg(agent_id);
	const resting = restInEffect(projections.work, agent_id);
	if (action === "begin" && resting) return `${agent_id} is already resting`;
	if (action === "end" && !resting) return `${agent_id} is not resting`;
	return undefined;
};

export const vitalityGuards: readonly AppendGuard[] = [reviewRules, restRules];
