import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, GateId } from "../ids.js";
import { openMemoryLedger } from "../ledger.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { pause, recruit, resume, retire, revise } from "./lifecycle.js";
import { renderTree, tree } from "./projection.js";
import { seedOrg } from "./seed.js";

const operator: Actor = { tag: "Operator" };
const odile: Actor = { tag: "Agent", id: AgentId.parse("A-odile") };

describe("org seed", () => {
	it("recruits the eight roster Agents on Probation, authored by the Operator", () => {
		const ledger = openMemoryLedger();
		const appended = seedOrg(ledger);

		const events = ledger.all();
		expect(appended.map((r) => r.seq)).toEqual(events.map((e) => e.seq));
		expect(events.map((e) => e.kind)).toEqual(Array(8).fill("AgentRecruited"));
		expect(events.every((e) => e.actor.tag === "Operator")).toBe(true);

		const agents = [...ledger.projections.org.agents.values()].map(
			(a) => a.definition,
		);
		expect(agents.map((d) => [d.id, d.name, d.role, d.supervisor_id])).toEqual([
			["A-odile", "Odile", "Director", undefined],
			["A-mabel", "Mabel", "Steward", undefined],
			["A-thorne", "Thorne", "Auditor", undefined],
			["A-pia", "Pia", "Supervisor", "A-odile"],
			["A-anselm", "Anselm", "Supervisor", "A-odile"],
			["A-rin", "Rin", "Specialist", "A-pia"],
			["A-ines", "Ines", "Specialist", "A-pia"],
			["A-bram", "Bram", "Specialist", "A-pia"],
		]);
		expect(agents.every((d) => d.trust_tier === "Probation")).toBe(true);
		expect(agents.every((d) => d.version === 1)).toBe(true);
		const thorne = agents.find((d) => d.id === "A-thorne");
		expect(thorne?.persona.voice).toBe(
			"Dry, precise, and unimpressed by speed",
		);
		expect(
			Object.fromEntries(agents.map((d) => [d.id, d.charter.forbidden])),
			"the roster's forbidden column as Actions",
		).toEqual({
			"A-odile": ["RunScript", "TouchArtifact", "DecideGate"],
			"A-mabel": ["AssignLabWork", "AcceptOwnProposal"],
			"A-thorne": ["DoLabWork"],
			"A-pia": ["TouchResults"],
			"A-anselm": ["VerifyOwnTeamRun"],
			"A-rin": ["RunOutsideSandbox"],
			"A-ines": ["RunOutsideSandbox"],
			"A-bram": ["WriteSystemOfRecord"],
		});
		expect(agents.find((d) => d.id === "A-bram")?.capacity).toBe(3);
		expect(agents.find((d) => d.id === "A-odile")?.capacity).toBe(5);
		ledger.close();
	});

	it("appends nothing when run a second time", () => {
		const ledger = openMemoryLedger();
		seedOrg(ledger);
		const again = seedOrg(ledger);

		expect(again).toEqual([]);
		expect(ledger.all()).toHaveLength(8);
		ledger.close();
	});
});

let s: Scenario;

beforeEach(() => {
	s = scenario();
});

afterEach(() => s.close());

const definitionOf = (id: string): AgentDefinition => {
	const agent = s.ledger.projections.org.agents.get(AgentId.parse(id));
	if (agent === undefined) throw new Error(`${id} is not in the Org`);
	return agent.definition;
};

/** Retire `id` as the Operator through an approved RetireAgent Gate. */
const retired = (id: AgentId, reason: string) =>
	retire(s.ledger, {
		actor: operator,
		agent_id: id,
		gate_id: s.gate("RetireAgent", { agent_id: id }),
		reason,
	});

const SEEDED_TREE = `Operator
+-- Odile, Director, Probation
|   +-- Pia, Supervisor, Probation
|   +-- Anselm, Supervisor, Probation
|   \\-- Specialist pool, reports to Pia and Anselm
|       +-- Rin, Specialist, Probation
|       +-- Ines, Specialist, Probation
|       \\-- Bram, Specialist, Probation
+-- Mabel, Steward, Probation
\\-- Thorne, Auditor, Probation
`;

const printedTree = () => renderTree(tree(s.ledger.projections.org));

describe("org tree", () => {
	it("puts the Operator at the root and the Specialist pool once under the Director, beside both Supervisors", () => {
		expect(printedTree()).toBe(SEEDED_TREE);
	});

	it("names only the live Supervisors the Specialist pool reports to", () => {
		retired(AgentId.parse("A-pia"), "Merged intake into review");

		expect(printedTree()).toContain(
			"|   +-- Anselm, Supervisor, Probation\n" +
				"|   \\-- Specialist pool, reports to Anselm\n" +
				"|       +-- Rin, Specialist, Probation\n",
		);
	});

	it("marks a paused Agent and drops it from the tree once Retired, keeping its Events", () => {
		const rin = AgentId.parse("A-rin");

		pause(s.ledger, {
			actor: operator,
			agent_id: rin,
			reason: "Too many merged cells today",
		});
		const whilePaused = printedTree();
		retired(rin, "Replaced by a new Specialist");

		expect(whilePaused).toBe(
			SEEDED_TREE.replace(
				"Rin, Specialist, Probation",
				"Rin, Specialist, Probation (paused)",
			),
		);
		expect(printedTree()).toBe(SEEDED_TREE.replace(/^.*Rin.*\n/gm, ""));
		expect(
			s
				.events()
				.filter((e) => "agent_id" in e.payload && e.payload.agent_id === rin)
				.map((e) => e.kind),
		).toEqual(["AgentPaused", "AgentRetired"]);
		expect(
			s
				.events()
				.some((e) => e.kind === "AgentRecruited" && e.payload.id === rin),
		).toBe(true);
	});
});

const revised = (id: string, actor: Actor, version?: number) => {
	const current = definitionOf(id);
	return revise(s.ledger, {
		actor,
		definition: {
			...current,
			version: version ?? current.version + 1,
			charter: { ...current.charter, purpose: "Audit less" },
			revised_by: actor,
			revision_reason: "Tighten the Charter",
		},
	});
};

describe("org guards", () => {
	it("refuses a Revision of the Auditor authored by an Agent and writes nothing", () => {
		const before = s.events().length;

		expect(() => revised("A-thorne", odile)).toThrow(AppendRefused);
		expect(() => revised("A-thorne", odile)).toThrow(
			/the Auditor can only be revised by the Operator/,
		);
		expect(s.events()).toHaveLength(before);
		expect(definitionOf("A-thorne").version).toBe(1);
	});

	it("accepts a Revision of the Auditor authored by the Operator and bumps the version", () => {
		revised("A-thorne", operator);

		const thorne = definitionOf("A-thorne");
		expect(thorne.version).toBe(2);
		expect(thorne.charter.purpose).toBe("Audit less");
		expect(thorne.revised_by).toEqual(operator);
	});

	it("refuses a Revision that skips or repeats a version, or names an unknown Agent", () => {
		const before = s.events().length;

		expect(() => revised("A-pia", operator, 3)).toThrow(
			"AgentDefinitionRevised refused: A-pia is at version 1, so its next Revision is version 2, not 3",
		);
		expect(() => revised("A-pia", operator, 1)).toThrow(AppendRefused);
		const ghost = { ...definitionOf("A-pia"), id: AgentId.parse("A-ghost") };
		expect(() =>
			revise(s.ledger, {
				actor: operator,
				definition: { ...ghost, version: 2 },
			}),
		).toThrow(/A-ghost is not in the Org/);
		expect(s.events()).toHaveLength(before);
	});

	it("records only the projected Trust tier in a Revision or a Recruitment", () => {
		const toTier = (trust_tier: "Senior" | "Mentor" | "Probation") => {
			const current = definitionOf("A-pia");
			return revise(s.ledger, {
				actor: operator,
				definition: {
					...current,
					version: current.version + 1,
					trust_tier,
					revised_by: operator,
					revision_reason: `Trust tier ${current.trust_tier} -> ${trust_tier}`,
				},
			});
		};

		expect(() => toTier("Senior")).toThrow(
			"AgentDefinitionRevised refused: A-pia's projected Trust tier is Probation, not Senior",
		);
		s.gate("PromoteToMentor", { agent_id: "A-ines" });
		s.gate("PromoteToMentor", { agent_id: "A-pia" }, "reject");
		s.gate("RetireAgent", { agent_id: "A-pia" });
		expect(() => toTier("Mentor")).toThrow(
			"AgentDefinitionRevised refused: A-pia cannot be Mentor: no approved, unused PromoteToMentor Gate names it; its projected Trust tier is Probation",
		);
		expect(() =>
			recruit(s.ledger, {
				actor: operator,
				definition: {
					...definitionOf("A-pia"),
					id: AgentId.parse("A-nova"),
					name: "Nova",
					trust_tier: "Trusted",
				},
			}),
		).toThrow(
			"AgentRecruited refused: A-nova's projected Trust tier is Probation, not Trusted",
		);

		toTier("Probation");
		expect(definitionOf("A-pia")).toMatchObject({
			version: 2,
			trust_tier: "Probation",
		});
	});

	it("refuses a definition whose author is not the actor, or that gives no reason", () => {
		const pia = definitionOf("A-pia");
		const next = { ...pia, version: 2, revision_reason: "Sharper Charter" };
		const recruited = (revised_by: Actor, actor: Actor) =>
			recruit(s.ledger, {
				actor,
				definition: {
					...pia,
					id: AgentId.parse("A-nova"),
					name: "Nova",
					revised_by,
				},
			});
		const before = s.events().length;

		expect(() => recruited(odile, operator)).toThrow(
			/AgentRecruited refused: A-nova's definition names A-odile as revised_by, but the actor is Operator/,
		);
		expect(() =>
			revise(s.ledger, {
				actor: odile,
				definition: { ...next, revised_by: operator },
			}),
		).toThrow(
			/AgentDefinitionRevised refused: A-pia's definition names Operator as revised_by, but the actor is A-odile/,
		);
		expect(() =>
			revise(s.ledger, {
				actor: operator,
				definition: { ...next, revised_by: operator, revision_reason: "" },
			}),
		).toThrow(/revision_reason/);
		expect(s.events()).toHaveLength(before);

		recruited(odile, odile);
		revise(s.ledger, {
			actor: odile,
			definition: { ...next, revised_by: odile },
		});
		expect(definitionOf("A-pia").revised_by).toEqual(odile);
	});

	it("refuses a second Recruitment of an existing Agent id", () => {
		expect(() =>
			recruit(s.ledger, {
				actor: operator,
				definition: definitionOf("A-bram"),
			}),
		).toThrow(/A-bram is already in the Org/);
	});

	it("refuses to pause, resume or retire an unknown or Retired Agent", () => {
		const ghost = AgentId.parse("A-ghost");
		const ines = AgentId.parse("A-ines");
		expect(() =>
			pause(s.ledger, {
				actor: operator,
				agent_id: ghost,
				reason: "No such Agent",
			}),
		).toThrow(/A-ghost is not in the Org/);
		const gate_id = s.gate("RetireAgent", { agent_id: ines });
		retire(s.ledger, {
			actor: operator,
			agent_id: ines,
			gate_id,
			reason: "Done",
		});
		const again = [
			() =>
				pause(s.ledger, { actor: operator, agent_id: ines, reason: "Again" }),
			() => resume(s.ledger, { actor: operator, agent_id: ines }),
			() =>
				retire(s.ledger, {
					actor: operator,
					agent_id: ines,
					gate_id,
					reason: "Again",
				}),
		];
		for (const verb of again) expect(verb).toThrow(/A-ines is Retired/);
		expect(s.events().at(-1)?.kind).toBe("AgentRetired");
	});

	it("retires an Agent only through an approved RetireAgent Gate naming it, as the Operator", () => {
		const bram = AgentId.parse("A-bram");
		const retireWith = (gate_id: GateId, actor: Actor = operator) =>
			retire(s.ledger, {
				actor,
				agent_id: bram,
				gate_id,
				reason: "Replaced",
			});
		const forInes = s.gate("RetireAgent", { agent_id: "A-ines" });
		const rejected = s.gate("RetireAgent", { agent_id: "A-bram" }, "reject");
		const wrongKind = s.gate("PromoteToMentor", { agent_id: "A-bram" });
		const undecided = s.requested("RetireAgent", { agent_id: "A-bram" });
		const approved = s.gate("RetireAgent", { agent_id: "A-bram" });
		const before = s.events().length;

		expect(() => retireWith(undecided)).toThrow(
			/AgentRetired refused: G-4 is a RetireAgent Gate, Open, naming A-bram/,
		);

		expect(() => retireWith(forInes)).toThrow(
			/G-1 is a RetireAgent Gate, Approved, naming A-ines/,
		);
		expect(() => retireWith(rejected)).toThrow(
			/G-2 is a RetireAgent Gate, Rejected, naming A-bram/,
		);
		expect(() => retireWith(wrongKind)).toThrow(
			/G-3 is a PromoteToMentor Gate, Approved, naming A-bram/,
		);
		expect(() => retireWith(GateId.parse("G-9"))).toThrow(
			/AgentRetired refused: no Gate G-9 was requested/,
		);
		expect(() => retireWith(approved, odile)).toThrow(
			/AgentRetired refused: only the Operator retires an Agent; A-odile tried to retire A-bram/,
		);
		expect(() =>
			s.appendNonTask({
				actor: operator,
				kind: "AgentRetired",
				payload: { agent_id: bram, reason: "Replaced" },
			}),
		).toThrow(
			new AppendRefused(
				"AgentRetired refused: retiring A-bram needs an approved RetireAgent Gate naming it; none was given",
			),
		);
		expect(s.events()).toHaveLength(before);

		retireWith(approved);
		expect(s.ledger.projections.org.agents.get(bram)?.retired).toBe(true);
	});

	it("refuses to resume an Agent that is not paused", () => {
		const mabel = AgentId.parse("A-mabel");
		const resumed = () =>
			resume(s.ledger, { actor: operator, agent_id: mabel });

		expect(resumed).toThrow(/A-mabel is not paused/);
		pause(s.ledger, { actor: operator, agent_id: mabel, reason: "Rest" });
		resumed();
		expect(resumed).toThrow(/A-mabel is not paused/);
	});

	it("refuses to pause an Agent that is already paused", () => {
		const mabel = AgentId.parse("A-mabel");
		const paused = () =>
			pause(s.ledger, { actor: operator, agent_id: mabel, reason: "Rest" });

		paused();
		const before = s.events().length;
		expect(paused).toThrow(
			new AppendRefused("AgentPaused refused: A-mabel is already paused"),
		);
		expect(s.events()).toHaveLength(before);
		resume(s.ledger, { actor: operator, agent_id: mabel });
		paused();
		expect(s.ledger.projections.org.agents.get(mabel)?.paused).toBe(true);
	});
});
