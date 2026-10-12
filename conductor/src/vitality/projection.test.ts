import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, NewEvent } from "../events.js";
import { AgentId, TaskId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { orgState, renderTree, tree } from "../org/projection.js";
import type { Actor, EventActor } from "../types/actor.js";
import {
	revisionsCausedBy,
	tierRevisions,
	vitalityProjection,
} from "./projection.js";
import { type Scenario, scenario, scores } from "./scenario.js";
import { reviewSampleOf } from "./trust.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const bram = AgentId.parse("A-bram");
const conductor: EventActor = { tag: "Conductor" };
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

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

describe("the tier catch-up when the Ledger opens for writing", () => {
	const operator: Actor = { tag: "Operator" };
	const late =
		"recorded late: the Ledger before ADR-0011 did not record this Revision";

	// A Ledger written before ADR-0011: no follow-on Revisions, so stored tiers lag.
	let old: Scenario;
	beforeEach(() => {
		old = scenario(undefined, { followOns: [] });
	});
	afterEach(() => rmSync(old.home, { recursive: true, force: true }));

	/** Every Event after opening the Ledger again, as the next command would. */
	const reopened = (writer: boolean): Event[] => {
		const ledger = openLedger({ home: old.home, writer });
		try {
			return ledger.all();
		} finally {
			ledger.close();
		}
	};

	/** Open the Ledger for writing again and append one Event, as the next command would. */
	const appendedAfterReopening = (newEvent: NewEvent): Event => {
		const ledger = openLedger({ home: old.home, writer: true });
		try {
			return ledger.append(newEvent);
		} finally {
			ledger.close();
		}
	};

	const revisions = (events: readonly Event[]) =>
		events.flatMap((e) =>
			e.kind === "AgentDefinitionRevised"
				? [
						{
							seq: e.seq,
							actor: e.actor,
							causation_id: e.causation_id,
							id: e.payload.definition.id,
							version: e.payload.definition.version,
							trust_tier: e.payload.definition.trust_tier,
							revision_reason: e.payload.definition.revision_reason,
						},
					]
				: [],
		);

	const storedTier = (events: readonly Event[], agent: AgentId) =>
		orgState(events).agents.get(agent)?.definition.trust_tier;

	const sampled = (agent: AgentId) =>
		old.append({
			actor: operator,
			kind: "VitalitySampled",
			payload: {
				agent,
				load: 0.2,
				fatigue: 0,
				friction: 0,
				confidence: 1,
				morale: 0,
			},
		});

	const reviewedTenth = (agent: AgentId, score: 2 | 3) => {
		repeat(9, () => old.reviewed(agent, scores(score)));
		const t = old.task(agent);
		old.submit(agent, t);
		return old.review(t, scores(score));
	};

	it("names the GateDecided that promoted a lagging Mentor, not the later Event, and says the Revision is late", () => {
		repeat(20, () => old.reviewed(rin, scores(3)));
		const gate = old.requested("PromoteToMentor", { agent_id: rin });
		const decision = old.decided(gate);
		const later = sampled(rin);
		old.ledger.close();

		expect(revisions(reopened(true))).toEqual([
			{
				seq: later.seq + 1,
				actor: conductor,
				causation_id: decision.seq,
				id: rin,
				version: 2,
				trust_tier: "Mentor",
				revision_reason: `Trust tier Probation -> Mentor: Promotion through PromoteToMentor Gate ${gate}; Merit 3.00 over 20 reviewed Tasks; ${late}`,
			},
		]);
	});

	it("names the Review at which the tier last changed, with the Merit then, before the first caller append", () => {
		const tenth = reviewedTenth(ines, 2);
		repeat(3, () => old.reviewed(ines, scores(2)));
		old.ledger.close();

		const paused = appendedAfterReopening({
			actor: operator,
			kind: "AgentPaused",
			payload: { agent_id: bram, reason: "Catch up first" },
		});

		expect(revisions(reopened(false))).toEqual([
			{
				seq: paused.seq - 1,
				actor: conductor,
				causation_id: tenth.seq,
				id: ines,
				version: 2,
				trust_tier: "Trusted",
				revision_reason: `Trust tier Probation -> Trusted: Merit 2.00 over 10 reviewed Tasks; ${late}`,
			},
		]);
	});

	it("keeps the catch-up when the first append is refused", () => {
		repeat(10, () => old.reviewed(ines, scores(2)));
		old.ledger.close();

		expect(() =>
			appendedAfterReopening({
				actor: operator,
				kind: "AgentResumed",
				payload: { agent_id: bram },
			}),
		).toThrow(`${bram} is not paused`);

		expect(storedTier(reopened(false), ines)).toBe("Trusted");
	});

	it("catches up a Retired Agent whose stored tier lags", () => {
		const tenth = reviewedTenth(ines, 2);
		old.retire(ines, "Replaced");
		old.ledger.close();

		const events = reopened(true);
		expect(storedTier(events, ines)).toBe("Trusted");
		expect(revisions(events)).toMatchObject([
			{ actor: conductor, causation_id: tenth.seq, id: ines },
		]);
	});

	it("appends nothing to a caught-up Ledger, nor to any Ledger opened read-only", () => {
		repeat(10, () => old.reviewed(ines, scores(2)));
		const lagging = old.events().length;
		old.ledger.close();

		expect(reopened(false)).toHaveLength(lagging);
		expect(reopened(true)).toHaveLength(lagging + 1);
		expect(reopened(true)).toHaveLength(lagging + 1);
		expect(reopened(false)).toHaveLength(lagging + 1);
	});

	it("refuses a Conductor Revision whose earlier cause is not where the projected tier last changed, naming that Event", () => {
		repeat(20, () => old.reviewed(rin, scores(3)));
		const decision = old.decided(
			old.requested("PromoteToMentor", { agent_id: rin }),
		);
		const unrelated = sampled(rin);
		sampled(ines);
		const current = orgState(old.events()).agents.get(rin)?.definition;
		if (current === undefined) throw new Error("A-rin is not seeded");

		expect(() =>
			old.append({
				actor: conductor,
				causation_id: unrelated.seq,
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						...current,
						version: current.version + 1,
						trust_tier: "Mentor",
						revised_by: conductor,
						revision_reason: "Trust tier Probation -> Mentor",
					},
				},
			}),
		).toThrow(
			`AgentDefinitionRevised refused: the Conductor's Revision of ${rin} names seq ${unrelated.seq} as its cause, but ${rin}'s projected Trust tier last changed to Mentor at seq ${decision.seq}; a late Revision names seq ${decision.seq}`,
		);
		old.ledger.close();
	});

	it("still refuses an Operator Revision that keeps a lagging tier, naming the projected tier, and org tree prints that tier after the catch-up", () => {
		repeat(10, () => old.reviewed(ines, scores(2)));
		const current = orgState(old.events()).agents.get(ines)?.definition;
		if (current === undefined) throw new Error("A-ines is not seeded");

		expect(() =>
			old.append({
				actor: operator,
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						...current,
						version: current.version + 1,
						capacity: current.capacity + 1,
						revised_by: operator,
						revision_reason: "More capacity",
					},
				},
			}),
		).toThrow(
			`AgentDefinitionRevised refused: ${ines}'s projected Trust tier is Trusted, not Probation`,
		);
		old.ledger.close();
		reopened(true);

		const tree = spawnSync(
			process.execPath,
			["--import", "tsx", cli, "--home", old.home, "org", "tree"],
			{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
		);
		expect(tree.stdout).toContain("Ines, Specialist, Trusted");
	});

	it("leaves Retired Agents out of the follow-on Revisions", () => {
		repeat(10, () => old.reviewed(rin, scores(3)));
		repeat(10, () => old.reviewed(ines, scores(2)));
		old.retire(ines, "Replaced");
		const events = old.events();
		old.ledger.close();

		const last = events.at(-1);
		if (last === undefined) throw new Error("the Ledger is empty");
		expect(
			tierRevisions(events, last).map((e) =>
				e.kind === "AgentDefinitionRevised"
					? [e.payload.definition.id, e.causation_id]
					: e.kind,
			),
		).toEqual([[rin, last.seq]]);
	});
});
