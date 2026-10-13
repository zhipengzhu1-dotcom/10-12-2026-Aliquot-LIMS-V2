import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { scenario } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "./lifecycle.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

let home: string;

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
	);

const ok = (...args: string[]) => {
	const r = aliquot(...args);
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return r.stdout;
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-turn-cli-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** A seeded Ledger in `home` where Rin finished TN-1, Ines failed TN-2, and Rin has TN-3 open. */
const withTurns = () => {
	const s = scenario("2026-10-12T09:00:00.000Z", { home });
	const start = (agent: string) =>
		startTurn(s.ledger, {
			agent: AgentId.parse(agent),
			model: "claude-opus-5-5",
			energyBudgetTokens: 8000,
		}).turn.started.turn_id;
	const usage = {
		input_tokens: 1200,
		output_tokens: 300,
		cache_creation_tokens: 40,
		cache_read_tokens: 9000,
		cost_usd: 0.021,
	};
	const first = start("A-rin");
	s.at("2026-10-12T09:02:00.000Z");
	finishTurn(s.ledger, {
		turn_id: first,
		usage,
		outcome: { tag: "Completed" },
		tool_calls: 3,
	});
	const second = start("A-ines");
	s.at("2026-10-12T09:03:00.000Z");
	finishTurn(s.ledger, {
		turn_id: second,
		usage: { ...usage, output_tokens: 0 },
		outcome: { tag: "Error", message: "the model stopped" },
		tool_calls: 0,
	});
	start("A-rin");
	s.close();
};

describe("aliquot turn list", () => {
	it("prints No Turns and exits 0 on a Ledger with no Turns", () => {
		scenario(undefined, { home }).close();

		expect(ok("turn", "list")).toBe("No Turns\n");
	});

	it("prints each Turn with its Agent, start and finish time, usage and outcome", () => {
		withTurns();

		expect(ok("turn", "list")).toBe(
			[
				"TN-1 A-rin model=claude-opus-5-5 started=2026-10-12T09:00:00.000Z finished=2026-10-12T09:02:00.000Z input=1200 output=300 cache_creation=40 cache_read=9000 cost_usd=0.021 tool_calls=3 outcome=Completed",
				"TN-2 A-ines model=claude-opus-5-5 started=2026-10-12T09:02:00.000Z finished=2026-10-12T09:03:00.000Z input=1200 output=0 cache_creation=40 cache_read=9000 cost_usd=0.021 tool_calls=0 outcome=Error: the model stopped",
				"TN-3 A-rin model=claude-opus-5-5 started=2026-10-12T09:03:00.000Z finished=- outcome=open",
				"",
			].join("\n"),
		);
	});

	it("prints one Agent's Turns with --agent, and refuses an id that is not an Agent's", () => {
		withTurns();

		expect(
			ok("turn", "list", "--agent", "A-rin")
				.trimEnd()
				.split("\n")
				.map((l) => l.split(" ").slice(0, 2).join(" ")),
		).toEqual(["TN-1 A-rin", "TN-3 A-rin"]);
		expect(ok("turn", "list", "--agent", "A-bram")).toBe("No Turns\n");

		const bad = aliquot("turn", "list", "--agent", "rin");
		expect(bad.status).toBe(2);
		expect(bad.stderr.split("\n")[0]).toBe(
			'UsageError: --agent expects an Agent id like A-rin, not "rin"',
		);
	});
});
