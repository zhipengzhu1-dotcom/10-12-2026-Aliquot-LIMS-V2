import { type AppendGuard, AppendRefused } from "../append-guard.js";
import { canonicalJson } from "../hash.js";
import { orgState } from "../org/projection.js";
import { fold } from "../reduce.js";
import { TaskProjection } from "../task/projection.js";
import { actorText } from "../types/actor.js";
import { restInEffect } from "./vitality.js";
import { lastAssignee } from "./work.js";

const refuse = (kind: string, reason: string): never => {
	throw new AppendRefused(`${kind} refused: ${reason}`);
};

/**
 * A Review scores a completed Task (UnderReview, or Done when the Auditor
 * adds one), is recorded by the reviewer it names, and never by the assignee.
 */
const reviewRules: AppendGuard = (ctx, event) => {
	if (event.kind !== "ReviewRecorded") return;
	const { task_id, reviewer } = event.payload;
	const kind = event.kind;
	const { tasks } = fold(
		ctx.events,
		TaskProjection.reduce,
		TaskProjection.init,
	);
	const task = tasks.get(task_id);
	if (task === undefined) return refuse(kind, `${task_id} does not exist`);
	if (task.state.tag !== "UnderReview" && task.state.tag !== "Done") {
		refuse(
			kind,
			`${task_id} is ${task.state.tag}; only an UnderReview or Done Task gets a Review`,
		);
	}
	if (canonicalJson(reviewer) !== canonicalJson(event.actor)) {
		refuse(
			kind,
			`the reviewer ${actorText(reviewer)} is not the actor ${actorText(event.actor)}`,
		);
	}
	const assignee = lastAssignee(ctx.events, task_id);
	if (reviewer.tag === "Agent" && reviewer.id === assignee) {
		refuse(
			kind,
			`${assignee} is the assignee of ${task_id} and cannot review it`,
		);
	}
};

/** Rest is ordered for an Agent in the Org, and begins and ends in turn. */
const restRules: AppendGuard = (ctx, event) => {
	if (event.kind !== "RestOrdered") return;
	const { agent_id, action } = event.payload;
	if (!orgState(ctx.events).agents.has(agent_id)) {
		refuse(event.kind, `${agent_id} is not in the Org`);
	}
	const resting = restInEffect(ctx.events, agent_id);
	if (action === "begin" && resting) {
		refuse(event.kind, `${agent_id} is already resting`);
	}
	if (action === "end" && !resting) {
		refuse(event.kind, `${agent_id} is not resting`);
	}
};

export const vitalityGuards: readonly AppendGuard[] = [reviewRules, restRules];
