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

/** Every Lab Reference in a toy LIMS database version, in order. */
const labReferences = (database: StageArtifact): string[] => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-tracer-db-"));
	try {
		const path = join(dir, "lims.sqlite");
		writeFileSync(path, database.bytes);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return db
				.prepare("SELECT lab_reference FROM samples ORDER BY lab_reference")
				.all()
				.map((row) => String(row.lab_reference));
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

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

	it("gives a stage the latest Artifact of each carried type, and none while the Ledger holds no Artifact of that type", async () => {
		const carrying: Stage = { ...submission, carried: ["ReceivingLogRow"] };

		const [without] = (await trace({ stages: [carrying] })).stages;
		const artifacts = openArtifacts({ ledger: s.ledger, home });
		const row = (text: string) =>
			artifacts.store(
				Buffer.from(text),
				{
					artifact_type: "ReceivingLogRow",
					media_type: "text/csv",
					produced_by: { tag: "Operator" },
					lineage: [],
				},
				{ actor: { tag: "Operator" } },
			).artifact.id;
		row("LT-0001,1\n");
		const latest = row("LT-0002,2\n");
		const [withRow] = (await trace({ stages: [carrying] })).stages;

		expect(proposed(without?.task_id ?? "")?.payload).toMatchObject({
			inputs: [fixtureId],
		});
		expect(without?.run.inputs).toEqual([fixtureId]);
		expect(proposed(withRow?.task_id ?? "")?.payload).toMatchObject({
			inputs: [fixtureId, latest],
		});
		expect(withRow?.run.inputs).toEqual([fixtureId, latest]);
		expect(withRow?.state.tag).toBe("Done");
	}, 600_000);

	it("runs stage 2 on stage 1's record to a Done Task worked by Bram, whose LimsDatabase has the record as its Lineage, and carries that database into the next Fixture's stage 2", async () => {
		const first = await trace();

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

		const second = await trace({ formPath: secondFixture });

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
});
