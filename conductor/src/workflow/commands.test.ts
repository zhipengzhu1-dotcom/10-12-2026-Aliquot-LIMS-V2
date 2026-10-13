import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../hash.js";
import { ArtifactId, TaskId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";

const suite = dockerAvailable
	? "aliquot workflow (Docker)"
	: "aliquot workflow: SKIPPED because `docker info` failed; start Docker to run these";

const fixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const fixtureId = ArtifactId.parse(sha256Hex(readFileSync(fixture)));
const weighings = fixture.replace(/\.docx$/, ".weighings.json");
const secondFixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed2.docx", import.meta.url),
);
const secondFixtureId = ArtifactId.parse(
	sha256Hex(readFileSync(secondFixture)),
);

let home: string;
let scratch: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-workflow-"));
	scratch = mkdtempSync(join(tmpdir(), "aliquot-workflow-scratch-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, ALIQUOT_HOME: "" },
		},
	);

const readLedger = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return {
			events: ledger.all(),
			verify: ledger.verify(),
			taskState: (id: string) =>
				ledger.projections.tasks.tasks.get(TaskId.parse(id))?.state,
		};
	} finally {
		ledger.close();
	}
};

describe("aliquot workflow", () => {
	it("stages prints each row with its Script, input, carried and output types, and who works and reviews it", () => {
		const result = aliquot("workflow", "stages");

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(
			[
				"1 Submission  script parse_submission  inputs SubmissionForm  carried none  outputs SubmissionRecord  worked by A-rin  reviewed by A-pia",
				"2 Receipt  script log_receipt  inputs SubmissionRecord  carried LimsDatabase  outputs ReceivingLogRow,LimsDatabase  worked by A-bram  reviewed by A-pia",
				"3 Work Order  script create_work_order  inputs ReceivingLogRow  carried LimsDatabase  outputs WorkOrder,LimsDatabase  worked by A-bram  reviewed by A-pia",
				"4 Results  script compute_results  inputs WorkOrder,Other  carried LimsDatabase  outputs ResultWorksheet,LimsDatabase  worked by A-rin  reviewed by A-anselm",
				"",
			].join("\n"),
		);
	});

	it("run refuses a --to beyond the table as a usage error", () => {
		const result = aliquot("workflow", "run", fixture, "--to", "5");

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--to 5 is not a stage number from 1 to 4");
	});

	it("has no stage1 command left", () => {
		const help = aliquot("--help");

		expect(help.stdout).toContain("workflow run-all <fixtures dir>");
		expect(help.stdout).not.toContain("stage1");
		expect(aliquot("stage1", "run", fixture).status).toBe(2);
	});
});

describe.skipIf(!requireDocker())(suite, () => {
	it("run runs stages 1 to 4 on the Fixture, prints each Task, Run, output and Evaluation, exits 0 with every Task Done, and writes the README's Event chain, seq 1 to 68", () => {
		const result = aliquot("workflow", "run", fixture);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			new RegExp(
				[
					"^submission-form-seed1\\.docx",
					`  fixture   ${fixtureId} \\(SubmissionForm\\)`,
					"  stage 1 Submission: T-1 Done",
					"    run       R-1 S-parse_submission v1, exit 0",
					"    output    [0-9a-f]{64} SubmissionRecord submission\\.json",
					"    eval      E-1 score 1\\.000, passed",
					"  stage 2 Receipt: T-2 Done",
					"    run       R-2 S-log_receipt v1, exit 0",
					"    output    [0-9a-f]{64} LimsDatabase lims\\.sqlite",
					"    output    [0-9a-f]{64} Other receipt\\.json",
					"    output    [0-9a-f]{64} ReceivingLogRow receiving_log_row\\.xlsx",
					"    eval      E-2 score 1\\.000, passed",
					"  stage 3 Work Order: T-3 Done",
					"    run       R-3 S-create_work_order v1, exit 0",
					"    output    [0-9a-f]{64} LimsDatabase lims\\.sqlite",
					"    output    [0-9a-f]{64} Other work_order\\.json",
					"    output    [0-9a-f]{64} WorkOrder work_order\\.xlsx",
					"    eval      E-3 score 1\\.000, passed",
					"  stage 4 Results: T-4 Done",
					"    run       R-4 S-compute_results v1, exit 0",
					"    output    [0-9a-f]{64} LimsDatabase lims\\.sqlite",
					"    output    [0-9a-f]{64} Other result_worksheet\\.json",
					"    output    [0-9a-f]{64} ResultWorksheet result_worksheet\\.xlsx",
					"    eval      E-4 score 1\\.000, passed\n$",
				].join("\n"),
			),
		);
		const { events, verify, taskState } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState("T-1")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-2")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-3")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-4")).toEqual({ tag: "Done", assignee: "A-rin" });
		const rin = { tag: "Agent", id: "A-rin" };
		const bram = { tag: "Agent", id: "A-bram" };
		const pia = { tag: "Agent", id: "A-pia" };
		const anselm = { tag: "Agent", id: "A-anselm" };
		const unlinked = (seq: number, kind: string) => ({
			seq,
			kind,
			task: undefined,
			causation: undefined,
		});
		expect(
			events.map((e) => ({
				seq: Number(e.seq),
				kind: e.kind,
				task: e.task_id,
				causation:
					e.causation_id === undefined ? undefined : Number(e.causation_id),
			})),
			"the chain in README.md, Workflow tracer",
		).toEqual([
			...[1, 2, 3, 4, 5, 6, 7, 8].map((seq) => unlinked(seq, "AgentRecruited")),
			...[9, 10, 11, 12].map((seq) => unlinked(seq, "ScriptRegistered")),
			unlinked(13, "ArtifactStored"),
			{ seq: 14, kind: "TaskProposed", task: "T-1", causation: 13 },
			{ seq: 15, kind: "TaskAssigned", task: "T-1", causation: 14 },
			{ seq: 16, kind: "TaskStarted", task: "T-1", causation: 15 },
			{ seq: 17, kind: "RunStarted", task: "T-1", causation: 16 },
			{ seq: 18, kind: "ArtifactStored", task: "T-1", causation: 17 },
			{ seq: 19, kind: "ArtifactStored", task: "T-1", causation: 17 },
			{ seq: 20, kind: "ArtifactStored", task: "T-1", causation: 17 },
			{ seq: 21, kind: "RunFinished", task: "T-1", causation: 17 },
			{ seq: 22, kind: "EvaluationRecorded", task: "T-1", causation: 21 },
			{ seq: 23, kind: "TaskCompleted", task: "T-1", causation: 22 },
			{ seq: 24, kind: "ReviewRecorded", task: "T-1", causation: 23 },
			{ seq: 25, kind: "TaskCompleted", task: "T-1", causation: 24 },
			{ seq: 26, kind: "TaskProposed", task: "T-2", causation: 25 },
			{ seq: 27, kind: "TaskAssigned", task: "T-2", causation: 26 },
			{ seq: 28, kind: "TaskStarted", task: "T-2", causation: 27 },
			{ seq: 29, kind: "RunStarted", task: "T-2", causation: 28 },
			...[30, 31, 32, 33, 34].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-2",
				causation: 29,
			})),
			{ seq: 35, kind: "RunFinished", task: "T-2", causation: 29 },
			{ seq: 36, kind: "EvaluationRecorded", task: "T-2", causation: 35 },
			{ seq: 37, kind: "TaskCompleted", task: "T-2", causation: 36 },
			{ seq: 38, kind: "ReviewRecorded", task: "T-2", causation: 37 },
			{ seq: 39, kind: "TaskCompleted", task: "T-2", causation: 38 },
			{ seq: 40, kind: "TaskProposed", task: "T-3", causation: 39 },
			{ seq: 41, kind: "TaskAssigned", task: "T-3", causation: 40 },
			{ seq: 42, kind: "TaskStarted", task: "T-3", causation: 41 },
			{ seq: 43, kind: "RunStarted", task: "T-3", causation: 42 },
			...[44, 45, 46, 47, 48].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-3",
				causation: 43,
			})),
			{ seq: 49, kind: "RunFinished", task: "T-3", causation: 43 },
			{ seq: 50, kind: "EvaluationRecorded", task: "T-3", causation: 49 },
			{ seq: 51, kind: "TaskCompleted", task: "T-3", causation: 50 },
			{ seq: 52, kind: "ReviewRecorded", task: "T-3", causation: 51 },
			{ seq: 53, kind: "TaskCompleted", task: "T-3", causation: 52 },
			unlinked(54, "ArtifactStored"),
			{ seq: 55, kind: "TaskProposed", task: "T-4", causation: 53 },
			{ seq: 56, kind: "TaskAssigned", task: "T-4", causation: 55 },
			{ seq: 57, kind: "TaskStarted", task: "T-4", causation: 56 },
			{ seq: 58, kind: "RunStarted", task: "T-4", causation: 57 },
			...[59, 60, 61, 62, 63].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-4",
				causation: 58,
			})),
			{ seq: 64, kind: "RunFinished", task: "T-4", causation: 58 },
			{ seq: 65, kind: "EvaluationRecorded", task: "T-4", causation: 64 },
			{ seq: 66, kind: "TaskCompleted", task: "T-4", causation: 65 },
			{ seq: 67, kind: "ReviewRecorded", task: "T-4", causation: 66 },
			{ seq: 68, kind: "TaskCompleted", task: "T-4", causation: 67 },
		]);
		const at = (seq: number) => events[seq - 1];
		expect(at(9)?.payload).toMatchObject({
			id: "S-parse_submission",
			owner_agent: "A-rin",
		});
		expect(at(10)?.payload).toMatchObject({
			id: "S-log_receipt",
			owner_agent: "A-bram",
			input_types: ["SubmissionRecord", "LimsDatabase"],
			output_types: ["ReceivingLogRow", "LimsDatabase"],
		});
		expect(at(11)?.payload).toMatchObject({
			id: "S-create_work_order",
			owner_agent: "A-bram",
			input_types: ["ReceivingLogRow", "LimsDatabase"],
			output_types: ["WorkOrder", "LimsDatabase"],
		});
		expect(at(12)?.payload).toMatchObject({
			id: "S-compute_results",
			owner_agent: "A-rin",
			input_types: ["WorkOrder", "Other", "LimsDatabase"],
			output_types: ["ResultWorksheet", "LimsDatabase"],
		});
		expect(at(13)?.payload).toMatchObject({ id: fixtureId, lineage: [] });
		expect(
			[18, 19, 20].map((seq) => at(seq)?.payload),
			"submission.json, stdout and stderr, each with a Lineage of the Fixture",
		).toMatchObject([
			{
				filename: "submission.json",
				artifact_type: "SubmissionRecord",
				lineage: [fixtureId],
			},
			{ filename: "stdout.txt", lineage: [fixtureId] },
			{ filename: "stderr.txt", lineage: [fixtureId] },
		]);
		expect(at(22)?.payload).toMatchObject({
			stage: 1,
			score: 1,
			passed: true,
		});
		expect(at(23)).toMatchObject({
			actor: rin,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(24)).toMatchObject({ actor: pia });
		expect(at(25)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		/** Each output of `type` the run printed, in stage order. */
		const outputsOf = (type: string) =>
			[
				...result.stdout.matchAll(
					new RegExp(`output {4}([0-9a-f]{64}) ${type}`, "g"),
				),
			].map(([, id]) => id);
		const [recordId] = outputsOf("SubmissionRecord");
		expect(at(18)?.payload).toMatchObject({ id: recordId });
		expect(
			at(26)?.payload,
			"stage 2 takes the record, and no database is there to carry",
		).toMatchObject({ inputs: [recordId] });
		expect(
			[30, 31, 32, 33, 34].map((seq) => at(seq)?.payload),
			"each with a Lineage of the record",
		).toMatchObject([
			{
				filename: "lims.sqlite",
				artifact_type: "LimsDatabase",
				media_type: "application/vnd.sqlite3",
				lineage: [recordId],
			},
			{ filename: "receipt.json", artifact_type: "Other" },
			{
				filename: "receiving_log_row.xlsx",
				artifact_type: "ReceivingLogRow",
				lineage: [recordId],
			},
			{ filename: "stdout.txt" },
			{ filename: "stderr.txt" },
		]);
		expect(at(36)?.payload).toMatchObject({
			stage: 2,
			score: 1,
			passed: true,
		});
		expect(at(37)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(38)).toMatchObject({ actor: pia });
		expect(at(39)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		const [rowId] = outputsOf("ReceivingLogRow");
		const [version1, version2, version3] = outputsOf("LimsDatabase");
		expect(
			at(40)?.payload,
			"stage 3 takes the Receiving Log row and carries stage 2's database",
		).toMatchObject({ inputs: [rowId, version1] });
		expect(
			[44, 45, 46, 47, 48].map((seq) => at(seq)?.payload),
			"each with a Lineage of the Receiving Log row and stage 2's database",
		).toMatchObject([
			{
				filename: "lims.sqlite",
				artifact_type: "LimsDatabase",
				lineage: [rowId, version1],
			},
			{ filename: "work_order.json", artifact_type: "Other" },
			{
				filename: "work_order.xlsx",
				artifact_type: "WorkOrder",
				lineage: [rowId, version1],
			},
			{ filename: "stdout.txt" },
			{ filename: "stderr.txt" },
		]);
		expect(at(50)?.payload).toMatchObject({
			stage: 3,
			score: 1,
			passed: true,
		});
		expect(at(51)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(52)).toMatchObject({ actor: pia });
		expect(at(53)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		const [workOrderId] = outputsOf("WorkOrder");
		const weighingsId = ArtifactId.parse(sha256Hex(readFileSync(weighings)));
		expect(
			at(54),
			"the weighings beside the Fixture, stored by the Operator",
		).toMatchObject({
			actor: { tag: "Operator" },
			payload: {
				id: weighingsId,
				artifact_type: "Other",
				media_type: "application/json",
				produced_by: { tag: "Operator" },
				lineage: [],
				filename: "submission-form-seed1.weighings.json",
			},
		});
		expect(
			at(55)?.payload,
			"stage 4 takes the Work Order and the weighings, and carries stage 3's database",
		).toMatchObject({ inputs: [workOrderId, weighingsId, version2] });
		const lineage4 = [workOrderId, weighingsId, version2];
		expect(
			[59, 60, 61, 62, 63].map((seq) => at(seq)?.payload),
			"each with a Lineage of the Work Order, the weighings and stage 3's database",
		).toMatchObject([
			{
				id: version3,
				filename: "lims.sqlite",
				artifact_type: "LimsDatabase",
				lineage: lineage4,
			},
			{ filename: "result_worksheet.json", artifact_type: "Other" },
			{
				filename: "result_worksheet.xlsx",
				artifact_type: "ResultWorksheet",
				lineage: lineage4,
			},
			{ filename: "stdout.txt" },
			{ filename: "stderr.txt" },
		]);
		expect(at(65)?.payload).toMatchObject({
			stage: 4,
			score: 1,
			passed: true,
		});
		expect(at(66)).toMatchObject({
			actor: rin,
			payload: { review: { tag: "Required", reviewer: anselm } },
		});
		expect(at(67)).toMatchObject({ actor: anselm });
		expect(at(68)).toMatchObject({
			actor: anselm,
			payload: { review: { tag: "Reviewed" } },
		});
	}, 600_000);

	it("sandbox lineage prints the stage 1 record, then the Fixture, with the Run and Script version between them", () => {
		const run = aliquot("workflow", "run", fixture);
		expect(run.status, run.stderr).toBe(0);
		const record = /output {4}([0-9a-f]{64}) SubmissionRecord/.exec(
			run.stdout,
		)?.[1];
		if (!record) throw new Error(`no record in ${run.stdout}`);

		const result = aliquot("sandbox", "lineage", record);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(
			[
				`${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`  ${fixtureId} SubmissionForm <- none`,
				"",
			].join("\n"),
		);
	}, 600_000);

	it("sandbox lineage prints a toy LIMS database version's record and Fixture, the Work Order's and the Result Worksheet's inputs back to the Fixture and the weighings, and after a run on another Fixture, the version stage 4 wrote", () => {
		/** Each output of `type` the run printed, in stage order. */
		const outputsOf = (stdout: string, type: string) => {
			const ids = [
				...stdout.matchAll(new RegExp(`output {4}([0-9a-f]{64}) ${type}`, "g")),
			].map(([, id]) => id);
			if (ids.length === 0) throw new Error(`no ${type} in ${stdout}`);
			return ids;
		};
		const lineageOf = (id: string | undefined) => {
			const result = aliquot("sandbox", "lineage", id ?? "");
			expect(result.status, result.stderr).toBe(0);
			return result.stdout;
		};
		const printed = (lines: readonly string[]) => `${lines.join("\n")}\n`;
		const under = (lines: readonly string[]) => lines.map((l) => `  ${l}`);
		const first = aliquot("workflow", "run", fixture);
		expect(first.status, first.stderr).toBe(0);
		const [record] = outputsOf(first.stdout, "SubmissionRecord");
		const [row] = outputsOf(first.stdout, "ReceivingLogRow");
		const [version1, version2, version3] = outputsOf(
			first.stdout,
			"LimsDatabase",
		);
		const [workOrder] = outputsOf(first.stdout, "WorkOrder");
		const [worksheet] = outputsOf(first.stdout, "ResultWorksheet");
		const weighingsId = sha256Hex(readFileSync(weighings));

		const recordTree = [
			`${record} SubmissionRecord <- R-1 S-parse_submission v1`,
			`  ${fixtureId} SubmissionForm <- none`,
		];
		const version1Tree = [
			`${version1} LimsDatabase <- R-2 S-log_receipt v1`,
			...under(recordTree),
		];
		const rowTree = [
			`${row} ReceivingLogRow <- R-2 S-log_receipt v1`,
			...under(recordTree),
		];
		const workOrderTree = [
			`${workOrder} WorkOrder <- R-3 S-create_work_order v1`,
			...under(rowTree),
			...under(version1Tree),
		];
		const stage4Inputs = [
			...workOrderTree,
			`${weighingsId} Other <- none`,
			`${version2} LimsDatabase <- R-3 S-create_work_order v1`,
			...under(rowTree),
			...under(version1Tree),
		];

		expect(lineageOf(version1)).toBe(printed(version1Tree));
		expect(lineageOf(workOrder)).toBe(printed(workOrderTree));
		expect(
			lineageOf(worksheet),
			"the Result Worksheet names the Work Order, the weighings and stage 3's database",
		).toBe(
			printed([
				`${worksheet} ResultWorksheet <- R-4 S-compute_results v1`,
				...under(stage4Inputs),
			]),
		);

		const second = aliquot("workflow", "run", secondFixture);
		expect(second.status, second.stderr).toBe(0);
		const [record2] = outputsOf(second.stdout, "SubmissionRecord");
		const [version4] = outputsOf(second.stdout, "LimsDatabase");

		expect(lineageOf(version4)).toBe(
			printed([
				`${version4} LimsDatabase <- R-6 S-log_receipt v1`,
				`  ${record2} SubmissionRecord <- R-5 S-parse_submission v1`,
				`    ${secondFixtureId} SubmissionForm <- none`,
				`  ${version3} LimsDatabase <- R-4 S-compute_results v1`,
				...under(under(stage4Inputs)),
			]),
		);
	}, 600_000);

	it("run-all runs every docx in a directory and exits 1 when any Evaluation fails", () => {
		const dir = join(scratch, "fixtures");
		mkdirSync(dir);
		copyFileSync(fixture, join(dir, "a-good.docx"));
		copyFileSync(weighings, join(dir, "a-good.weighings.json"));
		writeFileSync(join(dir, "b-not-a-docx.docx"), "not a zip archive\n");
		writeFileSync(join(dir, "notes.txt"), "ignored\n");

		const result = aliquot("workflow", "run-all", dir);

		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).toMatch(/^2 Fixtures: 1 Done, 1 Failed\n$/m);
		const { events, verify, taskState } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState("T-1")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-2")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-3")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-4")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-5")?.tag).toBe("Failed");
		expect(taskState("T-6")).toBeUndefined();
		// One registration per stage serves every Fixture in the batch.
		expect(
			events.filter(
				(e) => e.kind === "ScriptRegistered" || e.kind === "ScriptRevised",
			),
		).toHaveLength(4);
	}, 600_000);
});
