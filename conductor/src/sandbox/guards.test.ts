import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { AgentId, Sha256 } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { register, startRun, store } from "./lifecycle.js";

// The Sandbox lifecycle never builds these Events, so each is written by
// hand to show the Ledger refuses it from any writer.

const operator = { tag: "Operator" } as const;
const form = "a".repeat(64);

let ledger: Ledger;

beforeEach(() => {
	ledger = openMemoryLedger();
});

afterEach(() => ledger.close());

const script = (name: string, version: number) => ({
	id: `S-${name}`,
	version,
	name,
	owner_agent: "A-odile",
	input_types: ["SubmissionForm"],
	output_types: ["Other"],
	entrypoint: "main.py",
	fixtures: [],
	image_digest: "d".repeat(64),
});

const registerCopy = () =>
	register(ledger, {
		actor: operator,
		name: "copy",
		owner_agent: AgentId.parse("A-odile"),
		input_types: ["SubmissionForm"],
		output_types: ["Other"],
		entrypoint: "main.py",
		image_digest: Sha256.parse("d".repeat(64)),
	}).script;

const storeForm = (produced_by: object = operator) =>
	store(
		ledger,
		{ actor: operator },
		{
			sha256: Sha256.parse(form),
			media_type: "text/plain",
			artifact_type: "Other",
			produced_by: produced_by as never,
			lineage: [],
		},
	).artifact;

const refused = (body: object, reason: RegExp) => {
	const append = () => ledger.append({ actor: operator, ...body } as NewEvent);
	const before = ledger.all().length;
	expect(append).toThrow(AppendRefused);
	expect(append).toThrow(reason);
	expect(ledger.all()).toHaveLength(before);
};

describe("sandbox guards", () => {
	it("refuse ArtifactStored whose sha256 differs from its id, or whose id the Operator already stored", () => {
		refused(
			{
				kind: "ArtifactStored",
				payload: {
					id: form,
					sha256: "b".repeat(64),
					media_type: "text/plain",
					artifact_type: "Other",
					produced_by: operator,
					lineage: [],
				},
			},
			/sha256/,
		);
		const stored = storeForm();
		refused({ kind: "ArtifactStored", payload: stored }, /already stored/);
	});

	it("refuse a second ArtifactStored of the same bytes by the same Run", () => {
		const copy = registerCopy();
		storeForm();
		const { run_id } = startRun(ledger, {
			actor: operator,
			script: copy,
			inputs: [],
		});
		const byRun = storeForm({ tag: "Run", id: run_id });
		refused(
			{ kind: "ArtifactStored", payload: byRun },
			new RegExp(`${run_id} already stored`),
		);
	});

	it("refuse a second ScriptRegistered for a name, and a ScriptRevised that skips a version or names no Script", () => {
		registerCopy();
		refused(
			{ kind: "ScriptRegistered", payload: script("copy", 1) },
			/S-copy.*already registered/,
		);
		refused({ kind: "ScriptRevised", payload: script("copy", 3) }, /version 2/);
		refused(
			{ kind: "ScriptRevised", payload: script("parse", 1) },
			/not registered/,
		);
	});

	it("refuse a Script whose id is not S-<name>", () => {
		refused(
			{
				kind: "ScriptRegistered",
				payload: { ...script("copy", 1), id: "S-other" },
			},
			/S-copy/,
		);
	});

	it("refuse a second RunStarted for a Run id", () => {
		const copy = registerCopy();
		const { run_id, script: ref } = startRun(ledger, {
			actor: operator,
			script: copy,
			inputs: [],
		});
		refused(
			{ kind: "RunStarted", payload: { run_id, script: ref, inputs: [] } },
			new RegExp(`${run_id}.*already started`),
		);
	});
});
