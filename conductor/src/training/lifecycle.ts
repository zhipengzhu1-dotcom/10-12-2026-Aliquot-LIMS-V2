import { orRefuse } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import type { AgentId, SkillId, TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Origin, Recorded } from "../lifecycle-support.js";
import type { MemoryNote, Skill } from "../types/skill.js";
import { coachingRefusal, noteRefusal } from "./guards.js";
import { nextVersion } from "./projection.js";

/** The previous Event of `task_id`, which a Training Event about it names as its cause. */
const taskCause = (ledger: Ledger, task_id: TaskId | undefined) => {
	const cause =
		task_id === undefined
			? undefined
			: ledger.projections.tasks.lastSeq.get(task_id);
	return {
		...(task_id === undefined ? {} : { task_id }),
		...(cause === undefined ? {} : { causation_id: cause }),
	};
};

/**
 * An Agent notes a Memory note on a Task it has been assigned, naming the
 * Task's previous Event, the outcome it learned from, as the cause.
 */
export const recordMemoryNote = (
	ledger: Ledger,
	{ actor, ...note }: Pick<Origin, "actor"> & MemoryNote,
): Recorded<"note", MemoryNote> => {
	orRefuse(
		"MemoryNoted",
		noteRefusal(ledger.projections, actor, note.agent, note.task_id),
	);
	const { seq } = ledger.append({
		actor,
		...taskCause(ledger, note.task_id),
		kind: "MemoryNoted",
		payload: note,
	});
	return { note, seq };
};

/**
 * Publish the next version of the Skill `id`, authored by the actor. A
 * version after the first names the version before it as its cause.
 */
export const publishSkill = (
	ledger: Ledger,
	{
		actor,
		id,
		title,
		body_md,
	}: Pick<Origin, "actor"> & {
		readonly id: SkillId;
		readonly title: string;
		readonly body_md: string;
	},
): Recorded<"skill", Skill> => {
	const { training } = ledger.projections;
	const previous = training.skills.get(id)?.at(-1);
	const skill: Skill = {
		id,
		version: nextVersion(training, id),
		title,
		body_md,
		author: actor,
	};
	const { seq } = ledger.append({
		actor,
		...(previous === undefined ? {} : { causation_id: previous.seq }),
		kind: "SkillPublished",
		payload: skill,
	});
	return { skill, seq };
};

/**
 * The Operator gives an Agent Coaching, on a Task when one is named, whose
 * previous Event is then the cause.
 */
export const giveCoaching = (
	ledger: Ledger,
	{
		actor,
		agent_id,
		task_id,
		note,
	}: Pick<Origin, "actor"> & {
		readonly agent_id: AgentId;
		readonly task_id?: TaskId | undefined;
		readonly note: string;
	},
): Recorded<"coaching", PayloadOf<"HumanCoached">> => {
	orRefuse(
		"HumanCoached",
		coachingRefusal(ledger.projections, actor, agent_id, task_id),
	);
	const coaching = {
		agent_id,
		...(task_id === undefined ? {} : { task_id }),
		note,
	};
	const { seq } = ledger.append({
		actor,
		...taskCause(ledger, task_id),
		kind: "HumanCoached",
		payload: coaching,
	});
	return { coaching, seq };
};
