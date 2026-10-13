import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { decideGate, requestGate } from "../gate/lifecycle.js";
import { AgentId, GateId } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import type { GateKind } from "../types/gate.js";
import { renderTree, tree } from "./projection.js";
import { seedOrg } from "./seed.js";

let ledger: Ledger;

/** Request a Gate as the Operator and decide it. */
const decidedGate = (
	kind: GateKind,
	payload: { agent_id: string; reason?: string },
	meaning: "approve" | "reject" = "approve",
): GateId => {
	const { gate } = requestGate(ledger, {
		actor: { tag: "Operator" },
		kind,
		payload,
	});
	const { id: gate_id, payload_hash } = gate;
	decideGate(ledger, { gate_id, payload_hash, meaning, reason: "Checked" });
	return gate_id;
};

/** Retire `id` as the Operator through an approved RetireAgent Gate. */
const retire = (id: AgentId, reason: string) =>
	ledger.append({
		actor: { tag: "Operator" },
		kind: "AgentRetired",
		payload: {
			agent_id: id,
			reason,
			gate_id: decidedGate("RetireAgent", { agent_id: id, reason }),
		},
	});

beforeEach(() => {
	ledger = openMemoryLedger();
});

afterEach(() => ledger.close());

describe("org seed", () => {
	it("recruits the eight roster Agents on Probation, authored by the Operator", () => {
		const appended = seedOrg(ledger);

		const events = ledger.all();
		expect(appended).toHaveLength(8);
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
		expect(thorne?.charter.forbidden).toEqual(["Do lab work"]);
		expect(agents.find((d) => d.id === "A-bram")?.capacity).toBe(3);
		expect(agents.find((d) => d.id === "A-odile")?.capacity).toBe(5);
	});

	it("appends nothing when run a second time", () => {
		seedOrg(ledger);
		const again = seedOrg(ledger);

		expect(again).toEqual([]);
		expect(ledger.all()).toHaveLength(8);
	});
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

const printedTree = () => renderTree(tree(ledger.projections.org));

describe("org tree", () => {
	it("puts the Operator at the root and the Specialist pool once under the Director, beside both Supervisors", () => {
		seedOrg(ledger);

		expect(printedTree()).toBe(SEEDED_TREE);
	});

	it("names only the live Supervisors the Specialist pool reports to", () => {
		seedOrg(ledger);
		retire(AgentId.parse("A-pia"), "Merged intake into review");

		expect(printedTree()).toContain(
			"|   +-- Anselm, Supervisor, Probation\n" +
				"|   \\-- Specialist pool, reports to Anselm\n" +
				"|       +-- Rin, Specialist, Probation\n",
		);
	});

	it("marks a paused Agent and drops it from the tree once Retired, keeping its Events", () => {
		seedOrg(ledger);
		const rin = AgentId.parse("A-rin");

		ledger.append({
			actor: { tag: "Operator" },
			kind: "AgentPaused",
			payload: { agent_id: rin, reason: "Too many merged cells today" },
		});
		const whilePaused = printedTree();
		retire(rin, "Replaced by a new Specialist");

		expect(whilePaused).toBe(
			SEEDED_TREE.replace(
				"Rin, Specialist, Probation",
				"Rin, Specialist, Probation (paused)",
			),
		);
		expect(printedTree()).toBe(SEEDED_TREE.replace(/^.*Rin.*\n/gm, ""));
		expect(
			ledger
				.all()
				.filter((e) => "agent_id" in e.payload && e.payload.agent_id === rin)
				.map((e) => e.kind),
		).toEqual(["AgentPaused", "AgentRetired"]);
		expect(
			ledger
				.all()
				.some((e) => e.kind === "AgentRecruited" && e.payload.id === rin),
		).toBe(true);
	});
});

const definitionOf = (id: string) => {
	const agent = ledger.projections.org.agents.get(AgentId.parse(id));
	if (agent === undefined) throw new Error(`${id} is not in the Org`);
	return agent.definition;
};

const revise = (id: string, actor: Actor, version?: number) => {
	const current = definitionOf(id);
	return ledger.append({
		actor,
		kind: "AgentDefinitionRevised",
		payload: {
			definition: {
				...current,
				version: version ?? current.version + 1,
				charter: { ...current.charter, purpose: "Audit less" },
				revised_by: actor,
				revision_reason: "Tighten the Charter",
			},
		},
	});
};

const odile: Actor = { tag: "Agent", id: AgentId.parse("A-odile") };
const operator: Actor = { tag: "Operator" };

describe("org guards", () => {
	beforeEach(() => {
		seedOrg(ledger);
	});

	it("refuses a Revision of the Auditor authored by an Agent and writes nothing", () => {
		expect(() => revise("A-thorne", odile)).toThrow(AppendRefused);
		expect(() => revise("A-thorne", odile)).toThrow(
			/the Auditor can only be revised by the Operator/,
		);
		expect(ledger.all()).toHaveLength(8);
		expect(definitionOf("A-thorne").version).toBe(1);
	});

	it("accepts a Revision of the Auditor authored by the Operator and bumps the version", () => {
		revise("A-thorne", operator);

		const thorne = definitionOf("A-thorne");
		expect(thorne.version).toBe(2);
		expect(thorne.charter.purpose).toBe("Audit less");
		expect(thorne.revised_by).toEqual(operator);
	});

	it("refuses a Revision that skips or repeats a version, or names an unknown Agent", () => {
		expect(() => revise("A-pia", operator, 3)).toThrow(
			"AgentDefinitionRevised refused: A-pia is at version 1, so its next Revision is version 2, not 3",
		);
		expect(() => revise("A-pia", operator, 1)).toThrow(AppendRefused);
		const ghost = { ...definitionOf("A-pia"), id: AgentId.parse("A-ghost") };
		expect(() =>
			ledger.append({
				actor: operator,
				kind: "AgentDefinitionRevised",
				payload: { definition: { ...ghost, version: 2 } },
			}),
		).toThrow(/A-ghost is not in the Org/);
		expect(ledger.all()).toHaveLength(8);
	});

	it("records only the projected Trust tier in a Revision or a Recruitment", () => {
		const toTier = (trust_tier: "Senior" | "Mentor" | "Probation") => {
			const current = definitionOf("A-pia");
			return ledger.append({
				actor: operator,
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						...current,
						version: current.version + 1,
						trust_tier,
						revised_by: operator,
						revision_reason: `Trust tier ${current.trust_tier} -> ${trust_tier}`,
					},
				},
			});
		};

		expect(() => toTier("Senior")).toThrow(
			"AgentDefinitionRevised refused: A-pia's projected Trust tier is Probation, not Senior",
		);
		decidedGate("PromoteToMentor", { agent_id: "A-ines" });
		decidedGate("PromoteToMentor", { agent_id: "A-pia" }, "reject");
		decidedGate("RetireAgent", { agent_id: "A-pia" });
		expect(() => toTier("Mentor")).toThrow(
			"AgentDefinitionRevised refused: A-pia cannot be Mentor: no approved, unused PromoteToMentor Gate names it; its projected Trust tier is Probation",
		);
		expect(() =>
			ledger.append({
				actor: operator,
				kind: "AgentRecruited",
				payload: {
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
		const recruit = (revised_by: Actor, actor: Actor) =>
			ledger.append({
				actor,
				kind: "AgentRecruited",
				payload: {
					...pia,
					id: AgentId.parse("A-nova"),
					name: "Nova",
					revised_by,
				},
			});

		expect(() => recruit(odile, operator)).toThrow(
			/AgentRecruited refused: A-nova's definition names A-odile as revised_by, but the actor is Operator/,
		);
		expect(() =>
			ledger.append({
				actor: odile,
				kind: "AgentDefinitionRevised",
				payload: { definition: { ...next, revised_by: operator } },
			}),
		).toThrow(
			/AgentDefinitionRevised refused: A-pia's definition names Operator as revised_by, but the actor is A-odile/,
		);
		expect(() =>
			ledger.append({
				actor: operator,
				kind: "AgentDefinitionRevised",
				payload: {
					definition: { ...next, revised_by: operator, revision_reason: "" },
				},
			}),
		).toThrow(/revision_reason/);
		expect(ledger.all()).toHaveLength(8);

		recruit(odile, odile);
		ledger.append({
			actor: odile,
			kind: "AgentDefinitionRevised",
			payload: { definition: { ...next, revised_by: odile } },
		});
		expect(definitionOf("A-pia").revised_by).toEqual(odile);
	});

	it("refuses a second Recruitment of an existing Agent id", () => {
		expect(() =>
			ledger.append({
				actor: operator,
				kind: "AgentRecruited",
				payload: definitionOf("A-bram"),
			}),
		).toThrow(/A-bram is already in the Org/);
	});

	it("refuses to pause, resume or retire an unknown or Retired Agent", () => {
		const ghost = AgentId.parse("A-ghost");
		const ines = AgentId.parse("A-ines");
		expect(() =>
			ledger.append({
				actor: operator,
				kind: "AgentPaused",
				payload: { agent_id: ghost, reason: "No such Agent" },
			}),
		).toThrow(/A-ghost is not in the Org/);
		retire(ines, "Done");
		for (const body of [
			{ kind: "AgentPaused", payload: { agent_id: ines, reason: "Again" } },
			{ kind: "AgentResumed", payload: { agent_id: ines } },
			{ kind: "AgentRetired", payload: { agent_id: ines, reason: "Again" } },
		] as const) {
			expect(() => ledger.append({ actor: operator, ...body })).toThrow(
				/A-ines is Retired/,
			);
		}
		expect(ledger.all().at(-1)?.kind).toBe("AgentRetired");
	});

	it("retires an Agent only through an approved RetireAgent Gate naming it, as the Operator", () => {
		const bram = AgentId.parse("A-bram");
		const retireWith = (gate_id: GateId | undefined, actor: Actor = operator) =>
			ledger.append({
				actor,
				kind: "AgentRetired",
				payload: {
					agent_id: bram,
					reason: "Replaced",
					...(gate_id === undefined ? {} : { gate_id }),
				},
			});
		const forInes = decidedGate("RetireAgent", { agent_id: "A-ines" });
		const rejected = decidedGate(
			"RetireAgent",
			{ agent_id: "A-bram" },
			"reject",
		);
		const wrongKind = decidedGate("PromoteToMentor", { agent_id: "A-bram" });
		const approved = decidedGate("RetireAgent", { agent_id: "A-bram" });
		const before = ledger.all().length;

		expect(() => retireWith(undefined)).toThrow(
			/AgentRetired refused: retiring A-bram needs an approved RetireAgent Gate naming it/,
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
		expect(ledger.all()).toHaveLength(before);

		retireWith(approved);
		expect(ledger.projections.org.agents.get(bram)?.retired).toBe(true);
	});

	it("refuses to resume an Agent that is not paused", () => {
		const mabel = AgentId.parse("A-mabel");
		const resume = () =>
			ledger.append({
				actor: operator,
				kind: "AgentResumed",
				payload: { agent_id: mabel },
			});

		expect(resume).toThrow(/A-mabel is not paused/);
		ledger.append({
			actor: operator,
			kind: "AgentPaused",
			payload: { agent_id: mabel, reason: "Rest" },
		});
		resume();
		expect(resume).toThrow(/A-mabel is not paused/);
	});
});
