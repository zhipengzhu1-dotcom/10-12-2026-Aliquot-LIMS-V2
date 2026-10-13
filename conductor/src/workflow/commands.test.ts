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
				"",
			].join("\n"),
		);
	});

	it("run refuses a --to beyond the table as a usage error", () => {
		const result = aliquot("workflow", "run", fixture, "--to", "4");

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--to 4 is not a stage number from 1 to 3");
	});

	it("has no stage1 command left", () => {
		const help = aliquot("--help");

		expect(help.stdout).toContain("workflow run-all <fixtures dir>");
		expect(help.stdout).not.toContain("stage1");
		expect(aliquot("stage1", "run", fixture).status).toBe(2);
	});
});

describe.skipIf(!requireDocker())(suite, () => {
	it("run runs stages 1 to 3 on the Fixture, prints each Task, Run, output and Evaluation, exits 0 with every Task Done, and writes the README's Event chain, seq 1 to 52", () => {
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
					"    eval      E-3 score 1\\.000, passed\n$",
				].join("\n"),
			),
		);
		const { events, verify, taskState } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState("T-1")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-2")).toEqual({ tag: "Done", assignee: "A-bram" });
		expect(taskState("T-3")).toEqual({ tag: "Done", assignee: "A-bram" });
		const rin = { tag: "Agent", id: "A-rin" };
		const bram = { tag: "Agent", id: "A-bram" };
		const pia = { tag: "Agent", id: "A-pia" };
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
			...[1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({
				seq,
				kind: "AgentRecruited",
				task: undefined,
				causation: undefined,
			})),
			...[9, 10, 11].map((seq) => ({
				seq,
				kind: "ScriptRegistered",
				task: undefined,
				causation: undefined,
			})),
			{
				seq: 12,
				kind: "ArtifactStored",
				task: undefined,
				causation: undefined,
			},
			{ seq: 13, kind: "TaskProposed", task: "T-1", causation: 12 },
			{ seq: 14, kind: "TaskAssigned", task: "T-1", causation: 13 },
			{ seq: 15, kind: "TaskStarted", task: "T-1", causation: 14 },
			{ seq: 16, kind: "RunStarted", task: "T-1", causation: 15 },
			{ seq: 17, kind: "ArtifactStored", task: "T-1", causation: 16 },
			{ seq: 18, kind: "ArtifactStored", task: "T-1", causation: 16 },
			{ seq: 19, kind: "ArtifactStored", task: "T-1", causation: 16 },
			{ seq: 20, kind: "RunFinished", task: "T-1", causation: 16 },
			{ seq: 21, kind: "EvaluationRecorded", task: "T-1", causation: 20 },
			{ seq: 22, kind: "TaskCompleted", task: "T-1", causation: 21 },
			{ seq: 23, kind: "ReviewRecorded", task: "T-1", causation: 22 },
			{ seq: 24, kind: "TaskCompleted", task: "T-1", causation: 23 },
			{ seq: 25, kind: "TaskProposed", task: "T-2", causation: 24 },
			{ seq: 26, kind: "TaskAssigned", task: "T-2", causation: 25 },
			{ seq: 27, kind: "TaskStarted", task: "T-2", causation: 26 },
			{ seq: 28, kind: "RunStarted", task: "T-2", causation: 27 },
			...[29, 30, 31, 32, 33].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-2",
				causation: 28,
			})),
			{ seq: 34, kind: "RunFinished", task: "T-2", causation: 28 },
			{ seq: 35, kind: "EvaluationRecorded", task: "T-2", causation: 34 },
			{ seq: 36, kind: "TaskCompleted", task: "T-2", causation: 35 },
			{ seq: 37, kind: "ReviewRecorded", task: "T-2", causation: 36 },
			{ seq: 38, kind: "TaskCompleted", task: "T-2", causation: 37 },
			{ seq: 39, kind: "TaskProposed", task: "T-3", causation: 38 },
			{ seq: 40, kind: "TaskAssigned", task: "T-3", causation: 39 },
			{ seq: 41, kind: "TaskStarted", task: "T-3", causation: 40 },
			{ seq: 42, kind: "RunStarted", task: "T-3", causation: 41 },
			...[43, 44, 45, 46, 47].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-3",
				causation: 42,
			})),
			{ seq: 48, kind: "RunFinished", task: "T-3", causation: 42 },
			{ seq: 49, kind: "EvaluationRecorded", task: "T-3", causation: 48 },
			{ seq: 50, kind: "TaskCompleted", task: "T-3", causation: 49 },
			{ seq: 51, kind: "ReviewRecorded", task: "T-3", causation: 50 },
			{ seq: 52, kind: "TaskCompleted", task: "T-3", causation: 51 },
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
		expect(at(12)?.payload).toMatchObject({ id: fixtureId, lineage: [] });
		expect(
			[17, 18, 19].map((seq) => at(seq)?.payload),
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
		expect(at(21)?.payload).toMatchObject({
			stage: 1,
			score: 1,
			passed: true,
		});
		expect(at(22)).toMatchObject({
			actor: rin,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(23)).toMatchObject({ actor: pia });
		expect(at(24)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		const outputOf = (type: string) =>
			new RegExp(`output {4}([0-9a-f]{64}) ${type}`).exec(result.stdout)?.[1];
		const recordId = outputOf("SubmissionRecord");
		expect(at(17)?.payload).toMatchObject({ id: recordId });
		expect(
			at(25)?.payload,
			"stage 2 takes the record, and no database is there to carry",
		).toMatchObject({ inputs: [recordId] });
		expect(
			[29, 30, 31, 32, 33].map((seq) => at(seq)?.payload),
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
		expect(at(35)?.payload).toMatchObject({
			stage: 2,
			score: 1,
			passed: true,
		});
		expect(at(36)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(37)).toMatchObject({ actor: pia });
		expect(at(38)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		const rowId = outputOf("ReceivingLogRow");
		const version1 = outputOf("LimsDatabase");
		expect(
			at(39)?.payload,
			"stage 3 takes the Receiving Log row and carries stage 2's database",
		).toMatchObject({ inputs: [rowId, version1] });
		expect(
			[43, 44, 45, 46, 47].map((seq) => at(seq)?.payload),
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
		expect(at(49)?.payload).toMatchObject({
			stage: 3,
			score: 1,
			passed: true,
		});
		expect(at(50)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(51)).toMatchObject({ actor: pia });
		expect(at(52)).toMatchObject({
			actor: pia,
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

	it("sandbox lineage prints a toy LIMS database version's record and Fixture, the Work Order's Receiving Log row and database back to the Fixture, and after a run on another Fixture, the version stage 3 wrote", () => {
		/** Each output of `type` the run printed, in stage order. */
		const outputsOf = (stdout: string, type: string) => {
			const ids = [
				...stdout.matchAll(new RegExp(`output {4}([0-9a-f]{64}) ${type}`, "g")),
			].map(([, id]) => id);
			if (ids.length === 0) throw new Error(`no ${type} in ${stdout}`);
			return ids;
		};
		const first = aliquot("workflow", "run", fixture);
		expect(first.status, first.stderr).toBe(0);
		const [record] = outputsOf(first.stdout, "SubmissionRecord");
		const [row] = outputsOf(first.stdout, "ReceivingLogRow");
		const [version1, version1WithWorkOrder] = outputsOf(
			first.stdout,
			"LimsDatabase",
		);
		const [workOrder] = outputsOf(first.stdout, "WorkOrder");

		const lineage1 = aliquot("sandbox", "lineage", version1 ?? "");

		expect(lineage1.status, lineage1.stderr).toBe(0);
		expect(lineage1.stdout).toBe(
			[
				`${version1} LimsDatabase <- R-2 S-log_receipt v1`,
				`  ${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`    ${fixtureId} SubmissionForm <- none`,
				"",
			].join("\n"),
		);

		const workOrderLineage = aliquot("sandbox", "lineage", workOrder ?? "");

		expect(workOrderLineage.status, workOrderLineage.stderr).toBe(0);
		expect(workOrderLineage.stdout).toBe(
			[
				`${workOrder} WorkOrder <- R-3 S-create_work_order v1`,
				`  ${row} ReceivingLogRow <- R-2 S-log_receipt v1`,
				`    ${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`      ${fixtureId} SubmissionForm <- none`,
				`  ${version1} LimsDatabase <- R-2 S-log_receipt v1`,
				`    ${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`      ${fixtureId} SubmissionForm <- none`,
				"",
			].join("\n"),
		);

		const second = aliquot("workflow", "run", secondFixture);
		expect(second.status, second.stderr).toBe(0);
		const [record2] = outputsOf(second.stdout, "SubmissionRecord");
		const [version2] = outputsOf(second.stdout, "LimsDatabase");

		const lineage2 = aliquot("sandbox", "lineage", version2 ?? "");

		expect(lineage2.status, lineage2.stderr).toBe(0);
		expect(lineage2.stdout).toBe(
			[
				`${version2} LimsDatabase <- R-5 S-log_receipt v1`,
				`  ${record2} SubmissionRecord <- R-4 S-parse_submission v1`,
				`    ${secondFixtureId} SubmissionForm <- none`,
				`  ${version1WithWorkOrder} LimsDatabase <- R-3 S-create_work_order v1`,
				`    ${row} ReceivingLogRow <- R-2 S-log_receipt v1`,
				`      ${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`        ${fixtureId} SubmissionForm <- none`,
				`    ${version1} LimsDatabase <- R-2 S-log_receipt v1`,
				`      ${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`        ${fixtureId} SubmissionForm <- none`,
				"",
			].join("\n"),
		);
	}, 600_000);

	it("run-all runs every docx in a directory and exits 1 when any Evaluation fails", () => {
		const dir = join(scratch, "fixtures");
		mkdirSync(dir);
		copyFileSync(fixture, join(dir, "a-good.docx"));
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
		expect(taskState("T-4")?.tag).toBe("Failed");
		expect(taskState("T-5")).toBeUndefined();
		// One registration per stage serves every Fixture in the batch.
		expect(
			events.filter(
				(e) => e.kind === "ScriptRegistered" || e.kind === "ScriptRevised",
			),
		).toHaveLength(3);
	}, 600_000);
});
