import { type AppendGuard, reasonOf } from "../append-guard.js";
import { canonicalJson } from "../hash.js";
import type { AgentId, TaskId } from "../ids.js";
import { notInOrg } from "../org/projection.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { actorText, type EventActor } from "../types/actor.js";

const missingTask = (projections: Projections, task_id: TaskId) =>
	projections.tasks.tasks.has(task_id)
		? undefined
		: new Refusal(`${task_id} does not exist`);

/**
 * A Memory note is its Agent's own, and on a Task the Agent has been
 * assigned: why `actor` may not note one for `agent` on `task_id`.
 */
export const noteRefusal = (
	projections: Projections,
	actor: EventActor,
	agent: AgentId,
	task_id: TaskId,
): Refusal | undefined => {
	if (actor.tag !== "Agent" || actor.id !== agent) {
		return new Refusal(
			`a Memory note is ${agent}'s own; ${actorText(actor)} tried to note one for it`,
		);
	}
	return (
		missingTask(projections, task_id) ??
		(projections.tasks.assignees.get(task_id)?.has(agent)
			? undefined
			: new Refusal(`${agent} was never assigned ${task_id}`))
	);
};

/**
 * Coaching is the Operator's, given to an Agent in the Org on a Task that
 * exists: why `actor` may not give `agent_id` this Coaching.
 */
export const coachingRefusal = (
	projections: Projections,
	actor: EventActor,
	agent_id: AgentId,
	task_id: TaskId | undefined,
): Refusal | undefined => {
	if (actor.tag !== "Operator") {
		return new Refusal(
			`only the Operator gives Coaching; ${actorText(actor)} tried to give it to ${agent_id}`,
		);
	}
	if (!projections.org.agents.has(agent_id)) {
		return new Refusal(notInOrg(agent_id));
	}
	return task_id === undefined ? undefined : missingTask(projections, task_id);
};

/**
 * Training rules at append. A Skill's author is the actor that publishes it,
 * and each version after the first names the one before as its cause. That
 * versions run without a gap is the Training Projection's to say.
 */
const trainingRules: AppendGuard = (projections, event) => {
	switch (event.kind) {
		case "MemoryNoted": {
			const { agent, task_id } = event.payload;
			return reasonOf(noteRefusal(projections, event.actor, agent, task_id));
		}
		case "HumanCoached": {
			const { agent_id, task_id } = event.payload;
			return reasonOf(
				coachingRefusal(projections, event.actor, agent_id, task_id),
			);
		}
		case "SkillPublished": {
			const { id, version, author } = event.payload;
			if (canonicalJson(author) !== canonicalJson(event.actor)) {
				return `${id} version ${version} names ${actorText(author)} as its author, but the actor is ${actorText(event.actor)}`;
			}
			const previous = projections.training.skills.get(id)?.at(-1);
			if (previous === undefined || event.causation_id === previous.seq) {
				return undefined;
			}
			return `${id} version ${version} names version ${previous.version}, seq ${previous.seq}, as its cause, not ${event.causation_id ?? "none"}`;
		}
		default:
			return undefined;
	}
};

export const trainingGuards: readonly AppendGuard[] = [trainingRules];
