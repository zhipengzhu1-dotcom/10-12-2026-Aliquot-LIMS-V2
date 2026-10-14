import { orRefuse } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import { EvaluationId, nextId, type RunId, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Recorded } from "../lifecycle-support.js";
import type { EventActor } from "../types/actor.js";
import { runFinishedFor } from "./guards.js";

export type Evaluation = PayloadOf<"EvaluationRecorded">;

/** What a stage's Evaluation finds: a score from 0 to 1, whether it passed, and one finding per failed check. */
export type Scored = Pick<Evaluation, "score" | "passed" | "findings">;

/**
 * Record the Evaluation of a finished Run for a live Task under the next
 * free Evaluation id, naming the stage it scores. Its cause is the Run's
 * RunFinished.
 */
export const recordEvaluation = (
	ledger: Ledger,
	{
		actor,
		stage,
		task_id,
		run_id,
		...scored
	}: Scored & {
		readonly actor: EventActor;
		readonly stage: number;
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
		stage,
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
