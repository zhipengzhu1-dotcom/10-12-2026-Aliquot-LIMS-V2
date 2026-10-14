import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, ArtifactId, RunId, ScriptId, Sha256 } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import { assign, propose, start } from "../task/lifecycle.js";
import { TEST_OPERATOR } from "../test-support/operator.js";
import type { Actor } from "../types/actor.js";
import { lineageOf } from "./artifacts.js";
import { finishRun, register, startRun, store } from "./lifecycle.js";

const operator: Actor = { tag: "Operator" };
const copy = {
	actor: operator,
	name: "copy",
	owner_agent: AgentId.parse("A-odile"),
	input_types: ["Other"],
	output_types: ["Other"],
	entrypoint: "main.py",
	image_digest: Sha256.parse("d".repeat(64)),
} as const;

let ledger: Ledger;
beforeEach(() => {
	ledger = openMemoryLedger();
});
afterEach(() => ledger.close());

const lot = Sha256.parse("a".repeat(64));
const form = {
	sha256: lot,
	artifact_type: "SubmissionForm",
	media_type: "text/plain",
	produced_by: operator,
	lineage: [],
	filename: "lot.txt",
} as const;

const eventAt = (seq: number) => ledger.all().find((e) => e.seq === seq);

describe("the Sandbox lifecycle", () => {
	it("registers a new Script name at version 1 and revises it to the next version, naming the version before as the cause", () => {
		const registered = register(ledger, copy);
		const revised = register(ledger, {
			...copy,
			image_digest: Sha256.parse("e".repeat(64)),
		});

		expect(registered.script).toMatchObject({ id: "S-copy", version: 1 });
		expect(revised.script).toMatchObject({
			id: "S-copy",
			version: 2,
			image_digest: "e".repeat(64),
		});
		expect(eventAt(registered.seq)).toMatchObject({
			kind: "ScriptRegistered",
			payload: registered.script,
		});
		expect(eventAt(registered.seq)?.causation_id).toBeUndefined();
		expect(eventAt(revised.seq)).toMatchObject({
			kind: "ScriptRevised",
			causation_id: registered.seq,
			payload: revised.script,
		});
	});

	it("stores bytes the Operator gives once, and returns the first ArtifactStored for the same bytes again without appending", () => {
		const stored = store(ledger, { actor: operator }, form);
		const before = ledger.all().length;
		const again = store(
			ledger,
			{ actor: operator },
			{ ...form, filename: "again.txt" },
		);

		expect(stored.artifact).toEqual({ ...form, id: lot, lineage: [] });
		expect(eventAt(stored.seq)).toMatchObject({
			kind: "ArtifactStored",
			payload: stored.artifact,
		});
		expect(eventAt(stored.seq)?.causation_id).toBeUndefined();
		expect(again).toEqual(stored);
		expect(ledger.all()).toHaveLength(before);
	});

	it("refuses an Artifact produced by a Run that has not started, before building the Event", () => {
		const before = ledger.all().length;
		const byRun = () =>
			store(
				ledger,
				{ actor: operator },
				{ ...form, produced_by: { tag: "Run", id: RunId.parse("R-7") } },
			);

		expect(byRun).toThrow(AppendRefused);
		expect(byRun).toThrow("ArtifactStored refused: R-7 has not started");
		expect(ledger.all()).toHaveLength(before);
	});

	it("starts a Run under the next free Run id on the caller's cause, and names its RunStarted and Task as the cause and Task of every Artifact it produces and of its RunFinished", () => {
		seedOrg(ledger, TEST_OPERATOR);
		const odile: Actor = { tag: "Agent", id: copy.owner_agent };
		const task_id = propose(ledger, {
			actor: operator,
			title: "Copy the lot",
			goal: "Copy it",
			tat_class: "Regular",
			priority: 1,
		}).task.id;
		assign(ledger, { actor: operator, task_id, assignee: copy.owner_agent });
		const taskStarted = start(ledger, { actor: odile, task_id });
		const { script } = register(ledger, copy);
		const input = store(ledger, { actor: operator }, form);

		const started = startRun(ledger, {
			actor: odile,
			task_id,
			causation_id: taskStarted.seq,
			script: { id: script.id, version: script.version },
			inputs: [input.artifact.id],
		});
		const byRun = { tag: "Run", id: started.run_id } as const;
		const copied = store(
			ledger,
			{ actor: odile },
			{ ...form, produced_by: byRun, lineage: [input.artifact.id] },
		);
		const log = store(
			ledger,
			{ actor: odile },
			{
				...form,
				sha256: Sha256.parse("c".repeat(64)),
				artifact_type: "Other",
				produced_by: byRun,
				lineage: [input.artifact.id],
				filename: "stdout.txt",
			},
		);
		const run = {
			id: started.run_id,
			script: started.script,
			inputs: [input.artifact.id],
			outputs: [copied.artifact.id],
			exit_code: 0,
			stdout_ref: log.artifact.id,
			stderr_ref: log.artifact.id,
			duration_ms: 5,
		};
		const finished = finishRun(ledger, { actor: odile, run });

		expect(started.run_id).toBe("R-1");
		expect(eventAt(started.seq)).toMatchObject({
			kind: "RunStarted",
			task_id,
			causation_id: taskStarted.seq,
			payload: {
				run_id: "R-1",
				script: { id: "S-copy", version: 1 },
				inputs: [input.artifact.id],
			},
		});
		for (const produced of [copied, log]) {
			expect(eventAt(produced.seq)).toMatchObject({
				kind: "ArtifactStored",
				task_id,
				causation_id: started.seq,
				payload: produced.artifact,
			});
		}
		expect(copied.seq).not.toBe(input.seq);
		expect(finished.run).toEqual(run);
		expect(eventAt(finished.seq)).toMatchObject({
			kind: "RunFinished",
			task_id,
			causation_id: started.seq,
			payload: run,
		});
		expect(startRun(ledger, { actor: odile, script, inputs: [] }).run_id).toBe(
			"R-2",
		);
	});

	it("refuses to finish a Run that never started, before building the Event", () => {
		const before = ledger.all().length;
		const finish = () =>
			finishRun(ledger, {
				actor: operator,
				run: {
					id: RunId.parse("R-1"),
					script: { id: ScriptId.parse("S-copy"), version: 1 },
					inputs: [],
					outputs: [],
					exit_code: 0,
					stdout_ref: ArtifactId.parse(lot),
					stderr_ref: ArtifactId.parse(lot),
					duration_ms: 5,
				},
			});

		expect(finish).toThrow(AppendRefused);
		expect(finish).toThrow("RunFinished refused: R-1 has no RunStarted");
		expect(ledger.all()).toHaveLength(before);
	});

	it("stores each Run's production of bytes the Ledger already holds once, and keeps the Operator's ArtifactStored first", () => {
		const { script } = register(ledger, copy);
		const input = store(ledger, { actor: operator }, form);
		const { id } = input.artifact;
		const { run_id } = startRun(ledger, {
			actor: operator,
			script,
			inputs: [id],
		});
		const byRun = {
			...form,
			produced_by: { tag: "Run", id: run_id },
			lineage: [id],
		} as const;

		const copied = store(ledger, { actor: operator }, byRun);
		const again = store(ledger, { actor: operator }, byRun);
		const byOperator = store(ledger, { actor: operator }, form);

		expect(copied.artifact).toEqual({ ...byRun, id });
		expect(copied.seq).toBeGreaterThan(input.seq);
		expect(again).toEqual(copied);
		expect(byOperator).toEqual(input);
		const projection = ledger.projections.artifacts;
		expect(projection.artifacts.get(id)).toEqual(input.artifact);
		expect(projection.productions.get(id)).toEqual([
			{ seq: input.seq, record: input.artifact },
			{ seq: copied.seq, record: copied.artifact },
		]);
		expect(lineageOf(projection, id)).toEqual([]);
		expect(lineageOf(projection, id, { tag: "Run", id: run_id })).toEqual([id]);
		expect(
			lineageOf(projection, id, { tag: "Run", id: RunId.parse("R-9") }),
		).toBeUndefined();
	});
});

describe("the Sandbox lifecycle's refusals", () => {
	const refused = (verb: () => unknown, text: string) => {
		const before = ledger.all().length;
		expect(verb).toThrow(AppendRefused);
		expect(verb).toThrow(text);
		expect(ledger.all()).toHaveLength(before);
	};
	const parsed = Sha256.parse("b".repeat(64));
	const unknown = ArtifactId.parse(parsed);

	it("refuses an Artifact whose Lineage names an Artifact the Ledger does not hold", () => {
		refused(
			() => store(ledger, { actor: operator }, { ...form, lineage: [unknown] }),
			`ArtifactStored refused: Lineage of ${lot} names unknown Artifacts ${unknown}`,
		);
	});

	it("refuses a Run of a Script version that is not registered", () => {
		refused(
			() =>
				startRun(ledger, {
					actor: operator,
					script: { id: ScriptId.parse("S-copy"), version: 1 },
					inputs: [],
				}),
			"RunStarted refused: S-copy v1 is not registered",
		);
	});

	it("refuses a RunFinished whose outputs are not stored, a second RunFinished, and an Artifact from a finished Run", () => {
		const { script } = register(ledger, copy);
		const { artifact } = store(ledger, { actor: operator }, form);
		const { run_id } = startRun(ledger, {
			actor: operator,
			script,
			inputs: [],
		});
		const run = {
			id: run_id,
			script: { id: script.id, version: script.version },
			inputs: [],
			outputs: [unknown],
			exit_code: 0,
			stdout_ref: artifact.id,
			stderr_ref: artifact.id,
			duration_ms: 5,
		};

		refused(
			() => finishRun(ledger, { actor: operator, run }),
			`RunFinished refused: ${run_id} names unknown Artifacts ${unknown}`,
		);
		finishRun(ledger, { actor: operator, run: { ...run, outputs: [] } });
		refused(
			() =>
				finishRun(ledger, { actor: operator, run: { ...run, outputs: [] } }),
			`RunFinished refused: ${run_id} has already finished`,
		);
		refused(
			() =>
				store(
					ledger,
					{ actor: operator },
					{ ...form, sha256: parsed, produced_by: { tag: "Run", id: run_id } },
				),
			`ArtifactStored refused: ${run_id} has already finished`,
		);
	});
});
