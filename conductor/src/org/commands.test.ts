import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rosterDefinitions } from "./seed.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

let home: string;

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, ALIQUOT_HOME: "" },
		},
	);
const org = (...args: string[]) => aliquot("org", ...args);

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-org-cli-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot org", () => {
	it("seeds the roster once and prints the tree", () => {
		const first = org("seed");
		const second = org("seed");
		const printed = org("tree");

		expect(first.stderr).toBe("");
		expect(first.stdout).toBe(
			"Recruited 8 Agents: A-odile, A-mabel, A-thorne, A-pia, A-anselm, A-rin, A-ines, A-bram\n",
		);
		expect(second.status).toBe(0);
		expect(second.stdout).toBe(
			"Org already seeded: all 8 roster Agents are in the Ledger, nothing appended\n",
		);
		expect(printed.status).toBe(0);
		expect(printed.stdout).toBe(`Operator
+-- Odile, Director, Probation
|   +-- Pia, Supervisor, Probation
|   +-- Anselm, Supervisor, Probation
|   \\-- Specialist pool, reports to Pia and Anselm
|       +-- Rin, Specialist, Probation
|       +-- Ines, Specialist, Probation
|       \\-- Bram, Specialist, Probation
+-- Mabel, Steward, Probation
\\-- Thorne, Auditor, Probation
`);
	});

	it("revises the Auditor only as the Operator", () => {
		org("seed");
		const thorne = rosterDefinitions().find((d) => d.id === "A-thorne");
		const file = join(home, "thorne-v2.json");
		writeFileSync(
			file,
			JSON.stringify({
				...thorne,
				version: 2,
				revision_reason: "Sample more Reviews",
			}),
		);

		const asDirector = org("revise", "A-thorne", file, "--as", "A-odile");
		const asOperator = org("revise", "A-thorne", file);

		expect(asDirector.status).toBe(1);
		expect(asDirector.stderr).toMatch(
			/^AppendRefused: the Auditor can only be revised by the Operator; A-odile tried/,
		);
		expect(asOperator.stderr).toBe("");
		expect(asOperator.stdout).toBe("Revised A-thorne to version 2\n");
	});

	it("refuses a Revision to a Trust tier other than the projected one, and accepts one that keeps it", () => {
		org("seed");
		const rin = rosterDefinitions().find((d) => d.id === "A-rin");
		const write = (name: string, changes: object) => {
			const file = join(home, name);
			writeFileSync(
				file,
				JSON.stringify({
					...rin,
					version: 2,
					revision_reason: "Hand-set tier",
					...changes,
				}),
			);
			return file;
		};

		const trusted = org(
			"revise",
			"A-rin",
			write("trusted.json", { trust_tier: "Trusted" }),
		);
		const kept = org("revise", "A-rin", write("kept.json", { capacity: 2 }));

		expect(trusted.status).toBe(1);
		expect(trusted.stderr).toBe(
			"AppendRefused: AgentDefinitionRevised refused: A-rin's projected Trust tier is Probation, not Trusted\n",
		);
		expect(kept.stderr).toBe("");
		expect(kept.stdout).toBe("Revised A-rin to version 2\n");
	});

	it("pauses, resumes and retires an Agent from the command line", () => {
		org("seed");

		const paused = org("pause", "A-mabel", "--reason", "Energy budget review");
		const whilePaused = org("tree").stdout;
		const resumed = org("resume", "A-mabel");
		const noReason = org("pause", "A-pia");

		expect(paused.stdout).toBe("Paused A-mabel\n");
		expect(whilePaused).toContain("+-- Mabel, Steward, Probation (paused)\n");
		expect(resumed.stdout).toBe("Resumed A-mabel\n");
		expect(noReason.status).toBe(2);
		expect(noReason.stderr).toMatch(/^UsageError: org pause needs --reason/);
	});

	it("retires an Agent through a RetireAgent Gate the Operator approves", () => {
		org("seed");

		const opened = org(
			"retire",
			"A-mabel",
			"--reason",
			"Replaced",
			"--as",
			"A-odile",
		);
		const [, hash] = /payload hash ([0-9a-f]{64})/.exec(opened.stdout) ?? [];
		const early = org("retire", "A-mabel", "--gate", "G-1");
		const decided = aliquot(
			"gate",
			"decide",
			"G-1",
			"--approve",
			"--hash",
			hash ?? "",
			"--reason",
			"Mabel is replaced",
		);
		const retired = org("retire", "A-mabel", "--gate", "G-1");
		const afterRetire = org("tree").stdout;
		const shown = aliquot("gate", "show", "G-1").stdout;

		expect(opened.stderr).toBe("");
		expect(opened.stdout).toBe(
			`Requested G-1 to retire A-mabel; payload hash ${hash}\n` +
				`Decide it with \`aliquot gate decide G-1 --approve --hash ${hash} --reason <text>\`, then run \`aliquot org retire A-mabel --gate G-1\`\n`,
		);
		expect(shown).toContain("requester: A-odile\n");
		expect(shown).toContain('"agent_id": "A-mabel"');
		expect(early.status).toBe(1);
		expect(early.stderr).toMatch(
			/^AppendRefused: AgentRetired refused: G-1 is a RetireAgent Gate, Open, naming A-mabel/,
		);
		expect(decided.status).toBe(0);
		expect(retired.stderr).toBe("");
		expect(retired.stdout).toBe("Retired A-mabel through G-1\n");
		expect(afterRetire).not.toContain("Mabel");
	});
});
