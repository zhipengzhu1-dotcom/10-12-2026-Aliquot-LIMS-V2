import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Scenario, scenario, scores } from "./scenario.js";

const rin = AgentId.parse("A-rin");

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

describe("a scenario Ledger", () => {
	it("chains each Task's Events from proposal to its completion after Review, with the default rubric", () => {
		const t = s.reviewed(rin, scores(3));

		const events = s.events().filter((e) => e.task_id === t);
		expect(
			events.map((e) => e.causation_id),
			"each Event names the one before it",
		).toEqual([undefined, ...events.slice(0, -1).map((e) => e.seq)]);
		expect(events.map((e) => e.kind)).toEqual([
			"TaskProposed",
			"TaskAssigned",
			"TaskStarted",
			"TaskCompleted",
			"ReviewRecorded",
			"TaskCompleted",
		]);
		expect(events[0]?.payload).toMatchObject({ rubric_id: "default" });
	});

	it("holds the Conductor's tier Revision that the 10th Review earns, caused by that Review", () => {
		for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));

		const events = s.events();
		const tenth = events.filter((e) => e.kind === "ReviewRecorded").at(-1);
		expect(events.filter((e) => e.actor.tag === "Conductor")).toMatchObject([
			{
				kind: "AgentDefinitionRevised",
				causation_id: tenth?.seq,
				payload: { definition: { id: rin, trust_tier: "Trusted" } },
			},
		]);
	});
});
