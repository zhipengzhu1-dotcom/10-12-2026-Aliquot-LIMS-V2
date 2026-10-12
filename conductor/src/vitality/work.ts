import type { Event } from "../events.js";
import type { AgentId, TaskId } from "../ids.js";
import { fold } from "../reduce.js";
import { TaskProjection } from "../task/projection.js";
import type { Review } from "../types/merit.js";

/**
 * The Agent's open Tasks (Assigned, InProgress or Blocked) and how many of
 * them are InProgress. An UnderReview Task is not open for its assignee: the
 * work is with the reviewer. Every Task-state read in vitality/ goes through
 * here, so a change to how Task state is projected is one edit.
 */
export const openTasks = (
	events: Iterable<Event>,
	agent: AgentId,
): { open: number; inProgress: number } => {
	const { tasks } = fold(events, TaskProjection.reduce, TaskProjection.init);
	let open = 0;
	let inProgress = 0;
	for (const { state } of tasks.values()) {
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

/** The assignment an Event makes: TaskAssigned or TaskHandedOff. */
const assignmentOf = (e: Event): [TaskId, AgentId] | undefined => {
	if (e.kind === "TaskAssigned") return [e.payload.task_id, e.payload.assignee];
	if (e.kind === "TaskHandedOff") return [e.payload.task_id, e.payload.to];
	return undefined;
};

/** The Agent the Task was last assigned or handed off to. */
export const lastAssignee = (
	events: Iterable<Event>,
	task: TaskId,
): AgentId | undefined => {
	let assignee: AgentId | undefined;
	for (const e of events) {
		const assignment = assignmentOf(e);
		if (assignment?.[0] === task) assignee = assignment[1];
	}
	return assignee;
};

/** A Review of a Task, with when it was recorded. */
export type DatedReview = {
	readonly review: Review;
	readonly seq: number;
	readonly ts: string;
};

/**
 * What the Ledger says about one Agent's work: its Tasks, most recently
 * assigned last, and the Reviews of Tasks it was the assignee of when the
 * Review was recorded, in Ledger order. A Task the Trust tier rules skipped
 * for Review stays in `tasks` but its Reviews (an Auditor may still add one)
 * are left out of `reviews`, so they never count toward Merit.
 */
export const workOf = (
	events: Iterable<Event>,
	agent: AgentId,
): { tasks: TaskId[]; reviews: DatedReview[] } => {
	const assignee = new Map<TaskId, AgentId>();
	const assignedAt = new Map<TaskId, number>();
	const skipped = new Set<TaskId>();
	const reviews: DatedReview[] = [];
	for (const e of events) {
		const assignment = assignmentOf(e);
		if (assignment !== undefined) {
			const [task, to] = assignment;
			assignee.set(task, to);
			if (to === agent) assignedAt.set(task, e.seq);
			else assignedAt.delete(task);
			continue;
		}
		switch (e.kind) {
			case "TaskCompleted":
				if (e.payload.review.tag === "Skipped") skipped.add(e.payload.task_id);
				break;
			case "ReviewRecorded": {
				const task = e.payload.task_id;
				if (assignee.get(task) === agent && !skipped.has(task)) {
					reviews.push({ review: e.payload, seq: e.seq, ts: e.ts });
				}
				break;
			}
		}
	}
	const tasks = [...assignedAt.entries()]
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
