import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../events.js";
import { AgentId, TaskId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { orgState, renderTree, tree } from "../org/projection.js";
import type { Actor } from "../types/actor.js";
import { revisionsCausedBy, vitalityProjection } from "./projection.js";
import { type Scenario, scenario, scores } from "./scenario.js";
import { reviewSampleOf } from "./trust.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const bram = AgentId.parse("A-bram");
const conductor: Actor = { tag: "Conductor" };

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

describe("follow-on tier Revisions", () => {
	const rinDefinition = () => {
		const agent = orgState(s.events()).agents.get(rin);
		if (agent === undefined) throw new Error("A-rin is not seeded");
		return agent.definition;
	};
	const writtenAfter = (cause: Event) =>
		s.events().filter((e) => e.seq > cause.seq);
	const printedRin = () =>
		renderTree(tree(orgState(s.events())))
			.split("\n")
			.find((l) => l.includes("Rin, "));
	const reviewOfNextTask = (scored: Parameters<typeof scores>) => {
		const t = s.task(rin);
		s.submit(rin, t);
		return { t, review: s.review(t, scores(...scored)) };
	};

	it("follows a Review that changes the tier with the Conductor's Revision, caused by the Review, and org tree shows it", () => {
		repeat(9, () => s.reviewed(rin, scores(3)));
		const before = rinDefinition();
		const { review } = reviewOfNextTask([2, { quality: 3 }]);

		const [revision, ...rest] = writtenAfter(review);
		expect(rest).toEqual([]);
		expect(revision).toMatchObject({
			seq: review.seq + 1,
			actor: conductor,
			causation_id: review.seq,
			kind: "AgentDefinitionRevised",
			payload: {
				definition: {
					...before,
					version: 2,
					trust_tier: "Trusted",
					revised_by: conductor,
					revision_reason:
						"Trust tier Probation -> Trusted: Merit 2.92 over 10 reviewed Tasks",
				},
			},
		});
		expect(revisionsCausedBy(s.events(), review.seq)).toEqual([
			rinDefinition(),
		]);
		expect(printedRin()).toContain("Rin, Specialist, Trusted");
	});

	it("follows the approval of a PromoteToMentor Gate with the Revision to Mentor, caused by the GateDecided", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		expect(rinDefinition().trust_tier).toBe("Senior");
		const gate = s.requested("PromoteToMentor", { agent_id: rin });
		const decision = s.decided(gate);

		expect(writtenAfter(decision)).toMatchObject([
			{
				actor: conductor,
				causation_id: decision.seq,
				payload: {
					definition: {
						id: rin,
						trust_tier: "Mentor",
						revision_reason: `Trust tier Senior -> Mentor: Promotion through PromoteToMentor Gate ${gate}; Merit 3.00 over 20 reviewed Tasks`,
					},
				},
			},
		]);
		expect(printedRin()).toContain("Rin, Specialist, Mentor");
	});

	it("follows a Review with a boundary score of 0 with the Demotion, caused by the Review", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		const { t, review } = reviewOfNextTask([3, { boundary_adherence: 0 }]);

		expect(writtenAfter(review)).toMatchObject([
			{
				actor: conductor,
				causation_id: review.seq,
				payload: {
					definition: {
						id: rin,
						version: 4,
						trust_tier: "Trusted",
						revision_reason: `Trust tier Senior -> Trusted: Demotion for boundary score 0 on ${t}; Merit 2.97 over 21 reviewed Tasks`,
					},
				},
			},
		]);
		expect(printedRin()).toContain("Rin, Specialist, Trusted");
	});

	it("catches up a Ledger whose stored tiers lag on its first append, each Revision caused by that append", () => {
		const lagging = scenario(undefined, { followOns: [] });
		repeat(10, () => lagging.reviewed(rin, scores(3)));
		repeat(10, () => lagging.reviewed(ines, scores(2)));
		lagging.ledger.close();
		const ledger = openLedger({ home: lagging.home, writer: true });
		try {
			const cause = ledger.append({
				actor: { tag: "Operator" },
				kind: "AgentPaused",
				payload: { agent_id: bram, reason: "Catch up" },
			});

			expect(
				ledger
					.all()
					.filter((e) => e.seq > cause.seq)
					.map((e) => ({
						actor: e.actor,
						causation_id: e.causation_id,
						agent: e.kind === "AgentDefinitionRevised" && [
							e.payload.definition.id,
							e.payload.definition.trust_tier,
						],
					})),
			).toEqual([
				{ actor: conductor, causation_id: cause.seq, agent: [rin, "Trusted"] },
				{ actor: conductor, causation_id: cause.seq, agent: [ines, "Trusted"] },
			]);
		} finally {
			ledger.close();
			rmSync(lagging.home, { recursive: true, force: true });
		}
	});

	it("stores, after every append, the tier that decides whether each live Agent's Task is sampled for Review", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		s.gate("PromoteToMentor", { agent_id: rin });
		repeat(10, () => s.worked(rin, scores(3)));
		s.reviewed(rin, scores(3, { boundary_adherence: 0 }));
		repeat(10, () => s.worked(rin, scores(3)));
		repeat(15, () => s.worked(ines, scores(2)));

		const events = s.events();
		const skips = events.filter(
			(e) => e.kind === "TaskCompleted" && e.payload.review.tag === "Skipped",
		);
		expect(skips.length).toBeGreaterThan(0);
		expect(
			events.flatMap((e) =>
				e.actor.tag === "Conductor" && e.kind === "AgentDefinitionRevised"
					? [[e.payload.definition.id, e.payload.definition.trust_tier]]
					: [],
			),
		).toEqual([
			[rin, "Trusted"],
			[rin, "Senior"],
			[rin, "Mentor"],
			[rin, "Senior"],
			[ines, "Trusted"],
		]);

		const anyTask = TaskId.parse("T-1");
		events.forEach((e, i) => {
			if (events[i + 1]?.actor.tag === "Conductor") return;
			const committed = events.slice(0, i + 1);
			for (const { definition, retired } of orgState(
				committed,
			).agents.values()) {
				if (retired) continue;
				expect(
					definition.trust_tier,
					`${definition.id} after seq ${e.seq}`,
				).toBe(reviewSampleOf(committed, definition.id, anyTask).tier);
			}
		});
	});
});
