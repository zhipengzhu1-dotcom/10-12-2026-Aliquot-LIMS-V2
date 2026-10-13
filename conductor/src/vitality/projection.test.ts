import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, NewEvent } from "../events.js";
import { AgentId, TaskId } from "../ids.js";
import { openMemoryLedger } from "../ledger.js";
import { type OrgState, renderTree, tree } from "../org/projection.js";
import { seedOrg } from "../org/seed.js";
import type { Projections } from "../projections.js";
import { memoryStorage, type Storage } from "../storage.js";
import { forge, forgeBeforeAdr0011 } from "../test-support/forge.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";
import type { Actor, EventActor } from "../types/actor.js";
import { tierRevisions, vitalityProjection } from "./projection.js";
import { reviewSampleOf, tierCauseRefusal } from "./trust.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const bram = AgentId.parse("A-bram");
const conductor: EventActor = { tag: "Conductor" };

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const repeat = (n: number, f: () => unknown) => {
	for (let i = 0; i < n; i++) f();
};

const view = () =>
	vitalityProjection(s.ledger.projections, {
		now: s.now(),
		energyBudgetTokens: 8000,
	});

const printed = (org: OrgState, name: string) =>
	renderTree(tree(org))
		.split("\n")
		.find((l) => l.includes(`${name}, `));

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
		s.appendNonTask({
			actor: { tag: "Agent", id: AgentId.parse("A-mabel") },
			kind: "RestOrdered",
			payload: { agent_id: ines, action: "begin", reason: "fatigue 0.92" },
		});
		s.appendNonTask({
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
		const agent = s.ledger.projections.org.agents.get(rin);
		if (agent === undefined) throw new Error("A-rin is not seeded");
		return agent.definition;
	};
	const writtenAfter = (cause: Pick<Event, "seq">) =>
		s.events().filter((e) => e.seq > cause.seq);
	const printedRin = () => printed(s.ledger.projections.org, "Rin");
	const reviewOfNextTask = (scored: Parameters<typeof scores>) => {
		const t = s.submitted(rin);
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
		s.close();
		const storage = memoryStorage();
		s = scenario(undefined, { storage });
		/** The Projections of the Ledger as committed up to `seq`. */
		const committedAt = (seq: number): Projections =>
			openMemoryLedger({
				storage: { ...storage, rows: () => [...storage.rows()].slice(0, seq) },
				writer: false,
			}).projections;
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
			const { org, trust } = committedAt(e.seq);
			for (const { definition, retired } of org.agents.values()) {
				if (retired) continue;
				expect(
					definition.trust_tier,
					`${definition.id} after seq ${e.seq}`,
				).toBe(reviewSampleOf(trust, definition.id, anyTask).tier);
			}
		});
	});
});

describe("the tier catch-up when the Ledger opens for writing", () => {
	const operator: Actor = { tag: "Operator" };
	const late =
		"recorded late: the Ledger before ADR-0011 did not record this Revision";

	// `old` writes under the rules in force; `lag` copies its Events into
	// `storage` as a Ledger written before ADR-0011 holds them: without the
	// follow-on Revisions, so stored tiers lag.
	let source: Storage;
	let storage: Storage;
	let old: Scenario;
	beforeEach(() => {
		source = memoryStorage();
		storage = memoryStorage();
		old = scenario(undefined, { storage: source });
	});

	/** Close `old` and forge its Events into `storage`; returns where each of its seqs landed. */
	const lag = () => {
		old.close();
		return forgeBeforeAdr0011(source, storage);
	};

	/** Every Event after opening the Ledger again, as the next command would. */
	const reopened = (writer: boolean): Event[] =>
		openMemoryLedger({ storage, writer }).all();

	/** Open the Ledger for writing again and append one Event, as the next command would. */
	const appendedAfterReopening = (newEvent: NewEvent): Event =>
		openMemoryLedger({ storage }).append(newEvent);

	const lagging = () => openMemoryLedger({ storage, writer: false });

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

	const storedTier = (agent: AgentId) =>
		lagging().projections.org.agents.get(agent)?.definition.trust_tier;

	const sampled = (agent: AgentId) =>
		old.appendNonTask({
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
		return old.review(old.submitted(agent), scores(score));
	};

	it("names the GateDecided that promoted a lagging Mentor, not the later Event, and says the Revision is late", () => {
		repeat(20, () => old.reviewed(rin, scores(3)));
		const gate = old.requested("PromoteToMentor", { agent_id: rin });
		const decision = old.decided(gate);
		const later = sampled(rin);
		const seqOf = lag();

		expect(revisions(reopened(true))).toEqual([
			{
				seq: seqOf(later.seq) + 1,
				actor: conductor,
				causation_id: seqOf(decision.seq),
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
		const seqOf = lag();

		const paused = appendedAfterReopening({
			actor: operator,
			kind: "AgentPaused",
			payload: { agent_id: bram, reason: "Catch up first" },
		});

		expect(revisions(reopened(false))).toEqual([
			{
				seq: paused.seq - 1,
				actor: conductor,
				causation_id: seqOf(tenth.seq),
				id: ines,
				version: 2,
				trust_tier: "Trusted",
				revision_reason: `Trust tier Probation -> Trusted: Merit 2.00 over 10 reviewed Tasks; ${late}`,
			},
		]);
	});

	it("keeps the catch-up when the first append is refused", () => {
		repeat(10, () => old.reviewed(ines, scores(2)));
		lag();

		expect(() =>
			appendedAfterReopening({
				actor: operator,
				kind: "AgentResumed",
				payload: { agent_id: bram },
			}),
		).toThrow(`${bram} is not paused`);

		expect(storedTier(ines)).toBe("Trusted");
	});

	it("catches up a Retired Agent whose stored tier lags", () => {
		const tenth = reviewedTenth(ines, 2);
		old.retire(ines, "Replaced");
		const seqOf = lag();

		const events = reopened(true);
		expect(storedTier(ines)).toBe("Trusted");
		expect(revisions(events)).toMatchObject([
			{ actor: conductor, causation_id: seqOf(tenth.seq), id: ines },
		]);
	});

	it("appends nothing to a caught-up Ledger, nor to any Ledger opened read-only", () => {
		repeat(10, () => old.reviewed(ines, scores(2)));
		lag();
		const forged = [...storage.rows()].length;

		expect(reopened(false)).toHaveLength(forged);
		expect(reopened(true)).toHaveLength(forged + 1);
		expect(reopened(true)).toHaveLength(forged + 1);
		expect(reopened(false)).toHaveLength(forged + 1);
	});

	it("refuses a Conductor Revision whose cause is not where the projected tier last changed, earlier or latest, naming that Event", () => {
		repeat(20, () => old.reviewed(rin, scores(3)));
		const decision = old.decided(
			old.requested("PromoteToMentor", { agent_id: rin }),
		);
		const earlier = sampled(rin);
		const latest = sampled(ines);
		const seqOf = lag();
		// Only a lagging Ledger, which the writer catches up as it opens, has a
		// tier change still to record, so the rule is read on one opened read-only.
		const { trust } = lagging().projections;

		for (const cause of [earlier, latest].map((e) => seqOf(e.seq))) {
			expect(tierCauseRefusal(trust, rin, "Mentor", cause)).toBe(
				`the Conductor's Revision of ${rin} names seq ${cause} as its cause, but ${rin}'s projected Trust tier last changed to Mentor at seq ${seqOf(decision.seq)}; the Revision names seq ${seqOf(decision.seq)}`,
			);
		}
	});

	it("names the Recruitment of an Agent whose stored tier no Review or Gate ever supported", () => {
		old.close();
		const unsupported = memoryStorage();
		const seeded = openMemoryLedger({ storage: unsupported });
		seedOrg(seeded);
		const events = seeded.all();
		const recruited = events.find(
			(e) => e.kind === "AgentRecruited" && e.payload.id === ines,
		);
		const current = seeded.projections.org.agents.get(ines)?.definition;
		if (recruited === undefined || current === undefined) {
			throw new Error("A-ines is not seeded");
		}
		// The Trust tier rules in force refuse this Revision; a Ledger written
		// before them may hold it.
		forge(unsupported, [
			{
				actor: operator,
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						...current,
						version: 2,
						trust_tier: "Trusted",
						revised_by: operator,
						revision_reason: "Trusted by hand before ADR-0011",
					},
				},
			},
		]);

		const ledger = openMemoryLedger({ storage: unsupported });
		expect(revisions(ledger.all()).at(-1)).toEqual({
			seq: events.length + 2,
			actor: conductor,
			causation_id: recruited.seq,
			id: ines,
			version: 3,
			trust_tier: "Probation",
			revision_reason: `Trust tier Trusted -> Probation: no Review or PromoteToMentor Gate has changed the projected tier since Recruitment; ${late}`,
		});
	});

	it("org tree prints a lagging Agent's stored tier until the catch-up, and its projected tier after", () => {
		repeat(10, () => old.reviewed(ines, scores(2)));
		lag();
		const printedInes = () => printed(lagging().projections.org, "Ines");

		expect(printedInes()).toContain("Ines, Specialist, Probation");
		reopened(true);
		expect(printedInes()).toContain("Ines, Specialist, Trusted");
	});

	it("leaves Retired Agents out of the follow-on Revisions", () => {
		repeat(10, () => old.reviewed(rin, scores(3)));
		repeat(10, () => old.reviewed(ines, scores(2)));
		old.retire(ines, "Replaced");
		lag();
		const reader = lagging();
		const last = reader.all().at(-1);
		if (last === undefined) throw new Error("the Ledger is empty");

		expect(
			tierRevisions(reader.projections, last).map((e) =>
				e.kind === "AgentDefinitionRevised"
					? [e.payload.definition.id, e.causation_id]
					: e.kind,
			),
		).toEqual([[rin, last.seq]]);
	});
});
