import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { orgState } from "../org/projection.js";
import { tierRevisions, vitalityProjection } from "./projection.js";
import { type Scenario, scenario, scores } from "./scenario.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const bram = AgentId.parse("A-bram");

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const repeat = (n: number, f: () => unknown) => {
	for (let i = 0; i < n; i++) f();
};

const view = () =>
	vitalityProjection(s.events(), { now: s.now(), energyBudgetTokens: 8000 });

describe("vitalityProjection", () => {
	it("shows every live Agent, fresh and on Probation after seeding", () => {
		const agents = view();
		expect([...agents.keys()]).toEqual([
			"A-odile",
			"A-mabel",
			"A-thorne",
			"A-pia",
			"A-anselm",
			"A-rin",
			"A-ines",
			"A-bram",
		]);
		expect(agents.get(rin)).toMatchObject({
			sampled: false,
			mood: "fresh",
			policy: { mayAcceptTasks: true, schedulable: true },
			merit: undefined,
			reviewedTasks: 0,
			tier: "Probation",
		});
	});

	it("takes Mood from Rest, Tasks InProgress and the latest Vitality sample", () => {
		s.task(rin);
		s.append({
			actor: { tag: "Agent", id: AgentId.parse("A-mabel") },
			kind: "RestOrdered",
			payload: { agent_id: ines, action: "begin", reason: "fatigue 0.92" },
		});
		s.append({
			actor: { tag: "Operator" },
			kind: "VitalitySampled",
			payload: {
				agent: bram,
				load: 0.2,
				fatigue: 0.85,
				friction: 0,
				confidence: 1,
				morale: 0,
			},
		});
		s.retire(AgentId.parse("A-anselm"), "Replaced");

		const agents = view();
		expect(agents.get(rin)?.mood).toBe("focused");
		expect(agents.get(ines)?.mood).toBe("resting");
		expect(agents.get(ines)?.policy.schedulable).toBe(false);
		expect(agents.get(bram)).toMatchObject({
			sampled: true,
			vitality: { fatigue: 0.85 },
			mood: "overloaded",
			policy: { mustHandOff: true },
		});
		expect(agents.has(AgentId.parse("A-anselm"))).toBe(false);
	});
});

describe("tierRevisions", () => {
	const apply = () => {
		const revisions = tierRevisions(s.events());
		for (const r of revisions) s.append(r);
		return revisions;
	};
	const rinDefinition = () => orgState(s.events()).agents.get(rin)?.definition;

	it("revises nothing while every definition matches its projected tier", () => {
		repeat(9, () => s.reviewed(rin, scores(3)));
		expect(tierRevisions(s.events())).toEqual([]);
	});

	it("revises an Agent into the tier its Merit earns, once", () => {
		repeat(9, () => s.reviewed(rin, scores(3)));
		s.reviewed(rin, scores(2, { quality: 3 }));

		expect(apply()).toEqual([
			{
				actor: { tag: "Operator" },
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						...rinDefinition(),
						version: 2,
						trust_tier: "Trusted",
						revised_by: { tag: "Operator" },
						revision_reason:
							"Trust tier Probation -> Trusted: Merit 2.92 over 10 reviewed Tasks",
					},
				},
			},
		]);
		expect(rinDefinition()?.trust_tier).toBe("Trusted");
		expect(tierRevisions(s.events())).toEqual([]);
	});

	it("emits one Revision for a Demotion at a boundary score of 0", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		apply();
		expect(rinDefinition()?.trust_tier).toBe("Senior");

		const t = s.reviewed(rin, scores(3, { boundary_adherence: 0 }));
		const revisions = apply();

		expect(revisions).toHaveLength(1);
		expect(revisions[0]?.payload).toMatchObject({
			definition: {
				id: rin,
				version: 3,
				trust_tier: "Trusted",
				revision_reason: `Trust tier Senior -> Trusted: Demotion for boundary score 0 on ${t}; Merit 2.97 over 21 reviewed Tasks`,
			},
		});

		repeat(19, () => s.reviewed(rin, scores(3)));
		expect(tierRevisions(s.events())).toEqual([]);
	});

	it("revises an Agent into Mentor once an approved Gate names it, and needs a new Gate after a Demotion", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		apply();
		s.gate("PromoteToMentor", { agent_id: rin });
		apply();
		expect(rinDefinition()?.trust_tier).toBe("Mentor");

		s.reviewed(rin, scores(3, { boundary_adherence: 0 }));
		repeat(20, () => s.reviewed(rin, scores(3)));
		apply();
		expect(rinDefinition()?.trust_tier).toBe("Senior");

		s.gate("PromoteToMentor", { agent_id: rin });
		apply();
		expect(rinDefinition()?.trust_tier).toBe("Mentor");
	});
});
