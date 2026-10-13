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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../events.js";
import { sha256Hex } from "../hash.js";
import { AgentId, ArtifactId, type Sha256 } from "../ids.js";
import { lineageOf } from "../sandbox/artifacts.js";
import { buildImage, scriptsRoot } from "../sandbox/image.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";
import { ensureScript, reviewerOf, runStage1 } from "./tracer.js";

const rin = AgentId.parse("A-rin");
const pia = { tag: "Agent", id: "A-pia" } as const;

const suite = dockerAvailable
	? "the stage 1 tracer (Docker)"
	: "the stage 1 tracer: SKIPPED because `docker info` failed; start Docker to run these";

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

describe("the stage 1 tracer's reviewer", () => {
	it("is a Specialist's Supervisor, and the Operator for an Agent with none", () => {
		const { projections } = s.ledger;

		expect(reviewerOf(projections, rin)).toEqual(pia);
		expect(reviewerOf(projections, AgentId.parse("A-odile"))).toEqual({
			tag: "Operator",
		});
	});
});

/** Run stage 1 on the Fixture with the Script in `source`, owned by A-rin. */
const trace = (source = join(scriptsRoot, "parse_submission")) => {
	const script = ensureScript({
		ledger: s.ledger,
		home,
		source,
		owner: rin,
		image,
	});
	return runStage1({
		ledger: s.ledger,
		home,
		formPath: fixture,
		script: { id: script.id, version: script.version },
		owner: rin,
		timeoutMs: 60_000,
	});
};

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

describe.skipIf(!requireDocker())(suite, () => {
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: "aliquot-sandbox:test" }));
	}, 600_000);

	it("completes the Fixture's Task through Review, each Event from TaskProposed on naming the one before it", async () => {
		const result = await trace();

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
		// A-rin is on Probation, so its Supervisor A-pia reviews every Task.
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

	it("gives the record a Lineage of the Fixture, and the Fixture, stored as the Operator's SubmissionForm, an empty Lineage", async () => {
		const { record, run } = await trace();
		if (!record) throw new Error(`${run.id} wrote no submission.json`);

		const projection = s.ledger.projections.artifacts;
		expect(lineageOf(projection, record, { tag: "Run", id: run.id })).toEqual([
			fixtureId,
		]);
		expect(projection.artifacts.get(fixtureId)).toMatchObject({
			artifact_type: "SubmissionForm",
			produced_by: { tag: "Operator" },
		});
		expect(lineageOf(projection, fixtureId, { tag: "Operator" })).toEqual([]);
	}, 600_000);

	it("returns the Trust tier Revision that the tracer's Review earns, caused by that Review", async () => {
		// Rin has 9 reviewed Tasks, so the tracer's Review of T-10 is the 10th.
		for (let i = 0; i < 9; i++) s.reviewed(rin, scores(3));

		const result = await trace();

		expect(result.task_id).toBe("T-10");
		expect(result.revisions).toMatchObject([
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
		const result = await trace(scriptWithoutLot());

		expect(result.evaluation).toMatchObject({
			passed: false,
			findings: ["Sample: Lot is missing"],
		});
		expect(result.state).toMatchObject({
			tag: "Failed",
			reason: expect.stringContaining("Sample: Lot is missing"),
		});
		const failed = s.events().at(-1);
		expect(failed?.kind).toBe("TaskFailed");
		expect(failed?.causation_id).toBe(
			s.events().find((e) => e.kind === "EvaluationRecorded")?.seq,
		);
	}, 600_000);
});
