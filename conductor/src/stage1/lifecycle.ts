import { orRefuse } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import { EvaluationId, nextId, type RunId, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Recorded } from "../lifecycle-support.js";
import type { Actor } from "../types/actor.js";
import type { SubmissionEvaluation } from "./evaluate.js";
import { runFinishedFor } from "./guards.js";

export type Evaluation = PayloadOf<"EvaluationRecorded">;

/**
 * Record the Evaluation of a finished Run for a live Task under the next
 * free Evaluation id. Its cause is the Run's RunFinished.
 */
export const recordEvaluation = (
	ledger: Ledger,
	{
		actor,
		task_id,
		run_id,
		...scored
	}: SubmissionEvaluation & {
		readonly actor: Actor;
		readonly task_id: TaskId;
		readonly run_id: RunId;
	},
): Recorded<"evaluation", Evaluation> => {
	const { projections } = ledger;
	const finished = orRefuse(
		"EvaluationRecorded",
		runFinishedFor(projections, run_id, task_id),
	);
	const evaluation: Evaluation = {
		eval_id: EvaluationId.parse(
			nextId("E", projections.work.evaluations.keys()),
		),
		run_id,
		task_id,
		...scored,
	};
	const { seq } = ledger.append({
		actor,
		task_id,
		causation_id: finished,
		kind: "EvaluationRecorded",
		payload: evaluation,
	});
	return { evaluation, seq };
};
