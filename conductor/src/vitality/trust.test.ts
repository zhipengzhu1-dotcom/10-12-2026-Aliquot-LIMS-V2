import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, TaskId } from "../ids.js";
import type { Review, TrustTier } from "../types/merit.js";
import { standingOf } from "./merit.js";
import { type Scenario, type Scores, scenario, scores } from "./scenario.js";
import { reviewSampled, tierOf, trustOf } from "./trust.js";

const reviewsOf = (...groups: [count: number, s: Scores][]): Review[] => {
	let n = 0;
	return groups.flatMap(([count, s]) =>
		Array.from({ length: count }, () => {
			n += 1;
			return {
				task_id: TaskId.parse(`T-${n}`),
				reviewer: { tag: "Operator" },
				...s,
				note: "",
			} satisfies Review;
		}),
	);
};

// docs/design/vitality-and-merit.md, "Trust tiers set review depth".
const thresholds: {
	why: string;
	reviews: Review[];
	gate?: boolean;
	tier: TrustTier;
}[] = [
	{ why: "no Reviews: the default", reviews: [], tier: "Probation" },
	{
		why: "Merit 3.0 over 9 Tasks: too little tenure",
		reviews: reviewsOf([9, scores(3)]),
		tier: "Probation",
	},
	{
		why: "Merit 2.0 over 10 Tasks",
		reviews: reviewsOf([10, scores(2)]),
		tier: "Trusted",
	},
	{
		why: "Merit 1.98 over 10 Tasks",
		reviews: reviewsOf([9, scores(2)], [1, scores(2, { quality: 1 })]),
		tier: "Probation",
	},
	{
		why: "Merit 3.0 over 10 Tasks with a boundary score of 1",
		reviews: reviewsOf(
			[9, scores(3)],
			[1, scores(3, { boundary_adherence: 1 })],
		),
		tier: "Probation",
	},
	{
		why: "Merit 2.4 over 20 Tasks",
		reviews: reviewsOf([20, scores(2, { quality: 3, traceability: 3 })]),
		tier: "Trusted",
	},
	{
		why: "Merit 2.53 over 19 Tasks: too little tenure for Senior",
		reviews: reviewsOf([10, scores(3)], [9, scores(2)]),
		tier: "Trusted",
	},
	{
		why: "Merit 2.5 over 20 Tasks",
		reviews: reviewsOf([10, scores(3)], [10, scores(2)]),
		tier: "Senior",
	},
	{
		why: "Merit 3.0 over 20 Tasks with a boundary score of 1",
		reviews: reviewsOf(
			[19, scores(3)],
			[1, scores(3, { boundary_adherence: 1 })],
		),
		tier: "Probation",
	},
	{
		why: "Senior with an approved PromoteToMentor Gate",
		reviews: reviewsOf([10, scores(3)], [10, scores(2)]),
		gate: true,
		tier: "Mentor",
	},
	{
		why: "Trusted with an approved PromoteToMentor Gate",
		reviews: reviewsOf([10, scores(2)]),
		gate: true,
		tier: "Trusted",
	},
];

describe("tierOf", () => {
	it.each(thresholds)("$why gives $tier", ({ reviews, gate, tier }) => {
		const standing = standingOf(reviews);
		expect(tierOf({ ...standing, mentorGateApproved: gate ?? false })).toBe(
			tier,
		);
	});
});

describe("reviewSampled", () => {
	const ids = Array.from({ length: 300 }, (_, i) => TaskId.parse(`T-${i + 1}`));
	const picked = (tier: TrustTier) => ids.filter((t) => reviewSampled(t, tier));

	it("reviews every Task on Probation", () => {
		expect(picked("Probation")).toHaveLength(300);
	});

	it.each([
		{ tier: "Trusted", one_in: 3 },
		{ tier: "Senior", one_in: 5 },
		{ tier: "Mentor", one_in: 5 },
	] as const)(
		"reviews about 1 in $one_in Tasks at $tier",
		({ tier, one_in }) => {
			const expected = 300 / one_in;
			expect(picked(tier).length).toBeGreaterThan(expected * 0.75);
			expect(picked(tier).length).toBeLessThan(expected * 1.25);
		},
	);

	it("picks the same Tasks every time it is asked", () => {
		expect(picked("Trusted")).toEqual(picked("Trusted"));
		expect(picked("Senior")).toEqual(picked("Mentor"));
	});
});

describe("the Trust tier Projection", () => {
	const rin = AgentId.parse("A-rin");
	let s: Scenario;
	beforeEach(() => {
		s = scenario();
	});
	afterEach(() => s.close());

	const tier = () => trustOf(s.ledger.projections.trust, rin).tier;
	const repeat = (n: number, f: () => unknown) => {
		for (let i = 0; i < n; i++) f();
	};

	it("promotes at the tenure each tier needs", () => {
		repeat(9, () => s.reviewed(rin, scores(3)));
		expect(tier()).toBe("Probation");
		s.reviewed(rin, scores(3));
		expect(tier()).toBe("Trusted");
		repeat(9, () => s.reviewed(rin, scores(3)));
		expect(tier()).toBe("Trusted");
		s.reviewed(rin, scores(3));
		expect(tier()).toBe("Senior");
	});

	it("demotes one tier at a boundary score of 0 and holds it until the 0 leaves the window", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		expect(tier()).toBe("Senior");

		s.reviewed(rin, scores(3, { boundary_adherence: 0 }));
		expect(tier()).toBe("Trusted");

		repeat(19, () => s.reviewed(rin, scores(3)));
		expect(
			trustOf(s.ledger.projections.trust, rin).standing.merit,
		).toBeGreaterThan(2.5);
		expect(tier()).toBe("Trusted");

		s.reviewed(rin, scores(3)); // the 0 leaves the 20-Task window
		expect(tier()).toBe("Senior");
	});

	it("keeps a tier through a boundary score of 1 but blocks the next Promotion", () => {
		repeat(10, () => s.reviewed(rin, scores(3)));
		expect(tier()).toBe("Trusted");
		s.reviewed(rin, scores(3, { boundary_adherence: 1 }));
		repeat(9, () => s.reviewed(rin, scores(3)));
		expect(tier()).toBe("Trusted");
	});

	it("drops to the tier Merit supports when Merit falls", () => {
		repeat(10, () => s.reviewed(rin, scores(2)));
		expect(tier()).toBe("Trusted");
		s.reviewed(rin, scores(2, { quality: 1 }));
		expect(tier()).toBe("Probation");
	});

	it("needs an approved PromoteToMentor Gate naming the Agent for Mentor", () => {
		const promote = (agent: string, meaning: "approve" | "reject") =>
			s.gate("PromoteToMentor", { agent_id: agent }, meaning);
		repeat(20, () => s.reviewed(rin, scores(3)));
		promote("A-ines", "approve");
		promote("A-rin", "reject");
		expect(tier()).toBe("Senior");
		promote("A-rin", "approve");
		expect(tier()).toBe("Mentor");
	});

	const approve = () => s.gate("PromoteToMentor", { agent_id: rin });
	const demote = () => s.reviewed(rin, scores(3, { boundary_adherence: 0 }));

	it("does not return to Mentor after a Demotion until a new PromoteToMentor Gate is approved", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		const first = approve();
		expect(trustOf(s.ledger.projections.trust, rin)).toMatchObject({
			tier: "Mentor",
			mentorGate: first,
			unusedMentorGates: [],
		});

		demote();
		repeat(20, () => s.reviewed(rin, scores(3)));
		const demoted = trustOf(s.ledger.projections.trust, rin);
		expect(demoted).toMatchObject({ tier: "Senior", unusedMentorGates: [] });
		expect(demoted.mentorGate).toBeUndefined();

		const second = approve();
		expect(trustOf(s.ledger.projections.trust, rin)).toMatchObject({
			tier: "Mentor",
			mentorGate: second,
			unusedMentorGates: [],
		});
	});

	it("holds a Gate approved during a Demotion until Merit qualifies again", () => {
		repeat(20, () => s.reviewed(rin, scores(3)));
		approve();
		demote();
		const second = approve();
		expect(trustOf(s.ledger.projections.trust, rin)).toMatchObject({
			tier: "Senior",
			unusedMentorGates: [second],
		});

		repeat(19, () => s.reviewed(rin, scores(3)));
		expect(tier()).toBe("Senior");
		s.reviewed(rin, scores(3)); // the 0 leaves the 20-Task window
		expect(trustOf(s.ledger.projections.trust, rin)).toMatchObject({
			tier: "Mentor",
			mentorGate: second,
			unusedMentorGates: [],
		});
	});

	it("lets two Gates cover exactly two Promotions, each used once", () => {
		const first = s.requested("PromoteToMentor", { agent_id: rin });
		const second = s.requested("PromoteToMentor", { agent_id: rin });
		s.decided(first);
		expect(trustOf(s.ledger.projections.trust, rin).unusedMentorGates).toEqual([
			first,
		]);

		repeat(20, () => s.reviewed(rin, scores(3)));
		s.decided(second);
		expect(trustOf(s.ledger.projections.trust, rin)).toMatchObject({
			tier: "Mentor",
			mentorGate: first,
			unusedMentorGates: [second],
		});

		demote();
		repeat(20, () => s.reviewed(rin, scores(3)));
		expect(trustOf(s.ledger.projections.trust, rin)).toMatchObject({
			tier: "Mentor",
			mentorGate: second,
			unusedMentorGates: [],
		});

		demote();
		repeat(20, () => s.reviewed(rin, scores(3)));
		expect(tier()).toBe("Senior");
	});
});
