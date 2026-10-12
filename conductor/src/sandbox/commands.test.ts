import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

let home: string;
let file: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-sandbox-cli-"));
	file = join(home, "submission_form.docx");
	writeFileSync(file, "Date Submitted: 10/12/2026\n");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot sandbox store and artifacts", () => {
	it("stores an Operator file once by sha256 and lists it with its Lineage", () => {
		const first = aliquot("sandbox", "store", file, "--type", "SubmissionForm");
		const second = aliquot(
			"sandbox",
			"store",
			file,
			"--type",
			"SubmissionForm",
		);

		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(first.stdout).toBe(
			"397ec95583578116203359d83765a9858213da59fa537356d290521a91c239ad\n",
		);
		expect(second.stdout).toBe(first.stdout);

		const listed = aliquot("sandbox", "artifacts");
		expect(listed.status).toBe(0);
		expect(listed.stdout).toBe(
			[
				"397ec95583578116203359d83765a9858213da59fa537356d290521a91c239ad",
				"  type SubmissionForm, application/vnd.openxmlformats-officedocument.wordprocessingml.document, submission_form.docx",
				"  produced by Operator; lineage: none",
				"",
			].join("\n"),
		);

		const cat = aliquot("sandbox", "cat", first.stdout.trim());
		expect(cat.stdout).toBe("Date Submitted: 10/12/2026\n");

		const verify = aliquot("ledger", "verify");
		expect(verify.stdout).toBe("Ledger verified: 1 Event, chain intact\n");
	});

	it("refuses an unknown Artifact type as a usage error", () => {
		const result = aliquot("sandbox", "store", file, "--type", "Spreadsheet");
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/Spreadsheet/);
	});
});
