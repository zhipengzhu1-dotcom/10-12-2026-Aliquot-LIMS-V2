import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { reviewerOf } from "./tracer.js";

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

describe("the stage 1 tracer's reviewer", () => {
	it("is a Specialist's Supervisor, and the Operator for an Agent with none", () => {
		const { projections } = s.ledger;

		expect(reviewerOf(projections, AgentId.parse("A-rin"))).toEqual({
			tag: "Agent",
			id: "A-pia",
		});
		expect(reviewerOf(projections, AgentId.parse("A-odile"))).toEqual({
			tag: "Operator",
		});
	});
});
