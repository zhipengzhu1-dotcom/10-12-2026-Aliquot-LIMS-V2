import type { TaskId } from "../ids.js";
import type { Review } from "../types/merit.js";
import { mean, scoresOf } from "./work.js";

/** Merit is taken over this many of the Agent's most recently reviewed Tasks. */
export const MERIT_WINDOW_TASKS = 20;

/** An Agent's Merit, its tenure in reviewed Tasks, and the Reviews behind it. */
export type Standing = {
	/** Mean of every dimension score in `window`; undefined before any Review. */
	readonly merit: number | undefined;
	/** Every distinct Task of the Agent that has a counted Review. */
	readonly reviewedTasks: number;
	/** Every Review of the last 20 reviewed Tasks, in Ledger order. */
	readonly window: readonly Review[];
};

/**
 * Standing from an Agent's counted Reviews in Ledger order. A Task enters the
 * window at its first Review; a later Review of the same Task (the Auditor
 * may add one) joins the window without making it longer.
 */
export const standingOf = (reviews: readonly Review[]): Standing => {
	const tasks: TaskId[] = [];
	for (const r of reviews)
		if (!tasks.includes(r.task_id)) tasks.push(r.task_id);
	const recent = new Set(tasks.slice(-MERIT_WINDOW_TASKS));
	const window = reviews.filter((r) => recent.has(r.task_id));
	return {
		merit: window.length === 0 ? undefined : mean(window.flatMap(scoresOf)),
		reviewedTasks: tasks.length,
		window,
	};
};
