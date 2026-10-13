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
				"",
			].join("\n"),
		);
	});

	it("run refuses a --to beyond the table as a usage error", () => {
		const result = aliquot("workflow", "run", fixture, "--to", "3");

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--to 3 is not a stage number from 1 to 2");
	});

	it("has no stage1 command left", () => {
		const help = aliquot("--help");

		expect(help.stdout).toContain("workflow run-all <fixtures dir>");
		expect(help.stdout).not.toContain("stage1");
		expect(aliquot("stage1", "run", fixture).status).toBe(2);
	});
});

describe.skipIf(!requireDocker())(suite, () => {
	it("run runs stages 1 and 2 on the Fixture, prints each Task, Run, output and Evaluation, exits 0 with both Tasks Done, and writes the README's Event chain, seq 1 to 37", () => {
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
					"    eval      E-2 score 1\\.000, passed\n$",
				].join("\n"),
			),
		);
		const { events, verify, taskState } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState("T-1")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-2")).toEqual({ tag: "Done", assignee: "A-bram" });
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
			...[9, 10].map((seq) => ({
				seq,
				kind: "ScriptRegistered",
				task: undefined,
				causation: undefined,
			})),
			{
				seq: 11,
				kind: "ArtifactStored",
				task: undefined,
				causation: undefined,
			},
			{ seq: 12, kind: "TaskProposed", task: "T-1", causation: 11 },
			{ seq: 13, kind: "TaskAssigned", task: "T-1", causation: 12 },
			{ seq: 14, kind: "TaskStarted", task: "T-1", causation: 13 },
			{ seq: 15, kind: "RunStarted", task: "T-1", causation: 14 },
			{ seq: 16, kind: "ArtifactStored", task: "T-1", causation: 15 },
			{ seq: 17, kind: "ArtifactStored", task: "T-1", causation: 15 },
			{ seq: 18, kind: "ArtifactStored", task: "T-1", causation: 15 },
			{ seq: 19, kind: "RunFinished", task: "T-1", causation: 15 },
			{ seq: 20, kind: "EvaluationRecorded", task: "T-1", causation: 19 },
			{ seq: 21, kind: "TaskCompleted", task: "T-1", causation: 20 },
			{ seq: 22, kind: "ReviewRecorded", task: "T-1", causation: 21 },
			{ seq: 23, kind: "TaskCompleted", task: "T-1", causation: 22 },
			{ seq: 24, kind: "TaskProposed", task: "T-2", causation: 23 },
			{ seq: 25, kind: "TaskAssigned", task: "T-2", causation: 24 },
			{ seq: 26, kind: "TaskStarted", task: "T-2", causation: 25 },
			{ seq: 27, kind: "RunStarted", task: "T-2", causation: 26 },
			...[28, 29, 30, 31, 32].map((seq) => ({
				seq,
				kind: "ArtifactStored",
				task: "T-2",
				causation: 27,
			})),
			{ seq: 33, kind: "RunFinished", task: "T-2", causation: 27 },
			{ seq: 34, kind: "EvaluationRecorded", task: "T-2", causation: 33 },
			{ seq: 35, kind: "TaskCompleted", task: "T-2", causation: 34 },
			{ seq: 36, kind: "ReviewRecorded", task: "T-2", causation: 35 },
			{ seq: 37, kind: "TaskCompleted", task: "T-2", causation: 36 },
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
		expect(at(11)?.payload).toMatchObject({ id: fixtureId, lineage: [] });
		expect(
			[16, 17, 18].map((seq) => at(seq)?.payload),
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
		expect(at(20)?.payload).toMatchObject({
			stage: 1,
			score: 1,
			passed: true,
		});
		expect(at(21)).toMatchObject({
			actor: rin,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(22)).toMatchObject({ actor: pia });
		expect(at(23)).toMatchObject({
			actor: pia,
			payload: { review: { tag: "Reviewed" } },
		});
		const recordId = /output {4}([0-9a-f]{64}) SubmissionRecord/.exec(
			result.stdout,
		)?.[1];
		expect(at(16)?.payload).toMatchObject({ id: recordId });
		expect(
			at(24)?.payload,
			"stage 2 takes the record, and no database is there to carry",
		).toMatchObject({ inputs: [recordId] });
		expect(
			[28, 29, 30, 31, 32].map((seq) => at(seq)?.payload),
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
		expect(at(34)?.payload).toMatchObject({
			stage: 2,
			score: 1,
			passed: true,
		});
		expect(at(35)).toMatchObject({
			actor: bram,
			payload: { review: { tag: "Required", reviewer: pia } },
		});
		expect(at(36)).toMatchObject({ actor: pia });
		expect(at(37)).toMatchObject({
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

	it("sandbox lineage prints a toy LIMS database version's record and Fixture, and after a run on another Fixture, the version it carried", () => {
		const outputOf = (stdout: string, type: string) => {
			const id = new RegExp(`output {4}([0-9a-f]{64}) ${type}`).exec(
				stdout,
			)?.[1];
			if (!id) throw new Error(`no ${type} in ${stdout}`);
			return id;
		};
		const first = aliquot("workflow", "run", fixture);
		expect(first.status, first.stderr).toBe(0);
		const record = outputOf(first.stdout, "SubmissionRecord");
		const version1 = outputOf(first.stdout, "LimsDatabase");

		const lineage1 = aliquot("sandbox", "lineage", version1);

		expect(lineage1.status, lineage1.stderr).toBe(0);
		expect(lineage1.stdout).toBe(
			[
				`${version1} LimsDatabase <- R-2 S-log_receipt v1`,
				`  ${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`    ${fixtureId} SubmissionForm <- none`,
				"",
			].join("\n"),
		);

		const second = aliquot("workflow", "run", secondFixture);
		expect(second.status, second.stderr).toBe(0);
		const record2 = outputOf(second.stdout, "SubmissionRecord");
		const version2 = outputOf(second.stdout, "LimsDatabase");

		const lineage2 = aliquot("sandbox", "lineage", version2);

		expect(lineage2.status, lineage2.stderr).toBe(0);
		expect(lineage2.stdout).toBe(
			[
				`${version2} LimsDatabase <- R-4 S-log_receipt v1`,
				`  ${record2} SubmissionRecord <- R-3 S-parse_submission v1`,
				`    ${secondFixtureId} SubmissionForm <- none`,
				`  ${version1} LimsDatabase <- R-2 S-log_receipt v1`,
				`    ${record} SubmissionRecord <- R-1 S-parse_submission v1`,
				`      ${fixtureId} SubmissionForm <- none`,
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
		expect(taskState("T-3")?.tag).toBe("Failed");
		expect(taskState("T-4")).toBeUndefined();
		// One registration per stage serves every Fixture in the batch.
		expect(
			events.filter(
				(e) => e.kind === "ScriptRegistered" || e.kind === "ScriptRevised",
			),
		).toHaveLength(2);
	}, 600_000);
});
