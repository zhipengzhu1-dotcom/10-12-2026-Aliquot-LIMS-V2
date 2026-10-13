import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { rosterDefinitions } from "../org/seed.js";
import { type Scenario, scenario } from "../test-support/scenario.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const rin = AgentId.parse("A-rin");

let home: string;

/** Run the command line with `input` on stdin. */
const withStdin = (input: string, ...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, ALIQUOT_HOME: "" },
			input,
		},
	);

const aliquot = (...args: string[]) => withStdin("", ...args);

/** Run a command that must succeed, with `input` on stdin, and return its stdout. */
const ok = (input: string, ...args: string[]) => {
	const result = withStdin(input, ...args);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	return result.stdout;
};

/** A seeded Ledger in `home`, after `build`, closed for the command line. */
const seeded = (build: (s: Scenario) => void = () => {}) => {
	const s = scenario(undefined, { home });
	build(s);
	s.close();
};

const events = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all();
	} finally {
		ledger.close();
	}
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-training-cli-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot training skill", () => {
	it("publish twice gives versions 1 and 2, the second naming the first as its cause, and show prints the latest unless --version names one", () => {
		seeded();
		const file = join(home, "parse-form.md");
		writeFileSync(file, "# Parse a Submission Form\n\nRead every field.\n");

		const first = ok(
			"",
			...["training", "skill", "publish", "parse-submission-form"],
			...["--title", "Parse a Submission Form", file],
		);
		const second = ok(
			"# Parse a Submission Form\n\nRead every field, the TAT code last.\n",
			...["training", "skill", "publish", "parse-submission-form"],
			...["--title", "Parse a Submission Form", "--as", "A-rin"],
		);

		const [v1, v2] = events().filter((e) => e.kind === "SkillPublished");
		expect(first).toBe(
			`${v1?.seq}  Published parse-submission-form version 1: Parse a Submission Form\n`,
		);
		expect(second).toBe(
			`${v2?.seq}  Published parse-submission-form version 2: Parse a Submission Form\n`,
		);
		expect(v1).toMatchObject({
			actor: { tag: "Operator" },
			payload: { version: 1, author: { tag: "Operator" } },
		});
		expect(v1?.causation_id).toBeUndefined();
		expect(v2).toMatchObject({
			actor: { tag: "Agent", id: "A-rin" },
			causation_id: v1?.seq,
			payload: { version: 2, author: { tag: "Agent", id: "A-rin" } },
		});

		expect(ok("", "training", "skill", "show", "parse-submission-form")).toBe(
			`parse-submission-form version 2: Parse a Submission Form\nby A-rin at seq ${v2?.seq}\n\n# Parse a Submission Form\n\nRead every field, the TAT code last.\n`,
		);
		expect(
			ok(
				"",
				...["training", "skill", "show", "parse-submission-form"],
				...["--version", "1"],
			),
		).toBe(
			`parse-submission-form version 1: Parse a Submission Form\nby Operator at seq ${v1?.seq}\n\n# Parse a Submission Form\n\nRead every field.\n`,
		);
		const missing = aliquot(
			...["training", "skill", "show", "parse-submission-form"],
			...["--version", "3"],
		);
		expect(missing.status).toBe(1);
		expect(missing.stderr).toBe(
			"parse-submission-form has no version 3; its latest is 2\n",
		);
		expect(ok("", "training", "skills")).toBe(
			"parse-submission-form  version 2  Parse a Submission Form\n",
		);
	});

	it("org revise granting an unpublished Skill id is refused naming the id, and goes through once training skill publish has published it", () => {
		seeded();
		const rinDefinition = rosterDefinitions().find((d) => d.id === rin);
		const file = join(home, "rin-v2.json");
		writeFileSync(
			file,
			JSON.stringify({
				...rinDefinition,
				version: 2,
				skills: ["parse-submission-form"],
				revision_reason: "Grant the form Skill",
			}),
		);

		const refused = aliquot("org", "revise", "A-rin", file);

		expect(refused.status).toBe(1);
		expect(refused.stderr).toBe(
			"AppendRefused: AgentDefinitionRevised refused: A-rin's definition grants the Skill parse-submission-form, which has not been published\n",
		);

		ok(
			"Read every field.\n",
			...["training", "skill", "publish", "parse-submission-form"],
			...["--title", "Parse a Submission Form"],
		);

		expect(ok("", "org", "revise", "A-rin", file)).toBe(
			"Revised A-rin to version 2\n",
		);
	});
});

describe("aliquot training note, coach and notes", () => {
	it("coach with --as is refused, and notes prints the Agent's Memory notes and Coaching in seq order", () => {
		seeded((s) => s.task(rin));
		const before = events().length;

		const byAgent = withStdin(
			"Slow down\n",
			...["training", "coach", "A-rin", "--as", "A-pia"],
		);

		expect(byAgent.status).toBe(1);
		expect(byAgent.stderr).toBe(
			"AppendRefused: HumanCoached refused: only the Operator gives Coaching; A-pia tried to give it to A-rin\n",
		);
		expect(events(), "nothing is appended").toHaveLength(before);

		const coached = ok(
			"Check the TAT code first\n",
			...["training", "coach", "A-rin", "--task", "T-1"],
		);
		const noted = ok(
			"The TAT code sits in the last column\n",
			...["training", "note", "A-rin", "--task", "T-1"],
			...["--applies-to", "Submission Form, TAT"],
		);
		ok("Request help before a Hand-off\n", "training", "coach", "A-rin");

		expect(coached).toBe(`${before + 1}  Coaching for A-rin\n`);
		expect(noted).toBe(`${before + 2}  A-rin noted a Memory note on T-1\n`);
		expect(events().at(-2)).toMatchObject({
			actor: { tag: "Agent", id: "A-rin" },
			causation_id: before,
			kind: "MemoryNoted",
			payload: {
				agent: "A-rin",
				task_id: "T-1",
				lesson: "The TAT code sits in the last column",
				applies_to: ["Submission Form", "TAT"],
			},
		});
		expect(ok("", "training", "notes", "A-rin")).toBe(
			[
				`${before + 1}  Coaching on T-1: Check the TAT code first`,
				`${before + 2}  Memory note on T-1 (applies to Submission Form, TAT): The TAT code sits in the last column`,
				`${before + 3}  Coaching: Request help before a Hand-off`,
				"",
			].join("\n"),
		);
		expect(ok("", "training", "notes", "A-pia")).toBe(
			"No Memory notes or Coaching for A-pia\n",
		);
	});
});
