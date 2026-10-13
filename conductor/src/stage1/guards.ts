import type { AppendGuard } from "../append-guard.js";
import { LIVE_TAGS } from "../task/projection.js";

/** An Evaluation scores a finished Run for a Task that is still live. */
const evaluations: AppendGuard = (projections, event) => {
	if (event.kind !== "EvaluationRecorded") return undefined;
	const { run_id, task_id } = event.payload;
	const run = projections.runs.runs.get(run_id);
	if (!run) return `${run_id} has not started`;
	if (!run.finished) return `${run_id} has not finished`;
	const task = projections.tasks.tasks.get(task_id);
	if (!task) return `${task_id} does not exist`;
	if (!(LIVE_TAGS as readonly string[]).includes(task.state.tag)) {
		return `${task_id} is ${task.state.tag}, so it takes no Evaluation`;
	}
	return undefined;
};

export const stage1Guards: readonly AppendGuard[] = [evaluations];
