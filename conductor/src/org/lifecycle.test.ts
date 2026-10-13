import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { pause, recruit, resume, retire, revise } from "./lifecycle.js";

const operator: Actor = { tag: "Operator" };
const rin = AgentId.parse("A-rin");

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const definitionOf = (id: AgentId): AgentDefinition => {
	const agent = s.ledger.projections.org.agents.get(id);
	if (agent === undefined) throw new Error(`${id} is not in the Org`);
	return agent.definition;
};

const eventAt = (seq: number) => s.events().find((e) => e.seq === seq);

describe("the Org lifecycle", () => {
	it("names the Agent's previous Org Event as each Event's cause, and the Gate decision as a retirement's, returning the Agent and the seq it appended", () => {
		const recruitment = s
			.events()
			.find((e) => e.kind === "AgentRecruited" && e.payload.id === rin);

		const paused = pause(s.ledger, {
			actor: operator,
			agent_id: rin,
			reason: "Energy budget review",
		});
		const resumed = resume(s.ledger, { actor: operator, agent_id: rin });
		const revised = revise(s.ledger, {
			actor: operator,
			definition: {
				...definitionOf(rin),
				version: 2,
				capacity: 2,
				revised_by: operator,
				revision_reason: "Fewer Tasks at once",
			},
		});
		const gate_id = s.requested("RetireAgent", { agent_id: rin });
		const decided = s.decided(gate_id);
		const retired = retire(s.ledger, {
			actor: operator,
			agent_id: rin,
			gate_id,
			reason: "Replaced",
		});

		expect(paused.agent.paused).toBe(true);
		expect(resumed.agent.paused).toBe(false);
		expect(revised.agent.definition).toMatchObject({ version: 2, capacity: 2 });
		expect(retired.agent.retired).toBe(true);
		expect(
			[paused, resumed, revised, retired].map(({ seq }) => {
				const e = eventAt(seq);
				return [e?.kind, e?.causation_id];
			}),
		).toEqual([
			["AgentPaused", recruitment?.seq],
			["AgentResumed", paused.seq],
			["AgentDefinitionRevised", resumed.seq],
			["AgentRetired", decided.seq],
		]);
	});

	it("recruits with no cause unless the caller names one outside the Org", () => {
		const seeded = s.events().filter((e) => e.kind === "AgentRecruited");
		const gate_id = s.requested("RetireAgent", { agent_id: rin });
		const decided = s.decided(gate_id);

		const nova = recruit(s.ledger, {
			actor: operator,
			definition: { ...definitionOf(rin), id: AgentId.parse("A-nova") },
		});
		const retired = retire(s.ledger, {
			actor: operator,
			agent_id: rin,
			gate_id,
			causation_id: decided.seq,
		});

		expect(seeded).toHaveLength(8);
		expect(seeded.map((e) => e.causation_id)).toEqual(Array(8).fill(undefined));
		expect(nova.agent.definition.id).toBe("A-nova");
		expect(eventAt(nova.seq)?.causation_id).toBeUndefined();
		expect(eventAt(retired.seq)?.causation_id).toBe(decided.seq);
	});

	it("retires with the reason the Gate payload gives when the caller gives none", () => {
		const payload = { agent_id: rin, reason: "Merged cells no more" };
		const gate_id = s.gate("RetireAgent", payload);

		const { seq } = retire(s.ledger, {
			actor: operator,
			agent_id: rin,
			gate_id,
		});

		expect(eventAt(seq)?.payload).toEqual({
			agent_id: rin,
			reason: "Merged cells no more",
			gate_id,
		});
	});
});
