import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId } from "../ids.js";
import { rosterDefinitions } from "../org/seed.js";
import { complete } from "../task/lifecycle.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";

const operator: Actor = { tag: "Operator" };
const id = (slug: string) => AgentId.parse(`A-${slug}`);
const as = (slug: string): Actor => ({ tag: "Agent", id: id(slug) });
const rin = id("rin");
const ines = id("ines");
const roster = rosterDefinitions().map((d) => d.id);

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

/** Whether `act` goes through, or the Ledger refuses it. */
const goesThrough = (act: () => unknown): boolean => {
	try {
		act();
		return true;
	} catch (e) {
		if (e instanceof AppendRefused) return false;
		throw e;
	}
};

const tierOf = (agent: AgentId) =>
	s.ledger.projections.org.agents.get(agent)?.definition.trust_tier;

describe("the reviewer rule", () => {
	it("refuses a reviewer outside the rule in the same words, whether a completion names it or it records the Review", () => {
		const task_id = s.task(rin);
		const reason =
			"A-rin is a Specialist on Probation, reviewed by a Supervisor (A-pia or A-anselm), the Auditor (A-thorne) or a Senior or Mentor Agent (none); A-odile may not review T-1";

		expect(() =>
			complete(s.ledger, {
				actor: as("rin"),
				task_id,
				reviewer: as("odile"),
			}),
		).toThrow(new AppendRefused(`TaskCompleted refused: ${reason}`));
		complete(s.ledger, { actor: as("rin"), task_id, reviewer: as("anselm") });
		expect(() => s.review(task_id, scores(3), as("odile"))).toThrow(
			new AppendRefused(`ReviewRecorded refused: ${reason}`),
		);
		s.review(task_id, scores(3), as("anselm"));
	});

	it("lets the Operator be named for and review a Task of the Director, the Steward and the Auditor, and nobody else", () => {
		const named = roster.filter((agent) =>
			goesThrough(() => s.submitted(agent, operator)),
		);
		const reviewing = roster.filter((agent) => {
			const task_id = s.submitted(agent);
			return goesThrough(() => s.review(task_id, scores(3), operator));
		});

		expect(named).toEqual(["A-odile", "A-mabel", "A-thorne"]);
		expect(reviewing).toEqual(["A-odile", "A-mabel", "A-thorne"]);
	});

	it("lets the Director review the Supervisors only, and either Supervisor review the Specialists only", () => {
		const reviewedBy = (slug: string) =>
			roster.filter((agent) => goesThrough(() => s.submitted(agent, as(slug))));

		expect(reviewedBy("odile")).toEqual(["A-pia", "A-anselm"]);
		expect(reviewedBy("pia")).toEqual(["A-rin", "A-ines", "A-bram"]);
		expect(reviewedBy("anselm")).toEqual(["A-rin", "A-ines", "A-bram"]);
		expect(reviewedBy("mabel")).toEqual([]);
	});

	it("lets the Auditor be named for and review a Task of any other Agent, and never its own", () => {
		for (const agent of roster.filter((a) => a !== id("thorne"))) {
			const task_id = s.submitted(agent, as("thorne"));
			s.review(task_id, scores(3), as("thorne"));
		}

		expect(() => s.submitted(id("thorne"), as("thorne"))).toThrow(
			/A-thorne is the assignee of T-\d+ and cannot review it/,
		);
	});

	it("lets a Senior Agent review an Agent on Probation once Reviews promote it, and not before", () => {
		for (let i = 0; i < 10; i++) s.reviewed(ines, scores(3));
		expect(tierOf(ines)).toBe("Trusted");
		expect(() => s.submitted(rin, as("ines"))).toThrow(
			/A-rin is a Specialist on Probation, .*; A-ines may not review/,
		);

		for (let i = 0; i < 10; i++) s.reviewed(ines, scores(3));
		expect(tierOf(ines)).toBe("Senior");
		const task_id = s.submitted(rin, as("ines"));
		s.review(task_id, scores(3), as("ines"));
		const done = complete(s.ledger, { actor: as("ines"), task_id });

		expect(done.task.state).toEqual({ tag: "Done", assignee: rin });
		expect(tierOf(rin)).toBe("Probation");
	});
});
