import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Scenario, scenario, scores } from "./scenario.js";
import { restInEffect, sampleVitality } from "./vitality.js";

const rin = AgentId.parse("A-rin"); // Specialist, capacity 3
const ines = AgentId.parse("A-ines");
const bram = AgentId.parse("A-bram");
const mabel = AgentId.parse("A-mabel");

const rest = (agent: AgentId, action: "begin" | "end") =>
	s.append({
		actor: { tag: "Agent", id: mabel },
		kind: "RestOrdered",
		payload: { agent_id: agent, action, reason: "fatigue" },
	});

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const sample = (opts: { tokensUsedInWindow?: number } = {}) =>
	sampleVitality(s.events(), rin, {
		now: s.now(),
		energyBudgetTokens: 8000,
		...opts,
	});

describe("sampleVitality", () => {
	it("measures an idle Agent as calm", () => {
		expect(sample()).toEqual({
			agent: rin,
			load: 0,
			fatigue: 0,
			friction: 0,
			confidence: 1,
			morale: 0,
		});
	});

	it("counts open Tasks assigned to the Agent against its capacity", () => {
		s.task(rin, { start: false }); // Assigned
		s.task(rin); // InProgress
		s.submit(rin, s.task(rin)); // UnderReview: the work is with the reviewer
		s.reviewed(rin, scores(3)); // Done
		s.task(ines); // someone else's

		expect(sample().load).toBeCloseTo(2 / 3);
	});

	it("divides tokens in the window by the Agent's share of the Energy budget", () => {
		// 8 Agents, none resting: the share is 8000 / 8 = 1000 tokens.
		expect(sample({ tokensUsedInWindow: 300 }).fatigue).toBeCloseTo(0.3);
		rest(ines, "begin");
		rest(bram, "begin");
		// 6 Agents not resting: the share is 8000 / 6.
		expect(sample({ tokensUsedInWindow: 300 }).fatigue).toBeCloseTo(
			300 / (8000 / 6),
		);
		rest(bram, "end");
		expect(sample({ tokensUsedInWindow: 300 }).fatigue).toBeCloseTo(
			300 / (8000 / 7),
		);
	});
});

describe("restInEffect", () => {
	it("follows RestOrdered begin and end for that Agent only", () => {
		expect(restInEffect(s.events(), rin)).toBe(false);
		rest(rin, "begin");
		expect(restInEffect(s.events(), rin)).toBe(true);
		expect(restInEffect(s.events(), ines)).toBe(false);
		rest(rin, "end");
		expect(restInEffect(s.events(), rin)).toBe(false);
	});
});
