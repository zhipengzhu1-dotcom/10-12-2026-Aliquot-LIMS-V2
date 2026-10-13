import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";

const operator = { tag: "Operator" } as const;
const digest = (c: string) => c.repeat(64);
const form = digest("a");
const log = digest("c");

let ledger: Ledger;

beforeEach(() => {
	ledger = openMemoryLedger();
});

afterEach(() => ledger.close());

const append = (body: Omit<NewEvent, "actor">) =>
	ledger.append({ actor: operator, ...body } as NewEvent);

const stored = (id: string, produced_by: object = operator) =>
	append({
		kind: "ArtifactStored",
		payload: {
			id,
			sha256: id,
			media_type: "text/plain",
			artifact_type: "Other",
			produced_by,
			lineage: produced_by === operator ? [] : [form],
		},
	} as never);

/** A registered Script, a stored Fixture, and R-1 started. */
const startRun = () => {
	append({
		kind: "ScriptRegistered",
		payload: {
			id: "S-parse_submission",
			version: 1,
			name: "parse_submission",
			owner_agent: "A-rin",
			input_types: ["SubmissionForm"],
			output_types: ["Other"],
			entrypoint: "main.py",
			fixtures: [],
			image_digest: digest("d"),
		},
	} as never);
	stored(form);
	append({
		kind: "RunStarted",
		payload: {
			run_id: "R-1",
			script: { id: "S-parse_submission", version: 1 },
			inputs: [form],
		},
	} as never);
};

const finishRun = () => {
	stored(log, { tag: "Run", id: "R-1" });
	append({
		kind: "RunFinished",
		payload: {
			id: "R-1",
			script: { id: "S-parse_submission", version: 1 },
			inputs: [form],
			outputs: [],
			exit_code: 0,
			stdout_ref: log,
			stderr_ref: log,
			duration_ms: 5,
		},
	} as never);
};

const propose = (task_id: string) =>
	append({
		task_id,
		kind: "TaskProposed",
		payload: {
			task_id,
			title: "Parse Submission Form",
			goal: "Extract the submission record",
			inputs: [form],
			rubric_id: "default",
			priority: 1,
			tat_class: "Regular",
		},
	} as never);

const evaluation = (run_id = "R-1", task_id = "T-1") => ({
	task_id,
	kind: "EvaluationRecorded",
	payload: {
		eval_id: "E-1",
		run_id,
		task_id,
		score: 1,
		passed: true,
		findings: [],
	},
});

describe("stage 1 guards on EvaluationRecorded", () => {
	it("accepts an Evaluation of a finished Run against a live Task", () => {
		startRun();
		finishRun();
		propose("T-1");

		expect(append(evaluation() as never).kind).toBe("EvaluationRecorded");
	});

	it("refuses an Evaluation of a Run that never started", () => {
		propose("T-1");

		expect(() => append(evaluation("R-9") as never)).toThrow(
			new AppendRefused("EvaluationRecorded refused: R-9 has not started"),
		);
	});

	it("refuses an Evaluation of a Run that has not finished", () => {
		startRun();
		propose("T-1");

		expect(() => append(evaluation() as never)).toThrow(
			new AppendRefused("EvaluationRecorded refused: R-1 has not finished"),
		);
	});

	it("refuses an Evaluation against a Task that does not exist", () => {
		startRun();
		finishRun();

		expect(() => append(evaluation("R-1", "T-7") as never)).toThrow(
			new AppendRefused("EvaluationRecorded refused: T-7 does not exist"),
		);
	});

	it("refuses an Evaluation against a Task that has already failed", () => {
		startRun();
		finishRun();
		propose("T-1");
		append({
			task_id: "T-1",
			kind: "TaskFailed",
			payload: { task_id: "T-1", reason: "abandoned" },
		} as never);

		expect(() => append(evaluation() as never)).toThrow(
			new AppendRefused(
				"EvaluationRecorded refused: T-1 is Failed, so it takes no Evaluation",
			),
		);
	});
});
