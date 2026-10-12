import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "./ids.js";
import { orgState } from "./org/projection.js";
import type { Actor } from "./types/actor.js";
import type { AgentDefinition } from "./types/agent-definition.js";
import { type Scenario, scenario } from "./vitality/scenario.js";

const rin = AgentId.parse("A-rin");
const operator: Actor = { tag: "Operator" };

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const current = (): AgentDefinition => {
	const agent = orgState(s.events()).agents.get(rin);
	if (agent === undefined) throw new Error("A-rin is not seeded");
	return agent.definition;
};

const revise = (actor: Actor, changes: Partial<AgentDefinition>) => {
	const definition = current();
	return () =>
		s.append({
			actor,
			kind: "AgentDefinitionRevised",
			payload: {
				definition: {
					...definition,
					version: definition.version + 1,
					revised_by: actor,
					revision_reason: "ADR check",
					...changes,
				},
			},
		});
};

describe("ADR rules the slice-0 review found missing", () => {
	it("refuses AgentRetired when its Gate is a RetireAgent Gate the Operator rejected (ADR-0006)", () => {
		const gate_id = s.gate("RetireAgent", { agent_id: rin }, "reject");

		expect(() =>
			s.append({
				actor: operator,
				kind: "AgentRetired",
				payload: { agent_id: rin, reason: "Replaced", gate_id },
			}),
		).toThrow(
			`AgentRetired refused: ${gate_id} is a RetireAgent Gate, Rejected, naming A-rin; retiring A-rin needs an approved RetireAgent Gate naming it`,
		);
	});

	it("refuses a Revision to Mentor without an approved PromoteToMentor Gate (ADR-0007)", () => {
		s.gate("PromoteToMentor", { agent_id: rin }, "reject");

		expect(revise(operator, { trust_tier: "Mentor" })).toThrow(
			"AgentDefinitionRevised refused: A-rin cannot become Mentor without an approved PromoteToMentor Gate naming it; none is approved",
		);
	});

	it("refuses a Revision whose revised_by is not the actor that writes it (ADR-0005)", () => {
		const mabel: Actor = { tag: "Agent", id: AgentId.parse("A-mabel") };

		expect(revise(operator, { revised_by: mabel })).toThrow(
			"AgentDefinitionRevised refused: A-rin's definition names A-mabel as revised_by, but the actor is Operator",
		);
	});
});
