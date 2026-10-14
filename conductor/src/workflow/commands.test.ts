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
				"2 Receipt  script log_receipt  inputs SubmissionRecord  optional ReceivingLog  carried LimsDatabase  outputs ReceivingLogRow,LimsDatabase  worked by A-bram  reviewed by A-pia",
				"3 Work Order  script create_work_order  inputs ReceivingLogRow,SubmissionRecord  carried LimsDatabase  outputs WorkOrder,LimsDatabase  worked by A-bram  reviewed by A-pia",
				"4 Results  script compute_results  inputs WorkOrder,Other  carried LimsDatabase  outputs ResultWorksheet,LimsDatabase  worked by A-rin  reviewed by A-anselm",
				"5 Verification  script verify_results  inputs ResultWorksheet,Other  carried none  outputs VerificationRecord  worked by A-bram  reviewed by A-anselm",
				"6 Report  script render_roa  inputs VerificationRecord,ReceivingLogRow,Other  carried LimsDatabase  outputs ReportOfAnalysis,ReportOfAnalysis,LimsDatabase  worked by A-ines  reviewed by A-anselm",
				"",
			].join("\n"),
		);
	});

	it("run refuses a --to beyond the table as a usage error", () => {
		const result = aliquot("workflow", "run", fixture, "--to", "7");

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--to 7 is not a stage number from 1 to 6");
	});

	it("has no stage1 command left", () => {
		const help = aliquot("--help");

		expect(help.stdout).toContain("workflow run-all <fixtures dir>");
		expect(help.stdout).not.toContain("stage1");
		expect(aliquot("stage1", "run", fixture).status).toBe(2);
	});
});

describe.skipIf(!requireDocker())(suite, () => {
	it("run runs stages 1 to 6 on the Fixture, prints each Task, Run, output and Evaluation, exits 0 with every Task Done, and writes the README's Event chain, seq 1 to 97", () => {
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
					"    eval      E-4 score 1\\.000, passed",
					"  stage 5 Verification: T-5 Done",
					"    run       R-5 S-verify_results v1, exit 0",
					"    output    [0-9a-f]{64} VerificationRecord verification_record\\.json",
					"    eval      E-5 score 1\\.000, passed",
					"  stage 6 Report: T-6 Done",
					"    run       R-6 S-render_roa v1, exit 0",
					"    output    [0-9a-f]{64} LimsDatabase lims\\.sqlite",
					"    output    [0-9a-f]{64} Other report_of_analysis\\.json",
					"    output    [0-9a-f]{64} ReportOfAnalysis report_of_analysis\\.pdf",
					"    output    [0-9a-f]{64} ReportOfAnalysis report_of_analysis\\.xlsx",
					"    eval      E-6 score 1\\.000, passed\n$",
				].join("\n"),
			),
		);
		const { events, verify, taskState } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState("T-1")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-2")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-3")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-4")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-5")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-6")).toEqual({ tag: "Done", assignee: "A-ines" });
		const rin = { tag: "Agent", id: "A-rin" };
		const ines = { tag: "Agent", id: "A-ines" };
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
			...[9, 10, 11, 12, 13, 14].map((seq) =>
				unlinked(seq, "ScriptRegistered"),
			),
			unlinked(15, "ArtifactStored"),
			{ seq: 16, kind: "TaskProposed", task: "T-1", causation: 15 },
			{ seq: 17, kind: "TaskAssigned", task: "T-1", causation: 16 },
			{ seq: 18, kind: "TaskStarted", task: "T-1", causation: 17 },
			{ seq: 19, kind: "RunStarted", task: "T-1", causation: 18 },
			{ seq: 20, kind: "ArtifactStored", task: "T-1", causation: 19 },
			{ seq: 21, kind: "ArtifactStored", task: "T-1", causation: 19 },
			{ seq: 22, kind: "ArtifactStored", task: "T-1", causation: 19 },
			{ seq: 23, kind: "RunFinished", task: "T-1", causation: 19 },
			{ seq: 24, kind: "EvaluationRecorded", task: "T-1", causation: 23 },
			{ seq: 25, kind: "TaskCompleted", task: "T-1", causation: 24 },
			{ seq: 26, kind: "ReviewRecorded", task: "T-1", causation: 25 },
			{ seq: 27, kind: "TaskCompleted", task: "T-1", causation: 26 },
			{ seq: 28, kind: "TaskProposed", task: "T-2", causation: 27 },
			{ seq: 29, kind: "TaskAssigned", task: "T-2", causation: 28 },
			{ seq: 30, kind: "TaskStarted", task: "T-2", causation: 29 },
			{ seq: 31, kind: "RunStarted", task: "T-2", causation: 30 },
			...[32, 33, 34, 35, 36].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-2",
				causation: 31,
			})),
			{ seq: 37, kind: "RunFinished", task: "T-2", causation: 31 },
			{ seq: 38, kind: "EvaluationRecorded", task: "T-2", causation: 37 },
			{ seq: 39, kind: "TaskCompleted", task: "T-2", causation: 38 },
			{ seq: 40, kind: "ReviewRecorded", task: "T-2", causation: 39 },
			{ seq: 41, kind: "TaskCompleted", task: "T-2", causation: 40 },
			{ seq: 42, kind: "TaskProposed", task: "T-3", causation: 41 },
			{ seq: 43, kind: "TaskAssigned", task: "T-3", causation: 42 },
			{ seq: 44, kind: "TaskStarted", task: "T-3", causation: 43 },
			{ seq: 45, kind: "RunStarted", task: "T-3", causation: 44 },
			...[46, 47, 48, 49, 50].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-3",
				causation: 45,
			})),
			{ seq: 51, kind: "RunFinished", task: "T-3", causation: 45 },
			{ seq: 52, kind: "EvaluationRecorded", task: "T-3", causation: 51 },
			{ seq: 53, kind: "TaskCompleted", task: "T-3", causation: 52 },
			{ seq: 54, kind: "ReviewRecorded", task: "T-3", causation: 53 },
			{ seq: 55, kind: "TaskCompleted", task: "T-3", causation: 54 },
			unlinked(56, "ArtifactStored"),
			{ seq: 57, kind: "TaskProposed", task: "T-4", causation: 55 },
			{ seq: 58, kind: "TaskAssigned", task: "T-4", causation: 57 },
			{ seq: 59, kind: "TaskStarted", task: "T-4", causation: 58 },
			{ seq: 60, kind: "RunStarted", task: "T-4", causation: 59 },
			...[61, 62, 63, 64, 65].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-4",
				causation: 60,
			})),
			{ seq: 66, kind: "RunFinished", task: "T-4", causation: 60 },
			{ seq: 67, kind: "EvaluationRecorded", task: "T-4", causation: 66 },
			{ seq: 68, kind: "TaskCompleted", task: "T-4", causation: 67 },
			{ seq: 69, kind: "ReviewRecorded", task: "T-4", causation: 68 },
			{ seq: 70, kind: "TaskCompleted", task: "T-4", causation: 69 },
			{ seq: 71, kind: "TaskProposed", task: "T-5", causation: 70 },
			{ seq: 72, kind: "TaskAssigned", task: "T-5", causation: 71 },
			{ seq: 73, kind: "TaskStarted", task: "T-5", causation: 72 },
			{ seq: 74, kind: "RunStarted", task: "T-5", causation: 73 },
			...[75, 76, 77].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-5",
				causation: 74,
			})),
			{ seq: 78, kind: "RunFinished", task: "T-5", causation: 74 },
			{ seq: 79, kind: "EvaluationRecorded", task: "T-5", causation: 78 },
			{ seq: 80, kind: "TaskCompleted", task: "T-5", causation: 79 },
			{ seq: 81, kind: "ReviewRecorded", task: "T-5", causation: 80 },
			{ seq: 82, kind: "TaskCompleted", task: "T-5", causation: 81 },
			{ seq: 83, kind: "TaskProposed", task: "T-6", causation: 82 },
			{ seq: 84, kind: "TaskAssigned", task: "T-6", causation: 83 },
			{ seq: 85, kind: "TaskStarted", task: "T-6", causation: 84 },
			{ seq: 86, kind: "RunStarted", task: "T-6", causation: 85 },
			...[87, 88, 89, 90, 91, 92].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-6",
				causation: 86,
			})),
			{ seq: 93, kind: "RunFinished", task: "T-6", causation: 86 },
			{ seq: 94, kind: "EvaluationRecorded", task: "T-6", causation: 93 },
			{ seq: 95, kind: "TaskCompleted", task: "T-6", causation: 94 },
			{ seq: 96, kind: "ReviewRecorded", task: "T-6", causation: 95 },
			{ seq: 97, kind: "TaskCompleted", task: "T-6", causation: 96 },
		]);
		const at = (seq: number) => events[seq - 1];
		expect(at(9)?.payload).toMatchObject({
			id: "S-parse_submission",
			owner_agent: "A-rin",
		});
		expect(at(10)?.payload).toMatchObject({
			id: "S-log_receipt",
			owner_agent: "A-bram",
			input_types: ["SubmissionRecord", "ReceivingLog", "LimsDatabase"],
			output_types: ["ReceivingLogRow", "LimsDatabase"],
		});
		expect(at(11)?.payload).toMatchObject({
			id: "S-create_work_order",
			owner_agent: "A-bram",
			input_types: ["ReceivingLogRow", "SubmissionRecord", "LimsDatabase"],
			output_types: ["WorkOrder", "LimsDatabase"],
		});
		expect(at(12)?.payload).toMatchObject({
			id: "S-compute_results",
			owner_agent: "A-rin",
			input_types: ["WorkOrder", "Other", "LimsDatabase"],
			output_types: ["ResultWorksheet", "LimsDatabase"],
		});
		expect(at(13)?.payload).toMatchObject({
			id: "S-verify_results",
			owner_agent: "A-bram",
			input_types: ["ResultWorksheet", "Other"],
			output_types: ["VerificationRecord"],
		});
		expect(at(14)?.payload).toMatchObject({
			id: "S-render_roa",
			owner_agent: "A-ines",
			input_types: [
				"VerificationRecord",
				"ReceivingLogRow",
				"Other",
				"LimsDatabase",
			],
			output_types: ["ReportOfAnalysis", "ReportOfAnalysis", "LimsDatabase"],
		});
		expect(at(15)?.payload).toMatchObject({ id: fixtureId, lineage: [] });
		expect(
			[20, 21, 22].map((seq) => at(seq)?.payload),
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
		expect(at(24)?.payload).toMatchObject({
			stage: 1,
			score: 1,
			passed: true,
		});
		expect(at(25)).toMatchObject({
			actor: rin,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(26)).toMatchObject({ actor: pia });
		expect(at(27)).toMatchObject({
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
		expect(at(20)?.payload).toMatchObject({ id: recordId });
		expect(
			at(28)?.payload,
			"stage 2 takes the record, and no database is there to carry",
		).toMatchObject({ inputs: [recordId] });
		expect(
			[32, 33, 34, 35, 36].map((seq) => at(seq)?.payload),
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
		expect(at(38)?.payload).toMatchObject({
			stage: 2,
			score: 1,
			passed: true,
		});
		expect(at(39)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(40)).toMatchObject({ actor: pia });
		expect(at(41)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		const [rowId] = outputsOf("ReceivingLogRow");
		const [version1, version2, version3] = outputsOf("LimsDatabase");
		expect(
			at(42)?.payload,
			"stage 3 takes the Receiving Log row and the record, and carries stage 2's database",
		).toMatchObject({ inputs: [rowId, recordId, version1] });
		expect(
			[46, 47, 48, 49, 50].map((seq) => at(seq)?.payload),
			"each with a Lineage of the Receiving Log row, the record and stage 2's database",
		).toMatchObject([
			{
				filename: "lims.sqlite",
				artifact_type: "LimsDatabase",
				lineage: [rowId, recordId, version1],
			},
			{ filename: "work_order.json", artifact_type: "Other" },
			{
				filename: "work_order.xlsx",
				artifact_type: "WorkOrder",
				lineage: [rowId, recordId, version1],
			},
			{ filename: "stdout.txt" },
			{ filename: "stderr.txt" },
		]);
		expect(at(52)?.payload).toMatchObject({
			stage: 3,
			score: 1,
			passed: true,
		});
		expect(at(53)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(54)).toMatchObject({ actor: pia });
		expect(at(55)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		const [workOrderId] = outputsOf("WorkOrder");
		const weighingsId = ArtifactId.parse(sha256Hex(readFileSync(weighings)));
		expect(
			at(56),
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
			at(57)?.payload,
			"stage 4 takes the Work Order and the weighings, and carries stage 3's database",
		).toMatchObject({ inputs: [workOrderId, weighingsId, version2] });
		const lineage4 = [workOrderId, weighingsId, version2];
		expect(
			[61, 62, 63, 64, 65].map((seq) => at(seq)?.payload),
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
		expect(at(67)?.payload).toMatchObject({
			stage: 4,
			score: 1,
			passed: true,
		});
		expect(at(68)).toMatchObject({
			actor: rin,
			payload: { review: { tag: "Required", reviewer: anselm } },
		});
		expect(at(69)).toMatchObject({ actor: anselm });
		expect(at(70)).toMatchObject({
			actor: anselm,
			payload: { review: { tag: "Reviewed" } },
		});
		const [worksheetId] = outputsOf("ResultWorksheet");
		expect(
			at(71)?.payload,
			"stage 5 takes the Result Worksheet and the weighings, and carries nothing",
		).toMatchObject({ inputs: [worksheetId, weighingsId] });
		expect(
			[75, 76, 77].map((seq) => at(seq)?.payload),
			"each with a Lineage of the worksheet and the weighings",
		).toMatchObject([
			{
				filename: "verification_record.json",
				artifact_type: "VerificationRecord",
				media_type: "application/json",
				lineage: [worksheetId, weighingsId],
			},
			{ filename: "stdout.txt" },
			{ filename: "stderr.txt" },
		]);
		expect(at(79)?.payload).toMatchObject({
			stage: 5,
			score: 1,
			passed: true,
		});
		expect(at(80)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: anselm } },
		});
		expect(at(81)).toMatchObject({ actor: anselm });
		expect(at(82)).toMatchObject({
			actor: anselm,
			payload: { review: { tag: "Reviewed" } },
		});
		const [recordOfVerification] = outputsOf("VerificationRecord");
		const [, , , version4] = outputsOf("LimsDatabase");
		expect(
			at(83)?.payload,
			"stage 6 takes the Verification Record, stage 2's Receiving Log row and the weighings, and carries stage 4's database",
		).toMatchObject({
			inputs: [recordOfVerification, rowId, weighingsId, version3],
		});
		const lineage6 = [recordOfVerification, rowId, weighingsId, version3];
		const [pdfId, xlsxId] = outputsOf("ReportOfAnalysis");
		expect(
			[87, 88, 89, 90, 91, 92].map((seq) => at(seq)?.payload),
			"each with a Lineage of the record, the Receiving Log row, the weighings and stage 4's database",
		).toMatchObject([
			{
				id: version4,
				filename: "lims.sqlite",
				artifact_type: "LimsDatabase",
				lineage: lineage6,
			},
			{ filename: "report_of_analysis.json", artifact_type: "Other" },
			{
				id: pdfId,
				filename: "report_of_analysis.pdf",
				artifact_type: "ReportOfAnalysis",
				media_type: "application/pdf",
				lineage: lineage6,
			},
			{
				id: xlsxId,
				filename: "report_of_analysis.xlsx",
				artifact_type: "ReportOfAnalysis",
				lineage: lineage6,
			},
			{ filename: "stdout.txt" },
			{ filename: "stderr.txt" },
		]);
		expect(at(94)?.payload).toMatchObject({
			stage: 6,
			score: 1,
			passed: true,
		});
		expect(at(95)).toMatchObject({
			actor: ines,
			payload: { review: { tag: "Required", reviewer: anselm } },
		});
		expect(at(96)).toMatchObject({ actor: anselm });
		expect(at(97)).toMatchObject({
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

	it("sandbox lineage prints a toy LIMS database version's record and Fixture, the Work Order's, the Result Worksheet's, the Verification Record's and the Report of Analysis's inputs back to the Fixture and the weighings, and after a run on another Fixture, the version stage 6 wrote", () => {
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
		const [version1, version2, version3, version4] = outputsOf(
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
			...under(recordTree),
			...under(version1Tree),
		];
		const stage4Inputs = [
			...workOrderTree,
			`${weighingsId} Other <- none`,
			`${version2} LimsDatabase <- R-3 S-create_work_order v1`,
			...under(rowTree),
			...under(recordTree),
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
		const [verificationRecord] = outputsOf(first.stdout, "VerificationRecord");
		const verificationTree = [
			`${verificationRecord} VerificationRecord <- R-5 S-verify_results v1`,
			`  ${worksheet} ResultWorksheet <- R-4 S-compute_results v1`,
			...under(under(stage4Inputs)),
			`  ${weighingsId} Other <- none`,
		];
		expect(
			lineageOf(verificationRecord),
			"the Verification Record names the worksheet and the weighings",
		).toBe(printed(verificationTree));
		const [pdf] = outputsOf(first.stdout, "ReportOfAnalysis");
		const stage6Inputs = [
			...verificationTree,
			...rowTree,
			`${weighingsId} Other <- none`,
			`${version3} LimsDatabase <- R-4 S-compute_results v1`,
			...under(stage4Inputs),
		];
		expect(
			lineageOf(pdf),
			"the Report of Analysis names the record, the Receiving Log row, the weighings and stage 4's database, and every path ends at the Fixture or the weighings",
		).toBe(
			printed([
				`${pdf} ReportOfAnalysis <- R-6 S-render_roa v1`,
				...under(stage6Inputs),
			]),
		);

		const second = aliquot("workflow", "run", secondFixture);
		expect(second.status, second.stderr).toBe(0);
		const [record2] = outputsOf(second.stdout, "SubmissionRecord");
		const [version5] = outputsOf(second.stdout, "LimsDatabase");

		expect(lineageOf(version5)).toBe(
			printed([
				`${version5} LimsDatabase <- R-8 S-log_receipt v1`,
				`  ${record2} SubmissionRecord <- R-7 S-parse_submission v1`,
				`    ${secondFixtureId} SubmissionForm <- none`,
				`  ${version4} LimsDatabase <- R-6 S-render_roa v1`,
				...under(under(stage6Inputs)),
			]),
		);
	}, 600_000);

	it("run-all runs every docx in a directory and exits 1 when any Evaluation fails", () => {
		const dir = join(scratch, "fixtures");
		mkdirSync(dir);
		copyFileSync(fixture, join(dir, "a-good.docx"));
		copyFileSync(weighings, join(dir, "a-good.weighings.json"));
		writeFileSync(join(dir, "b-not-a-docx.docx"), "not a zip archive\n");
		for (const stem of ["a-good", "b-not-a-docx"]) {
			writeFileSync(join(dir, `${stem}.expected.json`), "{}\n");
		}
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
		expect(taskState("T-5")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-6")).toEqual({ tag: "Done", assignee: "A-ines" });
		expect(taskState("T-7")?.tag).toBe("Failed");
		expect(taskState("T-8")).toBeUndefined();
		// One registration per stage serves every Fixture in the batch.
		expect(
			events.filter(
				(e) => e.kind === "ScriptRegistered" || e.kind === "ScriptRevised",
			),
		).toHaveLength(6);
	}, 600_000);

	it("run-all walks subdirectories, holds a known gap only at its own stage, and lists the workbooks and forms without an expected outcome it skips", () => {
		const dir = join(scratch, "fixtures");
		const nested = join(dir, "real-layout");
		mkdirSync(nested, { recursive: true });
		const gap = (stem: string, stage: number) =>
			writeFileSync(
				join(dir, `${stem}.known-gap.json`),
				JSON.stringify({ stage, issue: 9, reason: "a gap for the test" }),
			);
		copyFileSync(fixture, join(dir, "a-closed-gap.docx"));
		copyFileSync(weighings, join(dir, "a-closed-gap.weighings.json"));
		gap("a-closed-gap", 3);
		writeFileSync(join(dir, "b-gap.docx"), "not a zip archive\n");
		gap("b-gap", 1);
		writeFileSync(join(dir, "c-other-stage.docx"), "not a zip archive\n");
		gap("c-other-stage", 2);
		writeFileSync(join(nested, "d-no-gap.docx"), "not a zip archive\n");
		for (const stem of ["a-closed-gap", "b-gap", "c-other-stage"]) {
			writeFileSync(join(dir, `${stem}.expected.json`), "{}\n");
		}
		writeFileSync(join(nested, "d-no-gap.expected.json"), "{}\n");
		writeFileSync(join(nested, "e-blank.docx"), "not a zip archive\n");
		writeFileSync(join(nested, "log.xlsx"), "a workbook\n");

		const result = aliquot("workflow", "run-all", dir);

		expect(result.status, result.stderr).toBe(1);
		const order = [
			"real-layout/log.xlsx",
			"real-layout/e-blank.docx",
			"a-closed-gap.docx",
			"b-gap.docx",
			"c-other-stage.docx",
			"real-layout/d-no-gap.docx",
		].map((name) => result.stdout.indexOf(`${name}\n`));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((x, y) => x - y)).toEqual(order);
		expect(result.stdout).toContain(
			"  skipped   no stage starts from a workbook",
		);
		expect(result.stdout).toContain(
			"real-layout/e-blank.docx\n  skipped   no e-blank.expected.json beside it, so it has no expected outcome and is not a Fixture\n",
		);
		expect(result.stdout).toContain(
			`  failed    the known gap at stage 3 (#9) is closed: delete ${join(dir, "a-closed-gap.known-gap.json")}\n`,
		);
		expect(result.stdout).toContain(
			"  known gap stage 1, #9: a gap for the test\n",
		);
		expect(result.stdout).toContain(
			"  failed    stopped at stage 1, not at the known gap's stage 2 (#9)\n",
		);
		expect(result.stdout).toMatch(
			/^4 Fixtures: 0 Done, 1 known gap, 3 Failed; 1 workbook and 1 form skipped\n$/m,
		);
		expect(readLedger().verify.ok).toBe(true);
	}, 600_000);
});
