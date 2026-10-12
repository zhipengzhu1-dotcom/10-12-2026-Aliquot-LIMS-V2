import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Ledger, openLedger } from "../ledger.js";
import { fold } from "../reduce.js";
import { artifactProjection, openArtifacts } from "./artifacts.js";

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

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-artifacts-"));
	ledger = openLedger({ home, writer: true });
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

		expect(first.id).toBe(
			"397ec95583578116203359d83765a9858213da59fa537356d290521a91c239ad",
		);
		expect(second).toEqual(first);
		expect(storedEvents()).toHaveLength(1);
	});

	it("reads the bytes back and refuses a blob whose bytes no longer match its id", () => {
		const artifacts = openArtifacts({ ledger, home });
		const stored = artifacts.store(Buffer.from("lot LT-0042\n"), form, {
			actor: operator,
		});
		expect(artifacts.read(stored.id).toString()).toBe("lot LT-0042\n");

		chmodSync(artifacts.path(stored.id), 0o644);
		writeFileSync(artifacts.path(stored.id), "lot LT-0043\n");
		expect(() => artifacts.read(stored.id)).toThrow(
			/ArtifactCorrupt|hashes to/,
		);
	});
});

describe("artifact projection", () => {
	it("folds ArtifactStored Events into Artifacts with their filename and Lineage", () => {
		const artifacts = openArtifacts({ ledger, home });
		const input = artifacts.store(
			Buffer.from("form"),
			{ ...form, filename: "submission_form.docx" },
			{ actor: operator },
		);
		const output = artifacts.store(
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

		const { artifacts: byId } = fold(
			ledger.all(),
			artifactProjection.reduce,
			artifactProjection.init,
		);

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
