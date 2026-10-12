import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Scenario, scenario, scores } from "./scenario.js";
import { restInEffect, sampleVitality } from "./vitality.js";

const rin = AgentId.parse("A-rin"); // Specialist, capacity 3
const ines = AgentId.parse("A-ines");
const bram = AgentId.parse("A-bram");
const mabel = AgentId.parse("A-mabel");
const FIVE_MINUTES = 5 / 1440; // in days

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

describe("sampleVitality over the Agent's last 10 Tasks", () => {
	it("counts failed Runs and Reviews with a 0 or 1 as friction", () => {
		const old = s.task(rin);
		s.run(old, 1); // an 11th-most-recent Task falls out of the window
		const failedRun = s.task(rin);
		s.run(failedRun, 2);
		s.run(failedRun, 0);
		s.reviewed(rin, scores(3, { timeliness: 1 }));
		s.reviewed(rin, scores(2));
		for (let i = 0; i < 7; i++) s.task(rin, { start: false });
		// 10 Tasks: one failed Run and one Review with a 1.
		expect(sample().friction).toBeCloseTo(2 / 10);
	});

	it("caps friction at 1", () => {
		const t = s.task(rin);
		s.run(t, 1);
		s.run(t, 1);
		expect(sample().friction).toBe(1);
	});

	it("takes confidence as the mean latest Evaluation score per Task", () => {
		const a = s.task(rin);
		s.run(a, 0, 0.1);
		s.run(a, 0, 0.4); // the latest Evaluation of a Task stands
		const b = s.task(rin);
		s.run(b, 0, 0.8);
		s.task(rin); // no Evaluation: does not pull the mean
		expect(sample().confidence).toBeCloseTo(0.6);
	});

	it("takes morale as the slope of Review means over the last 7 days, per week", () => {
		s.reviewed(rin, scores(0)); // 10 days before now: outside the window
		s.advanceDays(4);
		s.reviewed(rin, scores(1)); // mean 1.0 at day 4
		s.advanceDays(3);
		s.reviewed(rin, scores(2)); // mean 2.0 at day 7
		s.advanceDays(3);
		// +1 Merit point over 3 days is 7/3 points per week.
		expect(sample().morale).toBeCloseTo(7 / 3);
	});

	it("averages Review means per day, so Reviews minutes apart do not swing morale", () => {
		s.reviewed(rin, scores(3));
		s.advanceDays(FIVE_MINUTES);
		s.reviewed(rin, scores(2)); // the same day: one point, mean 2.5
		s.advanceDays(2);
		s.reviewed(rin, scores(3));
		s.advanceDays(FIVE_MINUTES);
		s.reviewed(rin, scores(3)); // two days later: mean 3.0
		// +0.5 Merit points over 2 days is 1.75 points per week.
		expect(sample().morale).toBeCloseTo(1.75);
	});

	it("gives morale 0 when every Review in the window falls on one day", () => {
		s.reviewed(rin, scores(3));
		s.advanceDays(FIVE_MINUTES);
		s.reviewed(rin, scores(1));
		expect(sample().morale).toBe(0);
	});

	it("gives morale 0 with fewer than two Reviews in the window", () => {
		s.reviewed(rin, scores(3));
		expect(sample().morale).toBe(0);
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
