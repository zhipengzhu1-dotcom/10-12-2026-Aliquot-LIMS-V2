import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, TaskId } from "../ids.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";
import { reviewOf } from "./tracer.js";

const rin = AgentId.parse("A-rin");

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

describe("the stage 1 tracer's Review", () => {
	it("sends a Probation Specialist's Task to its Supervisor for Review", () => {
		expect(reviewOf(s.ledger.projections, TaskId.parse("T-1"), rin)).toEqual({
			tag: "Required",
			reviewer: { tag: "Agent", id: "A-pia" },
		});
	});

	it("skips Review when the sample for a Trusted owner leaves the Task out", () => {
		for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));

		expect(reviewOf(s.ledger.projections, TaskId.parse("T-11"), rin)).toEqual({
			tag: "Skipped",
			reason: "not sampled for Review at tier Trusted",
		});
		expect(
			reviewOf(s.ledger.projections, TaskId.parse("T-15"), rin),
		).toMatchObject({
			tag: "Required",
		});
	});
});
