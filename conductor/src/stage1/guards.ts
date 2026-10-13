import { type AppendGuard, reasonOf } from "../append-guard.js";
import type { RunId, Seq, TaskId } from "../ids.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { LIVE_TAGS } from "../task/projection.js";

/**
 * An Evaluation scores a finished Run for a Task that is still live: the
 * seq of the Run's RunFinished, or why the Evaluation is refused.
 */
export const runFinishedFor = (
	projections: Projections,
	run_id: RunId,
	task_id: TaskId,
): Seq | Refusal => {
	const run = projections.runs.runs.get(run_id);
	if (!run) return new Refusal(`${run_id} has not started`);
	if (!run.finished) return new Refusal(`${run_id} has not finished`);
	const task = projections.tasks.tasks.get(task_id);
	if (!task) return new Refusal(`${task_id} does not exist`);
	if (!(LIVE_TAGS as readonly string[]).includes(task.state.tag)) {
		return new Refusal(
			`${task_id} is ${task.state.tag}, so it takes no Evaluation`,
		);
	}
	return run.finished.seq;
};

const evaluations: AppendGuard = (projections, event) => {
	if (event.kind !== "EvaluationRecorded") return undefined;
	const { run_id, task_id } = event.payload;
	return reasonOf(runFinishedFor(projections, run_id, task_id));
};

export const stage1Guards: readonly AppendGuard[] = [evaluations];
