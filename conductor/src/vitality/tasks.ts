import type { Event } from "../events.js";
import type { AgentId } from "../ids.js";
import { fold } from "../reduce.js";
import { TaskProjection } from "../task/projection.js";

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
