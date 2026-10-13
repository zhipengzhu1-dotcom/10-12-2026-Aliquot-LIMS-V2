import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, Seq } from "./ids.js";
import { type Scenario, scenario } from "./test-support/scenario.js";
import type { Actor, EventActor } from "./types/actor.js";
import type { AgentDefinition } from "./types/agent-definition.js";

const rin = AgentId.parse("A-rin");
const operator: Actor = { tag: "Operator" };

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const current = (): AgentDefinition => {
	const agent = s.ledger.projections.org.agents.get(rin);
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

	it("refuses a Revision to Mentor without an approved, unused PromoteToMentor Gate (ADR-0007)", () => {
		s.gate("PromoteToMentor", { agent_id: rin }, "reject");

		expect(revise(operator, { trust_tier: "Mentor" })).toThrow(
			"AgentDefinitionRevised refused: A-rin cannot be Mentor: no approved, unused PromoteToMentor Gate names it; its projected Trust tier is Probation",
		);
	});

	it("refuses a Revision of trust_tier to anything but the projected tier, whoever authors it (ADR-0011)", () => {
		const odile: Actor = { tag: "Agent", id: AgentId.parse("A-odile") };
		const refusal =
			"AgentDefinitionRevised refused: A-rin's projected Trust tier is Probation, not Trusted";

		expect(revise(operator, { trust_tier: "Trusted" })).toThrow(refusal);
		expect(revise(odile, { trust_tier: "Trusted" })).toThrow(refusal);
		s.gate("PromoteToMentor", { agent_id: rin });
		expect(revise(operator, { trust_tier: "Mentor" })).toThrow(
			"AgentDefinitionRevised refused: A-rin's projected Trust tier is Probation, not Mentor",
		);

		revise(operator, { capacity: 4 })();
		expect(current()).toMatchObject({ capacity: 4, trust_tier: "Probation" });
	});

	describe("the Conductor authors only the tier Revisions Merit and Gates require (ADR-0011)", () => {
		const conductor: EventActor = { tag: "Conductor" };
		const tierRevision = (
			changes: Partial<AgentDefinition>,
			causation_id: number | null = 1,
		) => {
			const definition = current();
			return () =>
				s.append({
					actor: conductor,
					...(causation_id === null
						? {}
						: { causation_id: Seq.parse(causation_id) }),
					kind: "AgentDefinitionRevised",
					payload: {
						definition: {
							...definition,
							version: definition.version + 1,
							revised_by: conductor,
							revision_reason: "Trust tier Probation -> Trusted",
							...changes,
						},
					},
				});
		};

		it("refuses any other Event with actor Conductor", () => {
			expect(() =>
				s.append({
					actor: conductor,
					kind: "AgentPaused",
					payload: { agent_id: rin, reason: "Tired" },
				}),
			).toThrow(
				"AgentPaused refused: the Conductor authors only tier Revisions",
			);
		});

		it("refuses a payload that names the Conductor as anything but an author", () => {
			const task_id = s.task(rin);
			expect(() =>
				s.append({
					actor: { tag: "Agent", id: rin },
					task_id,
					kind: "TaskCompleted",
					payload: {
						task_id,
						outputs: [],
						review: {
							tag: "Required",
							reviewer: conductor as unknown as Actor,
						},
					},
				}),
			).toThrow("TaskCompleted refused: not a valid Event");
		});

		it("refuses a Conductor Revision without a causation_id, or whose causation_id names no Event", () => {
			expect(tierRevision({ trust_tier: "Trusted" }, null)).toThrow(
				"AgentDefinitionRevised refused: the Conductor's Revision of A-rin names no causation_id",
			);
			const next = s.events().length + 1;
			expect(tierRevision({ trust_tier: "Trusted" }, next)).toThrow(
				`AgentDefinitionRevised refused: causation_id ${next} names no Event in the Ledger`,
			);
		});

		it("refuses a Conductor Revision that changes another field, or leaves the tier as it is", () => {
			expect(tierRevision({ trust_tier: "Trusted", capacity: 9 })).toThrow(
				"AgentDefinitionRevised refused: the Conductor's Revision of A-rin may change only its Trust tier; it also changes capacity",
			);
			expect(tierRevision({})).toThrow(
				"AgentDefinitionRevised refused: the Conductor's Revision of A-rin leaves its Trust tier at Probation",
			);
		});

		it("refuses a Conductor Revision to a tier other than the projected one", () => {
			expect(tierRevision({ trust_tier: "Trusted" })).toThrow(
				"AgentDefinitionRevised refused: A-rin's projected Trust tier is Probation, not Trusted",
			);
		});
	});

	it("refuses a Revision whose revised_by is not the actor that writes it (ADR-0005)", () => {
		const mabel: Actor = { tag: "Agent", id: AgentId.parse("A-mabel") };

		expect(revise(operator, { revised_by: mabel })).toThrow(
			"AgentDefinitionRevised refused: A-rin's definition names A-mabel as revised_by, but the actor is Operator",
		);
	});
});
