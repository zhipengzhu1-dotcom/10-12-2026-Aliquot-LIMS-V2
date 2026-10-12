import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { scenario, scores } from "./scenario.js";

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

const ok = (r: ReturnType<typeof aliquot>) => {
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return r.stdout;
};

beforeEach(() => {
	// A seeded Org in which Rin has 9 reviewed Tasks and T-10 UnderReview.
	const s = scenario();
	for (let i = 0; i < 9; i++) s.reviewed(rin, scores(3));
	s.submit(rin, s.task(rin));
	s.ledger.close();
	home = s.home;
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot vitality", () => {
	it("records a Review, revises the Trust tier once, and shows it", () => {
		expect(
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
					"Late by an hour",
				),
			),
		).toBe("Recorded a Review of T-10 by Operator: mean 2.80\n");

		expect(ok(vitality("tiers"))).toBe(
			"A-rin Rin: Trust tier Probation -> Trusted: Merit 2.98 over 10 reviewed Tasks\n" +
				"1 Revision needed; run vitality tiers --apply to append it\n",
		);
		expect(ok(vitality("tiers", "--apply"))).toBe(
			"Revised A-rin to version 2: Trust tier Probation -> Trusted: Merit 2.98 over 10 reviewed Tasks\n",
		);
		expect(ok(vitality("tiers", "--apply"))).toBe(
			"Every Trust tier is in line with Merit; nothing to revise\n",
		);

		expect(ok(vitality("show", "A-rin"))).toBe(
			"A-rin Rin load=0.00 fatigue=0.00 friction=0.00 confidence=1.00 morale=0.00 mood=fresh policy=mayAcceptTasks,mayOfferHelp,schedulable merit=2.98 reviewed=10 tier=Trusted (computed)\n",
		);
		expect(ok(aliquot("org", "tree"))).toContain("Rin, Specialist, Trusted");
	});

	it("shows every live Agent, one line each", () => {
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

	it("orders Rest and shows the Agent resting and unschedulable", () => {
		expect(
			ok(vitality("rest", "A-ines", "--begin", "--reason", "fatigue 0.92")),
		).toBe("Rest begins for A-ines\n");
		expect(ok(vitality("show", "A-ines"))).toContain(" mood=resting policy=- ");
		expect(ok(vitality("rest", "A-ines", "--end", "--reason", "rested"))).toBe(
			"Rest ends for A-ines\n",
		);
		const again = vitality("rest", "A-ines", "--end", "--reason", "rested");
		expect(again.status).toBe(1);
		expect(again.stderr).toBe(
			"AppendRefused: RestOrdered refused: A-ines is not resting\n",
		);
	});

	it("appends a Vitality sample computed from the Ledger", () => {
		expect(
			ok(vitality("sample", "A-rin", "--tokens", "300", "--budget", "8000")),
		).toBe(
			"Sampled A-rin: load=0.00 fatigue=0.30 friction=0.00 confidence=1.00 morale=0.00\n",
		);
		expect(ok(vitality("show", "A-rin"))).toMatch(
			/^A-rin Rin load=0\.00 fatigue=0\.30 .* \(sampled\)\n$/,
		);
	});

	it("refuses a score outside 0 to 3", () => {
		const r = vitality(
			"review",
			"T-10",
			"--quality",
			"4",
			"--traceability",
			"3",
			"--boundary",
			"3",
			"--collaboration",
			"3",
			"--timeliness",
			"3",
			"--note",
			"",
		);
		expect(r.status).toBe(2);
		expect(r.stderr.split("\n")[0]).toBe(
			'UsageError: --quality must be a score 0, 1, 2 or 3, not "4"',
		);
	});
});
