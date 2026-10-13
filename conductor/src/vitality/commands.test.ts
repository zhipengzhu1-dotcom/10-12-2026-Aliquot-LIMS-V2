import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";
import { scenario, scores } from "../test-support/scenario.js";

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

	it("sample appends a Vitality sample computed from the Ledger", () => {
		expect(
			ok(vitality("sample", "A-rin", "--tokens", "300", "--budget", "8000")),
		).toBe(
			"Sampled A-rin: load=0.00 fatigue=0.30 friction=0.00 confidence=1.00 morale=0.00\n",
		);
		expect(lastEvent()).toMatchObject({
			kind: "VitalitySampled",
			payload: { agent: "A-rin", fatigue: 0.3 },
		});
	});
});
