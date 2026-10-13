import { AppendRefused, refusalText } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import {
	EvaluationId,
	nextId,
	type RunId,
	type Seq,
	type TaskId,
} from "../ids.js";
import type { Ledger } from "../ledger.js";
import { Refusal } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { SubmissionEvaluation } from "./evaluate.js";
import { runFinishedFor } from "./guards.js";

export type Evaluation = PayloadOf<"EvaluationRecorded">;

/** The Evaluation as the Event recorded it, and the Event's seq. */
export type Evaluated = { readonly evaluation: Evaluation; readonly seq: Seq };

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
): Evaluated => {
	const { projections } = ledger;
	const finished = runFinishedFor(projections, run_id, task_id);
	if (finished instanceof Refusal) {
		throw new AppendRefused(refusalText("EvaluationRecorded", finished.reason));
	}
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
