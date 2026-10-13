import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, Sha256 } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { openArtifacts, walkLineage } from "./artifacts.js";
import { register, startRun, store } from "./lifecycle.js";

const operator = { tag: "Operator" } as const;
const form = {
	artifact_type: "SubmissionForm",
	media_type:
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	produced_by: operator,
	lineage: [],
} as const;

let home: string;
let ledger: Ledger;

// The blobs are files under `home`; the Ledger that records them is in memory.
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-artifacts-"));
	ledger = openMemoryLedger();
});

afterEach(() => {
	ledger.close();
	rmSync(home, { recursive: true, force: true });
});

const storedEvents = () =>
	ledger.all().filter((e) => e.kind === "ArtifactStored");

describe("blob store", () => {
	it("gives the same bytes one id and records ArtifactStored only the first time", () => {
		const artifacts = openArtifacts({ ledger, home });
		const bytes = Buffer.from("Date Submitted: 10/12/2026\n");

		const first = artifacts.store(bytes, form, { actor: operator });
		const second = artifacts.store(Buffer.from(bytes), form, {
			actor: operator,
		});

		expect(first.artifact.id).toBe(
			"397ec95583578116203359d83765a9858213da59fa537356d290521a91c239ad",
		);
		expect(second, "the same record and seq").toEqual(first);
		expect(
			storedEvents().map((e) => e.seq),
			"one ArtifactStored, at the seq store returned",
		).toEqual([first.seq]);
	});

	it("reads the bytes back and refuses a blob whose bytes no longer match its id", () => {
		const artifacts = openArtifacts({ ledger, home });
		const { artifact: stored } = artifacts.store(
			Buffer.from("lot LT-0042\n"),
			form,
			{ actor: operator },
		);
		expect(artifacts.read(stored.id).toString()).toBe("lot LT-0042\n");

		chmodSync(artifacts.path(stored.id), 0o644);
		writeFileSync(artifacts.path(stored.id), "lot LT-0043\n");
		expect(() => artifacts.read(stored.id)).toThrow(
			/ArtifactCorrupt|hashes to/,
		);
	});
});

describe("artifact projection", () => {
	it("projects ArtifactStored Events into Artifacts with their filename and Lineage", () => {
		const artifacts = openArtifacts({ ledger, home });
		const { artifact: input } = artifacts.store(
			Buffer.from("form"),
			{ ...form, filename: "submission_form.docx" },
			{ actor: operator },
		);
		const { artifact: output } = artifacts.store(
			Buffer.from("{}"),
			{
				artifact_type: "Other",
				media_type: "application/json",
				produced_by: operator,
				lineage: [input.id],
				filename: "parsed.json",
			},
			{ actor: operator },
		);

		const { artifacts: byId } = ledger.projections.artifacts;

		expect([...byId.keys()]).toEqual([input.id, output.id]);
		expect(byId.get(input.id)).toMatchObject({
			filename: "submission_form.docx",
			artifact_type: "SubmissionForm",
			lineage: [],
		});
		expect(byId.get(output.id)).toMatchObject({
			filename: "parsed.json",
			lineage: [input.id],
			sha256: output.id,
		});
	});
});

describe("walkLineage", () => {
	it("walks each production back through its Lineage to the Artifacts that have none, and does not walk an Artifact already on the path again", () => {
		const { script } = register(ledger, {
			actor: operator,
			name: "copy",
			owner_agent: AgentId.parse("A-odile"),
			input_types: ["SubmissionForm"],
			output_types: ["SubmissionRecord"],
			entrypoint: "main.py",
			image_digest: Sha256.parse("d".repeat(64)),
		});
		const formSha = Sha256.parse("a".repeat(64));
		const { id: formId } = store(
			ledger,
			{ actor: operator },
			{ ...form, sha256: formSha },
		).artifact;
		const { run_id } = startRun(ledger, {
			actor: operator,
			script,
			inputs: [formId],
		});
		const byRun = { tag: "Run", id: run_id } as const;
		const { id: recordId } = store(
			ledger,
			{ actor: operator },
			{
				...form,
				sha256: Sha256.parse("b".repeat(64)),
				artifact_type: "SubmissionRecord",
				produced_by: byRun,
				lineage: [formId],
			},
		).artifact;
		// The Run also writes back its own input, a second production of it.
		store(
			ledger,
			{ actor: operator },
			{ ...form, sha256: formSha, produced_by: byRun, lineage: [formId] },
		);

		const walked = (id: typeof formId) =>
			walkLineage(ledger.projections.artifacts, id).map(
				({ depth, production: { record } }) => [
					depth,
					record.id,
					record.produced_by,
				],
			);

		expect(walked(recordId)).toEqual([
			[0, recordId, byRun],
			[1, formId, operator],
			[1, formId, byRun],
		]);
		expect(walked(formId)).toEqual([
			[0, formId, operator],
			[0, formId, byRun],
		]);
	});
});
