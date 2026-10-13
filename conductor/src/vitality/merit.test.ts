import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Scenario, scenario, scores } from "./scenario.js";
import { trustOf } from "./trust.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const thorne = { tag: "Agent", id: AgentId.parse("A-thorne") } as const;

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

/** Rin's Merit, tenure and window, as the Trust tier Projection holds them. */
const meritOf = (agent: AgentId) =>
	trustOf(s.ledger.projections.trust, agent).standing;

describe("Merit", () => {
	it("has no Merit before the first Review", () => {
		expect(meritOf(rin)).toEqual({
			merit: undefined,
			reviewedTasks: 0,
			window: [],
		});
	});

	it("is the mean of every dimension score over the last 20 reviewed Tasks", () => {
		for (let i = 0; i < 5; i++) s.reviewed(rin, scores(0));
		for (let i = 0; i < 19; i++) s.reviewed(rin, scores(3));
		s.reviewed(rin, scores(3, { quality: 1, timeliness: 2 }));
		s.reviewed(ines, scores(0));

		const { merit, reviewedTasks, window } = meritOf(rin);
		// 20 Tasks x 5 dimensions = 100 scores, 3 below the maximum of 300.
		expect(merit).toBeCloseTo(297 / 100);
		expect(reviewedTasks).toBe(25);
		expect(window).toHaveLength(20);
	});

	it("leaves out Tasks the Trust tier rules skipped for Review", () => {
		// Ten Reviews at 2 make Rin Trusted, so the sample may skip a Task.
		for (let i = 0; i < 10; i++) s.reviewed(rin, scores(2));
		const skipped = s.skipped(rin);
		s.review(skipped, scores(0), thorne); // the Auditor samples it anyway

		expect(meritOf(rin)).toMatchObject({
			merit: 2,
			reviewedTasks: 10,
		});
	});

	it("counts every Review of a Task, and the Task once", () => {
		const t = s.reviewed(rin, scores(3));
		s.review(t, scores(1), thorne);

		const { merit, reviewedTasks, window } = meritOf(rin);
		expect(merit).toBe(2);
		expect(reviewedTasks).toBe(1);
		expect(window.map((r) => r.reviewer)).toEqual([
			{ tag: "Operator" },
			thorne,
		]);
	});
});
