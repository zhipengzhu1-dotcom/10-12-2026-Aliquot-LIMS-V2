import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../hash.js";
import { AgentId, ArtifactId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { assign, propose, start } from "../task/lifecycle.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { Action } from "../types/action.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

let home: string;

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
	);

const events = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all();
	} finally {
		ledger.close();
	}
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-tools-cli-"));
	expect(aliquot("org", "seed").status).toBe(0);
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot tools", () => {
	it("list prints the Tools an Agent may use, and the Action that refuses each of the rest", () => {
		const odile = aliquot("tools", "list", "A-odile");
		const anselm = aliquot("tools", "list", "A-anselm");

		expect(odile.status, odile.stderr).toBe(0);
		const lines = odile.stdout.split("\n");
		expect(lines[0]).toBe(
			"A-odile's Charter forbids RunScript, TouchArtifact, DecideGate",
		);
		expect(lines).toContain("run_script        refused: RunScript");
		expect(lines).toContain("read_artifact     refused: TouchArtifact");
		expect(lines).toContain(
			"verify_ledger     Verify the Ledger's hash chain from the first Event",
		);
		expect(lines.filter((l) => l !== "")).toHaveLength(26);
		expect(anselm.stdout).toMatch(
			/\nrun_script {8}Run a Script .* \(refused when it is VerifyOwnTeamRun\)\n/,
		);
	});

	it("call refuses A-odile's run_script as RunScript, records ActionRefused, and the Ledger still verifies", () => {
		const before = events().length;

		const refused = aliquot(
			"tools",
			"call",
			"A-odile",
			"run_script",
			'{"script":"S-parse_submission","inputs":[]}',
		);

		expect(refused.status).toBe(1);
		expect(refused.stderr).toBe(
			"run_script refused: A-odile's Charter forbids RunScript: run_script performs it\n",
		);
		expect(events().slice(before)).toMatchObject([
			{
				kind: "ActionRefused",
				actor: { tag: "Conductor" },
				payload: { agent: "A-odile", tool: "run_script", action: "RunScript" },
			},
		]);
		const verified = aliquot("ledger", "verify");
		expect(verified.status, verified.stderr).toBe(0);
		expect(verified.stdout).toBe(
			`Ledger verified: ${before + 1} Events, chain intact\n`,
		);
	});

	it("call prints a Tool's result as JSON", () => {
		const said = aliquot("tools", "call", "A-rin", "read_tasks");

		expect(said.status, said.stderr).toBe(0);
		expect(JSON.parse(said.stdout)).toEqual([]);
	});

	it("call refuses input that is not JSON, or not the Tool's, and a Tool or Agent that does not exist", () => {
		expect(aliquot("tools", "call", "A-rin", "read_tasks", "{").status).toBe(2);
		const wrong = aliquot("tools", "call", "A-rin", "start_task", "{}");
		expect(wrong.status).toBe(2);
		expect(wrong.stderr).toContain("start_task input:");
		const unknown = aliquot("tools", "call", "A-rin", "bash");
		expect(unknown.status).toBe(2);
		expect(unknown.stderr).toContain("no Tool is named bash");
		const nobody = aliquot("tools", "call", "A-nobody", "read_tasks");
		expect(nobody.status).toBe(1);
		expect(nobody.stderr).toBe(
			"error: A-nobody is not a live Agent in the Org\n",
		);
	});
});

describe("aliquot org revise", () => {
	it("refuses a definition whose Charter forbids anything but an Action, naming it", () => {
		const show = openLedger({ home, writer: false });
		const rin = show.projections.org.agents.get(AgentId.parse("A-rin"));
		show.close();
		if (rin === undefined) throw new Error("A-rin is seeded");
		const file = join(home, "rin.json");
		writeFileSync(
			file,
			JSON.stringify({
				...rin.definition,
				version: 2,
				charter: { ...rin.definition.charter, forbidden: ["FlyDrones"] },
				revision_reason: "New boundary",
			}),
		);

		const revised = aliquot("org", "revise", "A-rin", file);

		expect(revised.status).toBe(1);
		expect(revised.stderr).toBe(
			`AppendRefused: AgentDefinitionRevised refused: A-rin's Charter forbids "FlyDrones", which is not an Action; the Actions are ${Action.options.join(", ")}\n`,
		);
	});
});

const suite = dockerAvailable
	? "aliquot tools call run_script (Docker)"
	: "aliquot tools call run_script: SKIPPED because `docker info` failed; start Docker to run these";

const fixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const fixtureId = ArtifactId.parse(sha256Hex(readFileSync(fixture)));

describe.skipIf(!requireDocker())(suite, () => {
	it("call runs the stage 1 Script for A-rin on its Task and prints the Run with the stage's Evaluation", () => {
		expect(aliquot("workflow", "run", fixture).status).toBe(0);
		const ledger = openLedger({ home, writer: true });
		const rin = AgentId.parse("A-rin");
		const operator = { tag: "Operator" } as const;
		const task_id = propose(ledger, {
			actor: operator,
			title: "Stage 1 again",
			goal: "",
			tat_class: "Regular",
			priority: 1,
			inputs: [fixtureId],
		}).task.id;
		assign(ledger, { actor: operator, task_id, assignee: rin });
		start(ledger, { actor: { tag: "Agent", id: rin }, task_id });
		ledger.close();

		const ran = aliquot(
			"tools",
			"call",
			"A-rin",
			"run_script",
			JSON.stringify({
				script: "S-parse_submission",
				inputs: [fixtureId],
				task_id,
			}),
		);

		expect(ran.status, ran.stderr).toBe(0);
		const printed = JSON.parse(ran.stdout);
		const run_id = printed.run.id;
		expect(printed).toMatchObject({
			run: { script: { id: "S-parse_submission" }, exit_code: 0 },
			evaluation: { stage: 1, run_id, task_id, score: 1, passed: true },
		});
		const written = events();
		expect(
			written.filter((e) => e.kind === "RunFinished").at(-1),
			"the printed Run is the last one the Ledger finished",
		).toMatchObject({
			actor: { tag: "Agent", id: "A-rin" },
			payload: { id: run_id },
		});
		expect(written.at(-1)).toMatchObject({
			kind: "EvaluationRecorded",
			actor: { tag: "Agent", id: "A-rin" },
			payload: { run_id, task_id },
		});
		expect(aliquot("ledger", "verify").status).toBe(0);
	}, 120_000);
});
