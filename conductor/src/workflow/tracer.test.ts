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
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import type { Event } from "../events.js";
import { sha256Hex } from "../hash.js";
import { AgentId, ArtifactId, Sha256 } from "../ids.js";
import { lineageOf, openArtifacts } from "../sandbox/artifacts.js";
import { buildImage, scriptsRoot } from "../sandbox/image.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";
import type { ArtifactType } from "../types/artifact.js";
import { STAGES, type Stage, type StageArtifact } from "./stages.js";
import { ensureScript, runWorkflow } from "./tracer.js";

// Each build gives its tag a new image id and Docker drops the image the tag
// held, so this process's tag is its own: other suites and checkouts build at
// the same time.
const IMAGE = `aliquot-sandbox:tracer-${process.pid}`;

const rin = AgentId.parse("A-rin");
const bram = AgentId.parse("A-bram");
const pia = { tag: "Agent", id: "A-pia" } as const;

const [submission] = STAGES;
if (!submission) throw new Error("the stage table has no stage 1");

const suite = dockerAvailable
	? "the workflow tracer (Docker)"
	: "the workflow tracer: SKIPPED because `docker info` failed; start Docker to run these";

const fixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const fixtureId = ArtifactId.parse(sha256Hex(readFileSync(fixture)));

let s: Scenario;
let home: string;
let image: Sha256;

beforeEach(() => {
	s = scenario();
	home = mkdtempSync(join(tmpdir(), "aliquot-tracer-"));
});

afterEach(() => {
	s.close();
	rmSync(home, { recursive: true, force: true });
});

const scriptOf = (stage: Stage) => join(scriptsRoot, stage.script);

/** Run the workflow on a Fixture through `stages`, each Script from `source`. */
const trace = ({
	stages = STAGES,
	source = scriptOf,
	formPath = fixture,
}: {
	stages?: readonly Stage[];
	source?: (stage: Stage) => string;
	formPath?: string;
} = {}) =>
	runWorkflow({
		ledger: s.ledger,
		home,
		formPath,
		plan: stages.map((stage) => {
			const script = ensureScript({
				ledger: s.ledger,
				home,
				stage,
				source: source(stage),
				image,
			});
			return { stage, script: { id: script.id, version: script.version } };
		}),
		timeoutMs: 60_000,
	});

/** Follow causation_id back from `from` until an Event has none. */
const causes = (events: Event[], from: Event): Event[] => {
	const bySeq = new Map(events.map((e) => [Number(e.seq), e]));
	const chain = [from];
	for (let e = from; e.causation_id !== undefined; ) {
		const cause = bySeq.get(Number(e.causation_id));
		if (!cause) throw new Error(`seq ${e.seq} names unknown cause`);
		chain.unshift(cause);
		e = cause;
	}
	return chain;
};

const proposed = (task_id: string) =>
	s.events().find((e) => e.kind === "TaskProposed" && e.task_id === task_id);

/** A copy of parse_submission whose record has no Lot. */
const scriptWithoutLot = () => {
	const dir = join(home, "parse_submission_without_lot");
	mkdirSync(dir);
	copyFileSync(
		join(scriptsRoot, "parse_submission", "main.py"),
		join(dir, "parse.py"),
	);
	writeFileSync(
		join(dir, "main.py"),
		[
			"import json",
			"import sys",
			"from pathlib import Path",
			"",
			"import parse",
			"",
			"code = parse.main()",
			"out = Path(sys.argv[sys.argv.index('--outputs') + 1]) / 'submission.json'",
			"record = json.loads(out.read_text())",
			"del record['sample']['lot']",
			"out.write_text(json.dumps(record))",
			"sys.exit(code)",
			"",
		].join("\n"),
	);
	return dir;
};

/** log_receipt, except that a copy writes LT-000000 as every Receiving Log row's LOT#. */
const scriptWithWrongLot = (stage: Stage) => {
	if (stage.script !== "log_receipt") return scriptOf(stage);
	const dir = join(home, "log_receipt_wrong_lot");
	mkdirSync(dir);
	const original = join(scriptsRoot, "log_receipt");
	copyFileSync(join(original, "main.py"), join(dir, "log_receipt.py"));
	copyFileSync(join(original, "lims_schema.py"), join(dir, "lims_schema.py"));
	writeFileSync(
		join(dir, "main.py"),
		[
			"import sys",
			"",
			"import log_receipt",
			"",
			"write_rows = log_receipt.write_rows",
			"",
			"",
			"def wrong_lot(path, record, on, at, refs):",
			"    sample = {**record['sample'], 'lot': 'LT-000000'}",
			"    write_rows(path, {**record, 'sample': sample}, on, at, refs)",
			"",
			"",
			"log_receipt.write_rows = wrong_lot",
			"sys.exit(log_receipt.main())",
			"",
		].join("\n"),
	);
	return dir;
};

/**
 * create_work_order, except that a copy runs `patch` on the Script's module,
 * imported as `original`, before its main.
 */
const workOrderCopy =
	(name: string, patch: readonly string[]) => (stage: Stage) => {
		if (stage.script !== "create_work_order") return scriptOf(stage);
		const dir = join(home, name);
		mkdirSync(dir, { recursive: true });
		copyFileSync(
			join(scriptsRoot, "create_work_order", "main.py"),
			join(dir, "original.py"),
		);
		writeFileSync(
			join(dir, "main.py"),
			[
				"import sys",
				"from datetime import timedelta",
				"",
				"import original",
				"",
				...patch,
				"sys.exit(original.main())",
				"",
			].join("\n"),
		);
		return dir;
	};

const dueDateOneDayLate = workOrderCopy("due_date_one_day_late", [
	"due_date = original.due_date",
	"original.due_date = lambda on, tat: due_date(on, tat) + timedelta(days=1)",
]);

const lastSampleWithoutTest = workOrderCopy("last_sample_without_test", [
	"tests_of = original.tests_of",
	"original.tests_of = lambda samples: [",
	"    (ref, test) for ref, test in tests_of(samples)",
	"    if ref != samples[-1].lab_reference",
	"]",
]);

/**
 * compute_results, except that a copy runs `patch` on the Script's module,
 * imported as `original`, before its main.
 */
const resultsCopy =
	(name: string, patch: readonly string[]) => (stage: Stage) => {
		if (stage.script !== "compute_results") return scriptOf(stage);
		const dir = join(home, name);
		mkdirSync(dir, { recursive: true });
		copyFileSync(
			join(scriptsRoot, "compute_results", "main.py"),
			join(dir, "original.py"),
		);
		writeFileSync(
			join(dir, "main.py"),
			[
				"import sys",
				"",
				"import original",
				"",
				...patch,
				"sys.exit(original.main())",
				"",
			].join("\n"),
		);
		return dir;
	};

const typedFirstAverage = resultsCopy("typed_first_average", [
	"from openpyxl import load_workbook",
	"",
	"write_sheet = original.write_sheet",
	"",
	"",
	"def typed(path, number, samples):",
	"    write_sheet(path, number, samples)",
	"    wb = load_workbook(path)",
	"    wb.active['H6'] = wb.active['F6'].value / 20",
	"    wb.save(path)",
	"",
	"",
	"original.write_sheet = typed",
]);

const resultsOneMilligramHigh = resultsCopy("results_one_milligram_high", [
	"original.Weighing.average_g = property(",
	"    lambda w: w.weight_of_20_g / 20 + 0.001",
	")",
]);

const secondFixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed2.docx", import.meta.url),
);

const ofType = (
	artifacts: readonly StageArtifact[] | undefined,
	type: ArtifactType,
): StageArtifact => {
	const found = artifacts?.find((a) => a.artifact_type === type);
	if (!found) throw new Error(`no ${type}`);
	return found;
};

/** The rows `sql` selects from a toy LIMS database version, each as its column values. */
const query = (database: StageArtifact, sql: string): unknown[][] => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-tracer-db-"));
	try {
		const path = join(dir, "lims.sqlite");
		writeFileSync(path, database.bytes);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return db
				.prepare(sql)
				.all()
				.map((row) => Object.values(row));
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

/** Every Lab Reference in a toy LIMS database version, in order. */
const labReferences = (database: StageArtifact): string[] =>
	query(
		database,
		"SELECT lab_reference FROM samples ORDER BY lab_reference",
	).map(([ref]) => String(ref));

describe("the workflow tracer without Docker", () => {
	it("refuses a stage before proposing its Task when nothing gave it an input type, naming the stage and the type", async () => {
		image = Sha256.parse("c".repeat(64));
		const before = s.events().filter((e) => e.kind === "TaskProposed");

		await expect(
			trace({ stages: [{ ...submission, inputs: ["WorkOrder"] }] }),
		).rejects.toThrow(
			"stage 1 Submission refused: it takes WorkOrder as input, and the Fixture gave none",
		);
		expect(
			s.events().filter((e) => e.kind === "TaskProposed"),
			"no Task proposed",
		).toEqual(before);
	});

	it("refuses the stage that takes the weighings before proposing its Task when none sit beside the Fixture, naming the file", async () => {
		image = Sha256.parse("c".repeat(64));
		const formPath = join(home, "no-weighings.docx");
		copyFileSync(fixture, formPath);
		const weighingsStage: Stage = {
			...submission,
			inputs: ["SubmissionForm", "Other"],
		};
		const before = s.events().filter((e) => e.kind === "TaskProposed");

		await expect(trace({ stages: [weighingsStage], formPath })).rejects.toThrow(
			`stage 1 Submission refused: it takes the weighings beside the Fixture as input, and ${join(home, "no-weighings.weighings.json")} does not exist`,
		);
		expect(
			s.events().filter((e) => e.kind === "TaskProposed"),
			"no Task proposed",
		).toEqual(before);
	});
});

describe.skipIf(!requireDocker())(suite, () => {
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: IMAGE }));
	}, 600_000);

	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	it("completes stage 1's Task through Review by the stage's reviewer, each Event from TaskProposed on naming the one before it", async () => {
		const { stages } = await trace({ stages: [submission] });

		expect(stages).toHaveLength(1);
		const [result] = stages;
		if (!result) throw new Error("no stage ran");
		expect(result.state).toEqual({ tag: "Done", assignee: rin });
		const events = s.events();
		const completed = events.filter((e) => e.kind === "TaskCompleted").at(-1);
		if (!completed) throw new Error("no TaskCompleted");
		const chain = causes(events, completed);
		expect(chain.map((e) => e.kind)).toEqual([
			"ArtifactStored",
			"TaskProposed",
			"TaskAssigned",
			"TaskStarted",
			"RunStarted",
			"RunFinished",
			"EvaluationRecorded",
			"TaskCompleted",
			"ReviewRecorded",
			"TaskCompleted",
		]);
		const [fixtureStored] = chain;
		expect(
			fixtureStored?.kind === "ArtifactStored" && fixtureStored.payload.id,
		).toBe(fixtureId);
		// A-rin is on Probation, so stage 1's reviewer A-pia reviews every Task.
		const [submitted, review, reviewed] = chain.slice(-3);
		expect(submitted?.payload).toMatchObject({
			review: { tag: "Required", reviewer: pia },
		});
		expect(review?.actor).toEqual(pia);
		expect(review?.payload).toMatchObject({ reviewer: pia, ...scores(3) });
		expect(reviewed?.actor).toEqual(pia);
		expect(reviewed?.payload).toMatchObject({ review: { tag: "Reviewed" } });
		const evaluation = chain.find((e) => e.kind === "EvaluationRecorded");
		expect(evaluation?.payload).toEqual({
			eval_id: result.eval_id,
			stage: 1,
			run_id: result.run.id,
			task_id: result.task_id,
			score: 1,
			passed: true,
			findings: [],
		});
		const taskEvents = events.filter((e) => e.task_id === result.task_id);
		const taskSeqs = new Set(taskEvents.map((e) => Number(e.seq)));
		for (const e of taskEvents.filter((e) => e.kind !== "TaskProposed")) {
			expect(
				taskSeqs.has(Number(e.causation_id)),
				`${e.kind} at seq ${e.seq} names a cause inside the Task`,
			).toBe(true);
		}
	}, 600_000);

	it("stores the record as a SubmissionRecord with a Lineage of the Fixture, and the Fixture, stored as the Operator's SubmissionForm, with an empty Lineage", async () => {
		const [result] = (await trace({ stages: [submission] })).stages;
		const [record] = result?.outputs ?? [];
		if (!result || !record) throw new Error("stage 1 wrote no record");

		const projection = s.ledger.projections.artifacts;
		expect(record).toMatchObject({
			artifact_type: "SubmissionRecord",
			filename: "submission.json",
		});
		expect(
			lineageOf(projection, record.id, { tag: "Run", id: result.run.id }),
		).toEqual([fixtureId]);
		expect(projection.artifacts.get(fixtureId)).toMatchObject({
			artifact_type: "SubmissionForm",
			produced_by: { tag: "Operator" },
		});
		expect(lineageOf(projection, fixtureId, { tag: "Operator" })).toEqual([]);
	}, 600_000);

	it("returns the Trust tier Revision that the stage's Review earns, caused by that Review", async () => {
		// Rin has 9 reviewed Tasks, so the tracer's Review of T-10 is the 10th.
		for (let i = 0; i < 9; i++) s.reviewed(rin, scores(3));

		const [result] = (await trace({ stages: [submission] })).stages;

		expect(result?.task_id).toBe("T-10");
		expect(result?.revisions).toMatchObject([
			{ id: rin, version: 2, trust_tier: "Trusted" },
		]);
		const events = s.events();
		const review = events.filter((e) => e.kind === "ReviewRecorded").at(-1);
		const revision = events.find((e) => e.kind === "AgentDefinitionRevised");
		expect(review?.task_id).toBe("T-10");
		expect(revision?.actor).toEqual({ tag: "Conductor" });
		expect(revision?.causation_id).toBe(review?.seq);
	}, 600_000);

	it("fails the Evaluation and the Task when the Script's record drops the Lot", async () => {
		const [result] = (
			await trace({ stages: [submission], source: scriptWithoutLot })
		).stages;

		expect(result?.evaluation).toMatchObject({
			passed: false,
			findings: ["Sample: Lot is missing"],
		});
		expect(result?.state).toMatchObject({
			tag: "Failed",
			reason: expect.stringContaining("Sample: Lot is missing"),
		});
		const failed = s.events().at(-1);
		expect(failed?.kind).toBe("TaskFailed");
		expect(failed?.causation_id).toBe(
			s.events().find((e) => e.kind === "EvaluationRecorded")?.seq,
		);
	}, 600_000);

	it("runs each later stage on the previous stage's Artifacts of its input types, after the previous stage's last TaskCompleted, and stops at the first Task that fails", async () => {
		// parse_submission takes only a docx, so a stage that hands it the
		// SubmissionRecord fails.
		const rerun = (number: number): Stage => ({
			...submission,
			number,
			name: "Rerun",
			inputs: ["SubmissionRecord"],
			worked_by: bram,
		});

		const { stages } = await trace({
			stages: [submission, rerun(2), rerun(3)],
		});

		expect(stages.map((r) => [r.stage.number, r.state.tag])).toEqual([
			[1, "Done"],
			[2, "Failed"],
		]);
		const [first, second] = stages;
		const lastOfFirst = s
			.events()
			.filter((e) => e.task_id === first?.task_id)
			.at(-1);
		expect(lastOfFirst?.kind).toBe("TaskCompleted");
		expect(proposed(second?.task_id ?? "")).toMatchObject({
			causation_id: lastOfFirst?.seq,
			payload: { inputs: first?.outputs.map((o) => o.id) },
		});
		expect(second?.run.inputs).toEqual(first?.outputs.map((o) => o.id));
		expect(
			s
				.events()
				.find((e) => e.kind === "TaskAssigned" && e.task_id === second?.task_id)
				?.payload,
			"stage 2 is worked by its own Agent",
		).toMatchObject({ assignee: bram });
		expect(
			s.events().filter((e) => e.kind === "TaskProposed"),
			"no Task for stage 3",
		).toHaveLength(2);
	}, 600_000);

	it("gives a stage the latest Artifact of each carried type that a Done Task's Run wrote, none while there is none, and never one the Operator stored", async () => {
		const carrying: Stage = { ...submission, carried: ["SubmissionRecord"] };
		const secondFixtureId = ArtifactId.parse(
			sha256Hex(readFileSync(secondFixture)),
		);

		const [without] = (await trace({ stages: [carrying] })).stages;
		const record1 = ofType(without?.outputs, "SubmissionRecord");
		const [second] = (
			await trace({ stages: [carrying], formPath: secondFixture })
		).stages;
		const record2 = ofType(second?.outputs, "SubmissionRecord");
		openArtifacts({ ledger: s.ledger, home }).store(
			Buffer.from("{}"),
			{
				artifact_type: "SubmissionRecord",
				media_type: "application/json",
				produced_by: { tag: "Operator" },
				lineage: [],
			},
			{ actor: { tag: "Operator" } },
		);
		const [third] = (await trace({ stages: [carrying] })).stages;

		expect(proposed(without?.task_id ?? "")?.payload).toMatchObject({
			inputs: [fixtureId],
		});
		expect(without?.run.inputs).toEqual([fixtureId]);
		expect(second?.run.inputs).toEqual([secondFixtureId, record1.id]);
		expect(
			proposed(third?.task_id ?? "")?.payload,
			"the later of two Done records, not the Operator's",
		).toMatchObject({ inputs: [fixtureId, record2.id] });
		expect(third?.run.inputs).toEqual([fixtureId, record2.id]);
		expect(third?.state.tag).toBe("Done");
	}, 600_000);

	it("carries the LimsDatabase of the last stage 2 Task that ended Done, not a later version whose Task failed its Evaluation", async () => {
		const receipt = STAGES.slice(0, 2);
		const first = await trace({ stages: receipt });
		const version1 = ofType(first.stages[1]?.outputs, "LimsDatabase");
		const failed = await trace({
			stages: receipt,
			source: scriptWithWrongLot,
			formPath: secondFixture,
		});
		expect(failed.stages[1]?.state.tag).toBe("Failed");
		const rejected = ofType(failed.stages[1]?.outputs, "LimsDatabase");
		expect(rejected.id).not.toBe(version1.id);

		const again = await trace({ stages: receipt, formPath: secondFixture });

		const [submittedAgain, receiptAgain] = again.stages;
		const record2 = ofType(submittedAgain?.outputs, "SubmissionRecord");
		expect(
			receiptAgain?.run.inputs,
			"the version the failed Task's Run wrote is not carried",
		).toEqual([record2.id, version1.id]);
		expect(receiptAgain?.state.tag).toBe("Done");
	}, 600_000);

	it("runs stage 2 on stage 1's record to a Done Task worked by Bram, whose LimsDatabase has the record as its Lineage, and carries that database into the next Fixture's stage 2", async () => {
		const receiptStages = STAGES.slice(0, 2);
		const first = await trace({ stages: receiptStages });

		expect(first.stages.map((r) => [r.stage.number, r.state.tag])).toEqual([
			[1, "Done"],
			[2, "Done"],
		]);
		const [submitted, receipt] = first.stages;
		if (!submitted || !receipt) throw new Error("a stage did not run");
		expect(receipt.state).toEqual({ tag: "Done", assignee: bram });
		expect(receipt.evaluation).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
		expect(receipt.outputs.map((o) => [o.artifact_type, o.filename])).toEqual([
			["LimsDatabase", "lims.sqlite"],
			["Other", "receipt.json"],
			["ReceivingLogRow", "receiving_log_row.xlsx"],
		]);
		const record = ofType(submitted.outputs, "SubmissionRecord");
		const version1 = ofType(receipt.outputs, "LimsDatabase");
		expect(receipt.run.inputs, "no database to carry yet").toEqual([record.id]);
		expect(
			s.ledger.projections.artifacts.artifacts.get(version1.id)?.media_type,
		).toBe("application/vnd.sqlite3");
		expect(
			lineageOf(s.ledger.projections.artifacts, version1.id, {
				tag: "Run",
				id: receipt.run.id,
			}),
		).toEqual([record.id]);
		expect(labReferences(version1)).toEqual(["LR-2026-0001", "LR-2026-0002"]);

		const second = await trace({
			stages: receiptStages,
			formPath: secondFixture,
		});

		const [submittedAgain, receiptAgain] = second.stages;
		if (!submittedAgain || !receiptAgain)
			throw new Error("a stage did not run");
		expect(receiptAgain.state.tag).toBe("Done");
		const record2 = ofType(submittedAgain.outputs, "SubmissionRecord");
		const version2 = ofType(receiptAgain.outputs, "LimsDatabase");
		expect(receiptAgain.run.inputs).toEqual([record2.id, version1.id]);
		expect(
			lineageOf(s.ledger.projections.artifacts, version2.id, {
				tag: "Run",
				id: receiptAgain.run.id,
			}),
		).toEqual([record2.id, version1.id]);
		expect(
			labReferences(version2),
			"seed 2's three containers continue the numbering",
		).toEqual([
			"LR-2026-0001",
			"LR-2026-0002",
			"LR-2026-0003",
			"LR-2026-0004",
			"LR-2026-0005",
		]);
	}, 600_000);

	it("fails stage 2's Evaluation and Task when a copy of log_receipt writes a Lot in the Receiving Log rows that differs from the record's", async () => {
		const { stages } = await trace({ source: scriptWithWrongLot });

		const [, receipt] = stages;
		expect(receipt?.evaluation).toMatchObject({
			passed: false,
			findings: [
				"row 1 (LR-2026-0001): LOT# LT-000000 is not the record's Lot LT-268123",
				"row 2 (LR-2026-0002): LOT# LT-000000 is not the record's Lot LT-268123",
			],
		});
		expect(receipt?.state).toMatchObject({
			tag: "Failed",
			reason: expect.stringContaining("LOT# LT-000000"),
		});
		const failed = s.events().at(-1);
		expect(failed?.kind).toBe("TaskFailed");
		expect(failed?.task_id).toBe(receipt?.task_id);
	}, 600_000);

	it("runs stage 3 on stage 2's Receiving Log row and the database it wrote to a Done Task worked by Bram, whose Work Order lists each Sample's Test and the due date 4 business days after receipt", async () => {
		const { stages } = await trace({ stages: STAGES.slice(0, 3) });

		expect(stages.map((r) => [r.stage.number, r.state.tag])).toEqual([
			[1, "Done"],
			[2, "Done"],
			[3, "Done"],
		]);
		const [, receipt, workOrder] = stages;
		if (!receipt || !workOrder) throw new Error("a stage did not run");
		expect(workOrder.state).toEqual({ tag: "Done", assignee: bram });
		expect(workOrder.evaluation).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
		expect(workOrder.outputs.map((o) => [o.artifact_type, o.filename])).toEqual(
			[
				["LimsDatabase", "lims.sqlite"],
				["Other", "work_order.json"],
				["WorkOrder", "work_order.xlsx"],
			],
		);
		const row = ofType(receipt.outputs, "ReceivingLogRow");
		const version1 = ofType(receipt.outputs, "LimsDatabase");
		expect(workOrder.run.inputs).toEqual([row.id, version1.id]);
		const document = ofType(workOrder.outputs, "WorkOrder");
		expect(
			lineageOf(s.ledger.projections.artifacts, document.id, {
				tag: "Run",
				id: workOrder.run.id,
			}),
		).toEqual([row.id, version1.id]);
		expect(
			query(
				ofType(workOrder.outputs, "LimsDatabase"),
				"SELECT * FROM work_orders ORDER BY lab_reference",
			),
			"seed 1 is Rush3to4Days, received Tuesday 2026-01-06",
		).toEqual(
			["LR-2026-0001", "LR-2026-0002"].map((ref) => [
				"WO-2026-0001",
				ref,
				"Average capsule weight",
				"2026-01-12",
				row.id,
			]),
		);
	}, 600_000);

	it("fails stage 3's Evaluation and Task when a copy of create_work_order writes a due date one day late", async () => {
		const { stages } = await trace({ source: dueDateOneDayLate });

		const [, , workOrder] = stages;
		expect(workOrder?.evaluation).toMatchObject({
			passed: false,
			findings: ["LR-2026-0001", "LR-2026-0002"].map(
				(ref) =>
					`${ref}: due date 2026-01-13 is not 2026-01-12, 4 business days after 2026-01-06 for TAT class Rush3to4Days`,
			),
		});
		expect(workOrder?.state).toMatchObject({
			tag: "Failed",
			reason: expect.stringContaining("due date 2026-01-13"),
		});
		expect(s.events().at(-1)).toMatchObject({
			kind: "TaskFailed",
			task_id: workOrder?.task_id,
		});
	}, 600_000);

	it("fails stage 3's Evaluation and Task when a copy of create_work_order gives a Sample no Test", async () => {
		const { stages } = await trace({ source: lastSampleWithoutTest });

		const [, , workOrder] = stages;
		expect(workOrder?.evaluation).toMatchObject({
			passed: false,
			findings: ["LR-2026-0002: the Work Order has no Test for it"],
		});
		expect(workOrder?.state.tag).toBe("Failed");
		expect(s.events().at(-1)).toMatchObject({
			kind: "TaskFailed",
			task_id: workOrder?.task_id,
		});
	}, 600_000);

	it("stores the weighings beside the Fixture as the Operator's Other with no Lineage, and runs stage 4 on the Work Order, the weighings and stage 3's database to a Done Task worked by Rin, whose Result Worksheet's Lineage names all three", async () => {
		const { stages } = await trace();

		expect(stages.map((r) => [r.stage.number, r.state.tag])).toEqual([
			[1, "Done"],
			[2, "Done"],
			[3, "Done"],
			[4, "Done"],
		]);
		const [, , workOrder, results] = stages;
		if (!workOrder || !results) throw new Error("a stage did not run");
		expect(results.state).toEqual({ tag: "Done", assignee: rin });
		expect(results.evaluation).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
		expect(results.outputs.map((o) => [o.artifact_type, o.filename])).toEqual([
			["LimsDatabase", "lims.sqlite"],
			["Other", "result_worksheet.json"],
			["ResultWorksheet", "result_worksheet.xlsx"],
		]);
		const projection = s.ledger.projections.artifacts;
		const weighings = ArtifactId.parse(
			sha256Hex(readFileSync(fixture.replace(/\.docx$/, ".weighings.json"))),
		);
		expect(projection.artifacts.get(weighings)).toMatchObject({
			artifact_type: "Other",
			media_type: "application/json",
			produced_by: { tag: "Operator" },
			filename: "submission-form-seed1.weighings.json",
		});
		expect(lineageOf(projection, weighings, { tag: "Operator" })).toEqual([]);
		const document = ofType(workOrder.outputs, "WorkOrder");
		const version = ofType(workOrder.outputs, "LimsDatabase");
		expect(
			results.run.inputs,
			"the Work Order, not stage 3's work_order.json, and the weighings",
		).toEqual([document.id, weighings, version.id]);
		const worksheet = ofType(results.outputs, "ResultWorksheet");
		expect(
			lineageOf(projection, worksheet.id, { tag: "Run", id: results.run.id }),
		).toEqual([document.id, weighings, version.id]);
		const events = s.events();
		const lastOfWorkOrder = events
			.filter((e) => e.task_id === workOrder.task_id)
			.at(-1);
		expect(proposed(results.task_id)?.causation_id).toBe(lastOfWorkOrder?.seq);
		expect(
			events.find(
				(e) => e.kind === "ReviewRecorded" && e.task_id === results.task_id,
			)?.actor,
		).toEqual({ tag: "Agent", id: "A-anselm" });
		const rows = query(
			ofType(results.outputs, "LimsDatabase"),
			"SELECT lab_reference, test, value, unit, source_artifact FROM results ORDER BY lab_reference, test",
		);
		const mean = (7.0886 / 20 + 7.2103 / 20) / 2;
		expect(rows.map(([ref, test]) => [ref, test])).toEqual([
			["LR-2026-0001", "Average capsule weight"],
			["LR-2026-0001", "Average capsule weight, Work Order mean"],
			["LR-2026-0002", "Average capsule weight"],
			["LR-2026-0002", "Average capsule weight, Work Order mean"],
		]);
		expect(
			rows.map(([, , value]) => Number(value).toFixed(9)),
			"each container's weight of 20 capsules / 20, and their mean",
		).toEqual([7.0886 / 20, mean, 7.2103 / 20, mean].map((v) => v.toFixed(9)));
		expect(rows.map(([, , , unit, source]) => [unit, source])).toEqual(
			Array(4).fill(["g", weighings]),
		);
	}, 600_000);

	it("fails stage 4's Evaluation and Task when a copy of compute_results types an average in place of its formula", async () => {
		const { stages } = await trace({ source: typedFirstAverage });

		const results = stages[3];
		expect(results?.evaluation).toMatchObject({
			passed: false,
			findings: [
				"row 6 (container 1): Average Weight (g) is 0.35443, not the formula =F6/20",
			],
		});
		expect(results?.state).toMatchObject({
			tag: "Failed",
			reason: expect.stringContaining("not the formula =F6/20"),
		});
		expect(s.events().at(-1)).toMatchObject({
			kind: "TaskFailed",
			task_id: results?.task_id,
		});
	}, 600_000);

	it("fails stage 4's Evaluation and Task when a copy of compute_results writes results rows that disagree with the worksheet", async () => {
		const { stages } = await trace({ source: resultsOneMilligramHigh });

		const results = stages[3];
		expect(results?.evaluation.passed).toBe(false);
		expect(results?.evaluation.findings).toEqual(
			["LR-2026-0001", "LR-2026-0002"].flatMap((ref) => [
				expect.stringMatching(
					new RegExp(
						`^${ref}: results holds [0-9.]+ for Average capsule weight, not`,
					),
				),
				expect.stringMatching(
					new RegExp(
						`^${ref}: results holds [0-9.]+ for Average capsule weight, Work Order mean, not`,
					),
				),
			]),
		);
		expect(results?.state.tag).toBe("Failed");
		expect(s.events().at(-1)).toMatchObject({
			kind: "TaskFailed",
			task_id: results?.task_id,
		});
	}, 600_000);
});
