import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { meritOf } from "./merit.js";
import { type Scenario, scenario, scores } from "./scenario.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const thorne = { tag: "Agent", id: AgentId.parse("A-thorne") } as const;

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

describe("meritOf", () => {
	it("has no Merit before the first Review", () => {
		expect(meritOf(s.events(), rin)).toEqual({
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

		const { merit, reviewedTasks, window } = meritOf(s.events(), rin);
		// 20 Tasks x 5 dimensions = 100 scores, 3 below the maximum of 300.
		expect(merit).toBeCloseTo(297 / 100);
		expect(reviewedTasks).toBe(25);
		expect(window).toHaveLength(20);
	});

	it("leaves out Tasks the Trust tier rules skipped for Review", () => {
		for (let i = 0; i < 4; i++) s.reviewed(rin, scores(2));
		const skipped = s.skipped(rin);
		s.review(skipped, scores(0), thorne); // the Auditor samples it anyway

		expect(meritOf(s.events(), rin)).toMatchObject({
			merit: 2,
			reviewedTasks: 4,
		});
	});

	it("counts every Review of a Task, and the Task once", () => {
		const t = s.reviewed(rin, scores(3));
		s.review(t, scores(1), thorne);

		const { merit, reviewedTasks, window } = meritOf(s.events(), rin);
		expect(merit).toBe(2);
		expect(reviewedTasks).toBe(1);
		expect(window.map((r) => r.reviewer)).toEqual([
			{ tag: "Operator" },
			thorne,
		]);
	});
});
