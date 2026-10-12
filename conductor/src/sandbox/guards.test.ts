import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { type Ledger, openLedger } from "../ledger.js";

const operator = { tag: "Operator" } as const;
const digest = (c: string) => c.repeat(64);
const form = digest("a");
const parsed = digest("b");
const stdout = digest("c");

let home: string;
let ledger: Ledger;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-sandbox-guards-"));
	ledger = openLedger({ home, writer: true });
});

afterEach(() => {
	ledger.close();
	rmSync(home, { recursive: true, force: true });
});

const append = (body: Omit<NewEvent, "actor">) =>
	ledger.append({ actor: operator, ...body } as NewEvent);

const script = (name: string, version: number) => ({
	id: `S-${name}`,
	version,
	name,
	owner_agent: "A-odile",
	input_types: ["SubmissionForm"],
	output_types: ["Other"],
	entrypoint: "main.py",
	fixtures: [],
	image_digest: digest("d"),
});

const artifact = (
	id: string,
	lineage: string[] = [],
	produced_by: object = operator,
) => ({
	kind: "ArtifactStored",
	payload: {
		id,
		sha256: id,
		media_type: "text/plain",
		artifact_type: "Other",
		produced_by,
		lineage,
	},
});

const started = (run_id: string, version = 1) => ({
	kind: "RunStarted",
	payload: {
		run_id,
		script: { id: "S-copy", version },
		inputs: [form],
	},
});

const finished = (id: string) => ({
	kind: "RunFinished",
	payload: {
		id,
		script: { id: "S-copy", version: 1 },
		inputs: [form],
		outputs: [],
		exit_code: 0,
		stdout_ref: stdout,
		stderr_ref: stdout,
		duration_ms: 12,
	},
});

const refused = (body: Omit<NewEvent, "actor">, reason: RegExp) => {
	const before = ledger.all().length;
	expect(() => append(body)).toThrow(AppendRefused);
	expect(() => append(body)).toThrow(reason);
	expect(ledger.all()).toHaveLength(before);
};

describe("sandbox guards", () => {
	it("refuse ArtifactStored whose Lineage names an Artifact the Ledger does not hold", () => {
		refused(artifact(parsed, [form]) as never, /Lineage.*unknown.*a{64}/);
		append(artifact(form) as never);
		append(artifact(parsed, [form]) as never);
	});

	it("refuse ArtifactStored whose sha256 differs from its id, or whose id is already stored", () => {
		refused(
			{
				...artifact(form),
				payload: { ...artifact(form).payload, sha256: parsed },
			} as never,
			/sha256/,
		);
		append(artifact(form) as never);
		refused(artifact(form) as never, /already stored/);
	});

	it("refuse a second ScriptRegistered for a name, and a ScriptRevised that skips a version", () => {
		append({ kind: "ScriptRegistered", payload: script("copy", 1) } as never);
		refused(
			{ kind: "ScriptRegistered", payload: script("copy", 1) } as never,
			/S-copy.*already registered/,
		);
		refused(
			{ kind: "ScriptRevised", payload: script("copy", 3) } as never,
			/version 2/,
		);
		refused(
			{ kind: "ScriptRevised", payload: script("parse", 1) } as never,
			/not registered/,
		);
		append({ kind: "ScriptRevised", payload: script("copy", 2) } as never);
	});

	it("refuse a Script whose id is not S-<name>", () => {
		refused(
			{
				kind: "ScriptRegistered",
				payload: { ...script("copy", 1), id: "S-other" },
			} as never,
			/S-copy/,
		);
	});

	it("refuse RunStarted for a Script version that is not registered", () => {
		refused(started("R-1") as never, /S-copy v1.*not registered/);
	});

	it("refuse RunFinished without a matching RunStarted, and a second RunFinished", () => {
		append({ kind: "ScriptRegistered", payload: script("copy", 1) } as never);
		append(artifact(form) as never);
		append(artifact(stdout) as never);
		refused(finished("R-1") as never, /R-1.*no RunStarted/);
		append(started("R-1") as never);
		refused(started("R-1") as never, /R-1.*already started/);
		append(finished("R-1") as never);
		refused(finished("R-1") as never, /R-1.*already finished/);
	});

	it("refuse RunFinished whose outputs or logs are not stored Artifacts", () => {
		append({ kind: "ScriptRegistered", payload: script("copy", 1) } as never);
		append(artifact(form) as never);
		append(started("R-1") as never);
		refused(finished("R-1") as never, /unknown.*c{64}/);
	});

	it("refuse ArtifactStored produced by a Run that has not started", () => {
		refused(
			artifact(parsed, [], { tag: "Run", id: "R-7" }) as never,
			/R-7.*not started/,
		);
	});
});
