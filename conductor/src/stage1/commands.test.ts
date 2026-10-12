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
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import type { Event } from "../events.js";
import { sha256Hex } from "../hash.js";
import { AgentId, ArtifactId, RunId, TaskId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { fold } from "../reduce.js";
import { lineageOf, projectArtifacts } from "../sandbox/artifacts.js";
import { scriptsRoot } from "../sandbox/image.js";
import { projectRuns } from "../sandbox/runs.js";
import { TaskProjection } from "../task/projection.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { scenario, scores } from "../vitality/scenario.js";
import { stage1Commands } from "./commands.js";

const suite = dockerAvailable
	? "aliquot stage1 (Docker)"
	: "aliquot stage1: SKIPPED because `docker info` failed; start Docker to run these";

const fixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const fixtureId = ArtifactId.parse(sha256Hex(readFileSync(fixture)));

let home: string;
let scratch: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-stage1-"));
	scratch = mkdtempSync(join(tmpdir(), "aliquot-stage1-scratch-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

const run = async (name: "run" | "run-all", args: string[]) => {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const out: Buffer[] = [];
	stdout.on("data", (chunk: Buffer) => out.push(chunk));
	stderr.resume();
	const ctx: CommandContext = {
		home,
		stdin: Readable.from([]),
		stdout,
		stderr,
	};
	const code = await stage1Commands[name]?.run(args, ctx);
	return { code, stdout: Buffer.concat(out).toString("utf8") };
};

const readLedger = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return { events: ledger.all(), verify: ledger.verify() };
	} finally {
		ledger.close();
	}
};

const taskState = (events: Event[], id: string) =>
	fold(events, TaskProjection.reduce, TaskProjection.init).tasks.get(
		TaskId.parse(id),
	)?.state;

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
const brokenScript = () => {
	const dir = join(scratch, "parse_submission_without_lot");
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
	it("runs the Fixture through parse_submission and completes the Task, linked by causation_id from TaskProposed to TaskCompleted", async () => {
		const result = await run("run", [fixture]);

		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/T-1 Done/);
		const { events, verify } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState(events, "T-1")).toEqual({ tag: "Done" });

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
		// A-rin is on Probation, so its Supervisor A-pia reviews every Task.
		const pia = { tag: "Agent", id: "A-pia" };
		const [submitted, review, reviewed] = chain.slice(-3);
		expect(submitted?.payload).toMatchObject({
			review: { tag: "Required", reviewer: pia },
		});
		expect(review?.actor).toEqual(pia);
		expect(review?.payload).toMatchObject({
			reviewer: pia,
			quality: 3,
			traceability: 3,
			boundary_adherence: 3,
			collaboration: 3,
			timeliness: 3,
		});
		expect(reviewed?.actor).toEqual(pia);
		expect(reviewed?.payload).toMatchObject({ review: { tag: "Reviewed" } });
		const [fixtureStored] = chain;
		expect(
			fixtureStored?.kind === "ArtifactStored" && fixtureStored.payload.id,
		).toBe(fixtureId);
		// Every Event of the Task, chain or not, has its cause inside the Task.
		const taskEvents = events.filter((e) => e.task_id === "T-1");
		const taskSeqs = new Set(taskEvents.map((e) => Number(e.seq)));
		for (const e of taskEvents.filter((e) => e.kind !== "TaskProposed")) {
			expect(taskSeqs.has(Number(e.causation_id))).toBe(true);
		}

		const evaluation = chain.find((e) => e.kind === "EvaluationRecorded");
		expect(evaluation?.payload).toMatchObject({
			run_id: "R-1",
			task_id: "T-1",
			score: 1,
			passed: true,
			findings: [],
		});
	}, 600_000);

	it("revises the owner's Trust tier right after the tracer's Review earns it", async () => {
		// Rin has 9 reviewed Tasks, so the tracer's Review of T-10 is the 10th.
		rmSync(home, { recursive: true, force: true });
		const s = scenario();
		for (let i = 0; i < 9; i++) s.reviewed(AgentId.parse("A-rin"), scores(3));
		s.ledger.close();
		home = s.home;

		const result = await run("run", [fixture]);

		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/T-10 Done/);
		expect(result.stdout).toMatch(
			/\n {2}revised {3}A-rin to version 2: Trust tier Probation -> Trusted: /,
		);
		const { events, verify } = readLedger();
		expect(verify.ok).toBe(true);
		const review = events.filter((e) => e.kind === "ReviewRecorded").at(-1);
		const revision = events.find((e) => e.seq === (review?.seq ?? 0) + 1);
		expect(review?.task_id).toBe("T-10");
		expect(revision?.kind).toBe("AgentDefinitionRevised");
		expect(revision?.actor).toEqual({ tag: "Conductor" });
		expect(revision?.causation_id).toBe(review?.seq);
		expect(revision?.payload).toMatchObject({
			definition: { id: "A-rin", version: 2, trust_tier: "Trusted" },
		});
	}, 600_000);

	it("gives the output Artifact a Lineage of the Fixture, and the Fixture an empty Lineage", async () => {
		await run("run", [fixture]);

		const ledger = openLedger({ home, writer: false });
		try {
			const projection = projectArtifacts(ledger);
			const finished = projectRuns(ledger).runs.get(
				RunId.parse("R-1"),
			)?.finished;
			const output = finished?.outputs.find(
				(id) => projection.artifacts.get(id)?.filename === "submission.json",
			);
			if (!finished || !output) throw new Error("R-1 wrote no submission.json");
			expect(
				lineageOf(projection, output, { tag: "Run", id: finished.id }),
			).toEqual([fixtureId]);
			expect(projection.artifacts.get(fixtureId)).toMatchObject({
				artifact_type: "SubmissionForm",
				produced_by: { tag: "Operator" },
			});
			expect(lineageOf(projection, fixtureId, { tag: "Operator" })).toEqual([]);
		} finally {
			ledger.close();
		}
	}, 600_000);

	it("fails the Evaluation and the Task when the Script's record drops the Lot", async () => {
		const result = await run("run", [fixture, "--script-dir", brokenScript()]);

		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/T-1 Failed/);
		const { events, verify } = readLedger();
		expect(verify.ok).toBe(true);
		const evaluation = events.find((e) => e.kind === "EvaluationRecorded");
		expect(evaluation?.payload).toMatchObject({
			passed: false,
			findings: ["Sample: Lot is missing"],
		});
		expect(taskState(events, "T-1")).toMatchObject({
			tag: "Failed",
			reason: expect.stringContaining("Sample: Lot is missing"),
		});
	}, 600_000);

	it("run-all runs every docx in a directory and exits 1 when any Evaluation fails", async () => {
		const dir = join(scratch, "fixtures");
		mkdirSync(dir);
		copyFileSync(fixture, join(dir, "a-good.docx"));
		writeFileSync(join(dir, "b-not-a-docx.docx"), "not a zip archive\n");
		writeFileSync(join(dir, "notes.txt"), "ignored\n");

		const result = await run("run-all", [dir]);

		expect(result.code).toBe(1);
		const { events, verify } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState(events, "T-1")).toEqual({ tag: "Done" });
		expect(taskState(events, "T-2")?.tag).toBe("Failed");
		expect(taskState(events, "T-3")).toBeUndefined();
		// One registration serves every Fixture in the batch.
		expect(
			events.filter(
				(e) => e.kind === "ScriptRegistered" || e.kind === "ScriptRevised",
			),
		).toHaveLength(1);
	}, 600_000);
});
