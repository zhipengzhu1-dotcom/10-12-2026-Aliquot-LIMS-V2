import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, ArtifactId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import { startTurn } from "../turn/lifecycle.js";
import { turnPrompt } from "../turn/prompt.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const fixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);

let home: string;

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
	);

const eventCount = () => {
	const ledger = openLedger({ home, writer: false });
	const count = ledger.all().length;
	ledger.close();
	return count;
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-intake-"));
	const ledger = openLedger({ home, writer: true });
	seedOrg(ledger);
	ledger.close();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot intake", () => {
	it("stores a Submission Form as the Operator's Artifact, lists it in the Director's prompt, and appends nothing the second time", () => {
		const id = createHash("sha256").update(readFileSync(fixture)).digest("hex");
		const before = eventCount();

		const first = aliquot("intake", fixture);
		const afterFirst = eventCount();
		const second = aliquot("intake", fixture);

		expect(first.stderr).toBe("");
		expect(first.stdout).toBe(
			`Stored ${id} SubmissionForm submission-form-seed1.docx\n`,
		);
		expect(afterFirst).toBe(before + 1);
		expect(second.stdout).toBe(`${id} is already stored; nothing appended\n`);
		expect(eventCount(), "the second intake appends nothing").toBe(afterFirst);

		const ledger = openLedger({ home, writer: true });
		const stored = ledger.projections.artifacts.artifacts.get(
			ArtifactId.parse(id),
		);
		const { turn } = startTurn(ledger, {
			agent: AgentId.parse("A-odile"),
			model: "claude-opus-5-5",
			energyBudgetTokens: 1_000_000,
		});
		const prompt = turnPrompt(ledger.projections, turn, ledger.now());
		ledger.close();

		expect(stored).toMatchObject({
			artifact_type: "SubmissionForm",
			produced_by: { tag: "Operator" },
			media_type:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});
		expect(prompt.work).toContain(
			`## Submission Forms no Task has been proposed for\n\n- ${id} submission-form-seed1.docx`,
		);
	});

	it("refuses a file that is not a .docx", () => {
		const refused = aliquot("intake", "form.pdf");

		expect(refused.status).toBe(2);
		expect(refused.stderr).toMatch(
			/^UsageError: intake takes a Submission Form as a \.docx file, not "form\.pdf"\n/,
		);
	});
});
