import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, EvaluationId, RunId, ScriptId, TaskId } from "../ids.js";
import { openMemoryLedger } from "../ledger.js";
import { memoryStorage } from "../storage.js";
import { fail } from "../task/lifecycle.js";
import { forge } from "../test-support/forge.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import { recordEvaluation } from "./lifecycle.js";

const operator: Actor = { tag: "Operator" };
const rin = AgentId.parse("A-rin");
const passed = { score: 1, passed: true, findings: [] };

let s: Scenario;
let task_id: TaskId;
beforeEach(() => {
	s = scenario();
	task_id = s.task(rin);
});
afterEach(() => s.close());

const finishedSeq = (run_id: string) =>
	s.ledger.projections.runs.runs.get(RunId.parse(run_id))?.finished?.seq;

const evaluate = (run_id: string, task = task_id) =>
	recordEvaluation(s.ledger, {
		actor: operator,
		stage: 1,
		task_id: task,
		run_id: RunId.parse(run_id),
		...passed,
	});

describe("the workflow lifecycle", () => {
	it("records each Evaluation under the next free id with its stage, naming the RunFinished of the Run it scores as its cause, and returns the Evaluation and the seq it appended", () => {
		s.run(task_id, 0);
		s.run(task_id, 0);

		const first = evaluate("R-1");
		const second = evaluate("R-2");

		expect(first.evaluation).toEqual({
			eval_id: "E-1",
			stage: 1,
			run_id: "R-1",
			task_id,
			...passed,
		});
		expect(second.evaluation.eval_id).toBe("E-2");
		const [one, two] = s.events().slice(-2);
		expect(one).toMatchObject({
			seq: first.seq,
			kind: "EvaluationRecorded",
			actor: operator,
			task_id,
			causation_id: finishedSeq("R-1"),
		});
		expect(two).toMatchObject({
			seq: second.seq,
			causation_id: finishedSeq("R-2"),
		});
	});

	const stageless = (task: TaskId) =>
		({
			actor: operator,
			task_id: task,
			kind: "EvaluationRecorded",
			payload: {
				eval_id: EvaluationId.parse("E-1"),
				run_id: RunId.parse("R-1"),
				task_id: task,
				...passed,
			},
		}) as const;

	it("refuses a new Evaluation that names no stage", () => {
		s.run(task_id, 0);

		expect(() => s.appendNonTask(stageless(task_id))).toThrow(
			new AppendRefused("EvaluationRecorded refused: E-1 names no stage"),
		);
	});

	it("still opens a Ledger holding an Evaluation recorded before Evaluations named their stage", () => {
		const storage = memoryStorage();
		const old = scenario(undefined, { storage });
		const task = old.task(rin);
		old.run(task, 0);
		forge(storage, [stageless(task)]);

		const reopened = openMemoryLedger({ storage });
		try {
			expect(
				reopened.projections.work.evaluations.has(EvaluationId.parse("E-1")),
			).toBe(true);
		} finally {
			reopened.close();
		}
	});

	it("refuses an Evaluation of a Run that never started, appending nothing", () => {
		const before = s.events().length;

		expect(() => evaluate("R-9")).toThrow(
			new AppendRefused("EvaluationRecorded refused: R-9 has not started"),
		);
		expect(s.events()).toHaveLength(before);
	});

	it("refuses an Evaluation of a Run that has not finished", () => {
		s.appendNonTask({
			actor: operator,
			task_id,
			kind: "RunStarted",
			payload: {
				run_id: RunId.parse("R-1"),
				script: { id: ScriptId.parse("S-copy"), version: 1 },
				inputs: [],
			},
		});

		expect(() => evaluate("R-1")).toThrow(
			new AppendRefused("EvaluationRecorded refused: R-1 has not finished"),
		);
	});

	it("refuses an Evaluation against a Task that does not exist", () => {
		s.run(task_id, 0);

		expect(() => evaluate("R-1", TaskId.parse("T-7"))).toThrow(
			new AppendRefused("EvaluationRecorded refused: T-7 does not exist"),
		);
	});

	it("refuses an Evaluation against a Task that has already failed", () => {
		s.run(task_id, 0);
		fail(s.ledger, { actor: operator, task_id, reason: "abandoned" });

		expect(() => evaluate("R-1")).toThrow(
			new AppendRefused(
				"EvaluationRecorded refused: T-1 is Failed, so it takes no Evaluation",
			),
		);
	});
});
