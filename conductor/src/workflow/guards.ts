import { type AppendGuard, reasonOf } from "../append-guard.js";
import type { AgentId, RunId, Seq, TaskId } from "../ids.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { LIVE_TAGS } from "../task/projection.js";
import type { Task } from "../types/task.js";
import { STAGES } from "./stages.js";

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

const verification = STAGES.find((stage) =>
	stage.outputs.includes("VerificationRecord"),
);

/**
 * A Task is a Verification when its title names the stage that writes the
 * Verification Record, as the workflow tracer titles a stage's Task:
 * `Stage <n> <name>: <file>`.
 */
const isVerification = (task: Task): boolean =>
	verification !== undefined &&
	task.title.startsWith(`Stage ${verification.number} ${verification.name}: `);

/**
 * A Verifier is never the author of the Result Worksheet (GLOSSARY.md): a
 * Verification Task may not go to an Agent that was ever assigned the Task
 * whose Run wrote a Result Worksheet among its inputs.
 */
export const verifierRefusal = (
	projections: Projections,
	task: Task,
	assignee: AgentId,
): Refusal | undefined => {
	if (!isVerification(task)) return undefined;
	for (const id of task.inputs) {
		for (const { record } of projections.artifacts.productions.get(id) ?? []) {
			if (
				record.artifact_type !== "ResultWorksheet" ||
				record.produced_by.tag !== "Run"
			) {
				continue;
			}
			const author = projections.runs.runs.get(record.produced_by.id)?.task_id;
			if (
				author !== undefined &&
				projections.tasks.assignees.get(author)?.has(assignee)
			) {
				return new Refusal(
					`${assignee} was assigned ${author}, whose Run wrote the Result Worksheet that ${task.id} verifies; a Verifier is never the author of the Result Worksheet`,
				);
			}
		}
	}
	return undefined;
};

const evaluations: AppendGuard = (projections, event) => {
	if (event.kind !== "EvaluationRecorded") return undefined;
	const { eval_id, stage, run_id, task_id } = event.payload;
	if (stage === undefined) return `${eval_id} names no stage`;
	return reasonOf(runFinishedFor(projections, run_id, task_id));
};

/** Whoever takes a Verification Task, by assignment or Hand-off. */
const verifiers: AppendGuard = (projections, event) => {
	const [task_id, agent] =
		event.kind === "TaskAssigned"
			? [event.payload.task_id, event.payload.assignee]
			: event.kind === "TaskHandedOff"
				? [event.payload.task_id, event.payload.to]
				: [];
	const task = task_id && projections.tasks.tasks.get(task_id);
	return task && agent
		? reasonOf(verifierRefusal(projections, task, agent))
		: undefined;
};

export const workflowGuards: readonly AppendGuard[] = [evaluations, verifiers];
