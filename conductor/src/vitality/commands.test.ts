import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";
import { scenario, scores } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const rin = AgentId.parse("A-rin");

let home: string;

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
	);

const vitality = (...args: string[]) => aliquot("vitality", ...args);

/** What the Ledger in `home` holds, read in process. */
const read = <T>(f: (ledger: Ledger) => T): T => {
	const ledger = openLedger({ home, writer: false });
	try {
		return f(ledger);
	} finally {
		ledger.close();
	}
};
const lastEvent = () => read((l) => l.all().at(-1));
const storedTier = (agent: AgentId) =>
	read((l) => l.projections.org.agents.get(agent)?.definition.trust_tier);

/**
 * Finished Turns of A-rin, oldest first, each finished `hoursAgo` before
 * now and spending `tokens` of the Energy budget.
 */
const rinTurns = (
	...turns: readonly { hoursAgo: number; tokens: number }[]
) => {
	let at = new Date();
	const ledger = openLedger({ home, writer: true, clock: () => at });
	try {
		for (const { hoursAgo, tokens } of turns) {
			at = new Date(Date.now() - hoursAgo * 3_600_000);
			const { turn } = startTurn(ledger, {
				agent: rin,
				model: "claude-opus-5-5",
				energyBudgetTokens: 8000,
			});
			finishTurn(ledger, {
				turn_id: turn.started.turn_id,
				usage: {
					input_tokens: tokens,
					output_tokens: 0,
					cache_creation_tokens: 0,
					cache_read_tokens: 40_000,
					cost_usd: 0.05,
				},
				outcome: { tag: "Completed" },
				tool_calls: 4,
			});
		}
	} finally {
		ledger.close();
	}
};

const ok = (r: ReturnType<typeof aliquot>) => {
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return r.stdout;
};

beforeEach(() => {
	// A seeded Org in which Rin has 9 reviewed Tasks and T-10 UnderReview.
	home = mkdtempSync(join(tmpdir(), "aliquot-vitality-cli-"));
	const s = scenario(undefined, { home });
	for (let i = 0; i < 9; i++) s.reviewed(rin, scores(3));
	s.submitted(rin);
	s.close();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot vitality", () => {
	it("review refuses a score outside 0 to 3 and a reviewer the assignee's role does not allow, then records a Review and the Trust tier Revision it earns", () => {
		const review = (quality: string, ...as: string[]) =>
			vitality(
				"review",
				"T-10",
				"--quality",
				quality,
				"--traceability",
				"3",
				"--boundary",
				"3",
				"--collaboration",
				"3",
				"--timeliness",
				"2",
				"--note",
				"Late by an hour",
				...as,
			);

		const four = review("4", "--as", "A-pia");
		expect(four.status).toBe(2);
		expect(four.stderr.split("\n")[0]).toBe(
			'UsageError: --quality must be a score 0, 1, 2 or 3, not "4"',
		);
		const byOperator = review("3");
		expect(byOperator.status).toBe(1);
		expect(byOperator.stderr).toContain(
			"ReviewRecorded refused: A-rin is a Specialist on Probation, reviewed by a Supervisor (A-pia or A-anselm), the Auditor (A-thorne) or a Senior or Mentor Agent (none); Operator may not review T-10",
		);
		expect(ok(review("3", "--as", "A-pia"))).toBe(
			"Recorded a Review of T-10 by A-pia: mean 2.80\n" +
				"Revised A-rin to version 2: Trust tier Probation -> Trusted: Merit 2.98 over 10 reviewed Tasks\n",
		);
		expect(storedTier(rin)).toBe("Trusted");
	});

	it("show shows every live Agent, one line each", () => {
		const lines = ok(vitality("show")).trimEnd().split("\n");
		expect(lines.map((l) => l.split(" ")[0])).toEqual([
			"A-odile",
			"A-mabel",
			"A-thorne",
			"A-pia",
			"A-anselm",
			"A-rin",
			"A-ines",
			"A-bram",
		]);
		expect(lines[0]).toMatch(
			/ merit=- reviewed=0 tier=Probation \(computed\)$/,
		);
	});

	it("tiers lists each live Agent's Trust tier and standing, read-only, and has no --apply", () => {
		rmSync(home, { recursive: true, force: true });
		const s = scenario(undefined, { home });
		for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));
		s.gate("PromoteToMentor", { agent_id: "A-ines" });
		s.close();

		expect(ok(vitality("tiers"))).toBe(
			[
				"A-odile Odile merit=- reviewed=0 tier=Probation unused_mentor_gates=-",
				"A-mabel Mabel merit=- reviewed=0 tier=Probation unused_mentor_gates=-",
				"A-thorne Thorne merit=- reviewed=0 tier=Probation unused_mentor_gates=-",
				"A-pia Pia merit=- reviewed=0 tier=Probation unused_mentor_gates=-",
				"A-anselm Anselm merit=- reviewed=0 tier=Probation unused_mentor_gates=-",
				"A-rin Rin merit=3.00 reviewed=10 tier=Trusted unused_mentor_gates=-",
				"A-ines Ines merit=- reviewed=0 tier=Probation unused_mentor_gates=G-1",
				"A-bram Bram merit=- reviewed=0 tier=Probation unused_mentor_gates=-",
				"",
			].join("\n"),
		);

		const apply = vitality("tiers", "--apply");
		expect(apply.status).toBe(2);
		expect(apply.stderr.split("\n")[0]).toMatch(/Unknown option '--apply'/);
	});

	it("rest orders Rest for an Agent", () => {
		expect(
			ok(vitality("rest", "A-ines", "--begin", "--reason", "fatigue 0.92")),
		).toBe("Rest begins for A-ines\n");
		expect(lastEvent()).toMatchObject({
			kind: "RestOrdered",
			payload: { agent_id: "A-ines", action: "begin", reason: "fatigue 0.92" },
		});
	});

	it("show and sample compute fatigue from A-rin's Turns in the trailing 5 hours", () => {
		rinTurns({ hoursAgo: 6, tokens: 90_000 }, { hoursAgo: 1, tokens: 300 });

		expect(ok(vitality("show", "A-rin"))).toMatch(
			/^A-rin Rin load=0\.00 fatigue=0\.00 /,
		);
		expect(
			ok(vitality("sample", "A-rin", "--budget", "8000")),
			"300 tokens of a 1000-token share",
		).toBe(
			"Sampled A-rin: load=0.00 fatigue=0.30 friction=0.00 confidence=1.00 morale=0.00\n",
		);
		expect(lastEvent()).toMatchObject({
			kind: "VitalitySampled",
			payload: { agent: "A-rin", fatigue: 0.3 },
		});
		expect(lastEvent()).not.toHaveProperty("causation_id");
	});

	it("show computes fatigue from Turns for an Agent never sampled, and prints Mood fresh with the normal Policy for every live Agent, fatigued or resting", () => {
		rinTurns({ hoursAgo: 1, tokens: 100_000 });
		ok(vitality("rest", "A-ines", "--begin", "--reason", "fatigue 0.92"));

		const lines = ok(vitality("show")).trimEnd().split("\n");

		expect(
			lines.find((l) => l.startsWith("A-rin ")),
			"100,000 tokens of a 142,857-token share: 7 Agents not resting",
		).toMatch(/^A-rin Rin load=0\.00 fatigue=0\.70 /);
		expect(lines).toHaveLength(8);
		expect(
			lines.map((l) => /mood=(\S+) policy=(\S+)/.exec(l)?.slice(1)),
		).toEqual(
			lines.map(() => ["fresh", "mayAcceptTasks,mayOfferHelp,schedulable"]),
		);
	});

	it("export --csv writes each sample with Mood fresh, each Turn, and each Review, one table per call", () => {
		rinTurns({ hoursAgo: 1, tokens: 900 });
		ok(vitality("sample", "A-rin", "--budget", "8000"));
		ok(vitality("sample", "A-rin", "--budget", "1000000"));
		const ledger = openLedger({ home, writer: true });
		try {
			const ines = startTurn(ledger, {
				agent: AgentId.parse("A-ines"),
				model: "claude-sonnet-5-5",
				energyBudgetTokens: 8000,
			});
			finishTurn(ledger, {
				turn_id: ines.turn.started.turn_id,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_tokens: 0,
					cache_read_tokens: 0,
					cost_usd: 0,
				},
				outcome: { tag: "Error", message: 'login refused, "rate limited"' },
				tool_calls: 0,
			});
			startTurn(ledger, {
				agent: AgentId.parse("A-bram"),
				model: "claude-sonnet-5-5",
				energyBudgetTokens: 8000,
			});
		} finally {
			ledger.close();
		}
		ok(
			vitality(
				"review",
				"T-10",
				"--quality",
				"3",
				"--traceability",
				"3",
				"--boundary",
				"3",
				"--collaboration",
				"3",
				"--timeliness",
				"2",
				"--note",
				'Late, by "an" hour',
				"--as",
				"A-pia",
			),
		);
		const rows = (...flags: string[]) =>
			ok(vitality("export", "--csv", ...flags))
				.trimEnd()
				.split("\n")
				.map((line) => line.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<at>"));

		expect(rows()).toEqual([
			"seq,at,agent,load,fatigue,friction,confidence,morale,mood,causation_id",
			"71,<at>,A-rin,0,0.9,0,1,0,fresh,",
			"72,<at>,A-rin,0,0.0072,0,1,0,fresh,",
		]);
		expect(rows("--turns")).toEqual([
			"turn_id,agent,model,mood,started_seq,started,finished_seq,finished,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,counted_tokens,cost_usd,tool_calls,outcome,error",
			"TN-1,A-rin,claude-opus-5-5,fresh,69,<at>,70,<at>,900,0,0,40000,900,0.05,4,Completed,",
			'TN-2,A-ines,claude-sonnet-5-5,fresh,73,<at>,74,<at>,0,0,0,0,0,0,0,Error,"login refused, ""rate limited"""',
			"TN-3,A-bram,claude-sonnet-5-5,fresh,75,<at>,,,,,,,,,,open,",
		]);
		const reviews = rows("--reviews");
		expect(reviews.slice(0, 2)).toEqual([
			"seq,at,task_id,assignee,reviewer,quality,traceability,boundary_adherence,collaboration,timeliness,mean,note",
			"15,<at>,T-1,A-rin,A-pia,3,3,3,3,3,3,",
		]);
		expect(reviews).toHaveLength(11);
		expect(reviews.at(-1)).toBe(
			'76,<at>,T-10,A-rin,A-pia,3,3,3,3,2,2.8,"Late, by ""an"" hour"',
		);

		const bare = vitality("export");
		expect(bare.status).toBe(2);
		expect(bare.stderr.split("\n")[0]).toBe(
			"UsageError: vitality export writes CSV only; pass --csv",
		);
		expect(vitality("export", "--csv", "--turns", "--reviews").status).toBe(2);
	});

	it("sample has no --tokens", () => {
		const r = vitality("sample", "A-rin", "--tokens", "300");
		expect(r.status).toBe(2);
		expect(r.stderr.split("\n")[0]).toMatch(/Unknown option '--tokens'/);
	});
});
