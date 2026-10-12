import { type AppendGuard, AppendRefused } from "../append-guard.js";
import { fold } from "../reduce.js";
import { runProjection } from "../sandbox/runs.js";
import { LIVE_TAGS, TaskProjection } from "../task/projection.js";

/** An Evaluation scores a finished Run for a Task that is still live. */
const evaluations: AppendGuard = (ctx, event) => {
	if (event.kind !== "EvaluationRecorded") return;
	const { run_id, task_id } = event.payload;
	const refuse = (reason: string) => {
		throw new AppendRefused(`EvaluationRecorded: ${reason}`);
	};

	const run = fold(
		ctx.events,
		runProjection.reduce,
		runProjection.init,
	).runs.get(run_id);
	if (!run) refuse(`${run_id} has not started`);
	else if (!run.finished) refuse(`${run_id} has not finished`);

	const task = fold(
		ctx.events,
		TaskProjection.reduce,
		TaskProjection.init,
	).tasks.get(task_id);
	if (!task) refuse(`${task_id} does not exist`);
	else if (!(LIVE_TAGS as readonly string[]).includes(task.state.tag)) {
		refuse(`${task_id} is ${task.state.tag}, so it takes no Evaluation`);
	}
};

export const stage1Guards: readonly AppendGuard[] = [evaluations];
