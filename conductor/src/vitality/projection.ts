import type { Event, NewEvent } from "../events.js";
import type { AgentId, Seq } from "../ids.js";
import { orgState } from "../org/projection.js";
import type { EventActor } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import type { TrustTier } from "../types/merit.js";
import type { Mood, Policy, Vitality } from "../types/vitality.js";
import type { Standing } from "./merit.js";
import { moodOf } from "./mood.js";
import { policyOf } from "./policy.js";
import { type TrustStanding, trustTierOf } from "./trust.js";
import {
	restInEffect,
	type SampleOptions,
	sampleVitality,
} from "./vitality.js";
import { openTasks } from "./work.js";

/** What the Operator sees for one Agent. */
export type AgentVitality = {
	readonly vitality: Vitality;
	/** True when `vitality` is the latest VitalitySampled, false when computed now. */
	readonly sampled: boolean;
	readonly mood: Mood;
	readonly policy: Policy;
	readonly merit: number | undefined;
	readonly reviewedTasks: number;
	readonly tier: TrustTier;
};

const latestSamples = (events: readonly Event[]) => {
	const latest = new Map<AgentId, Vitality>();
	for (const e of events) {
		if (e.kind === "VitalitySampled") latest.set(e.payload.agent, e.payload);
	}
	return latest;
};

/**
 * Vitality, Mood, Policy, Merit and Trust tier for every live Agent, in
 * Recruitment order. Vitality is the Agent's latest VitalitySampled, or a
 * sample computed from the Ledger when it has none. Mood reads Rest and Tasks
 * InProgress from the Ledger as it stands.
 */
export const vitalityProjection = (
	events: readonly Event[],
	options: SampleOptions,
): ReadonlyMap<AgentId, AgentVitality> => {
	const samples = latestSamples(events);
	const view = new Map<AgentId, AgentVitality>();
	for (const { definition, retired } of orgState(events).agents.values()) {
		if (retired) continue;
		const id = definition.id;
		const sample = samples.get(id);
		const vitality = sample ?? sampleVitality(events, id, options);
		const mood = moodOf(
			vitality,
			restInEffect(events, id),
			openTasks(events, id).inProgress > 0,
		);
		const { tier, standing } = trustTierOf(events, id);
		view.set(id, {
			vitality,
			sampled: sample !== undefined,
			mood,
			policy: policyOf(mood),
			merit: standing.merit,
			reviewedTasks: standing.reviewedTasks,
			tier,
		});
	}
	return view;
};

const CONDUCTOR: EventActor = { tag: "Conductor" };

/** The Merit or Gate change behind a tier Revision, given the standing at that change. */
const reasonFor = (
	from: TrustTier,
	t: TrustStanding,
	standing: Standing = t.standing,
): string => {
	const { merit, reviewedTasks, window } = standing;
	const zero = [...window].reverse().find((r) => r.boundary_adherence === 0);
	const meritText = `Merit ${merit === undefined ? "none" : merit.toFixed(2)} over ${reviewedTasks} reviewed Tasks`;
	const why =
		t.mentorGate !== undefined && from !== "Mentor"
			? `Promotion through PromoteToMentor Gate ${t.mentorGate}; ${meritText}`
			: zero === undefined
				? meritText
				: `Demotion for boundary score 0 on ${zero.task_id}; ${meritText}`;
	return `Trust tier ${from} -> ${t.tier}: ${why}`;
};

const tierRevision = (
	definition: AgentDefinition,
	tier: TrustTier,
	cause: Seq,
	reason: string,
): NewEvent => ({
	actor: CONDUCTOR,
	causation_id: cause,
	kind: "AgentDefinitionRevised",
	payload: {
		definition: {
			...definition,
			version: definition.version + 1,
			trust_tier: tier,
			revised_by: CONDUCTOR,
			revision_reason: reason,
		},
	},
});

/**
 * The Ledger's follow-on for every append (ADR-0011): one Revision by the
 * Conductor, caused by `cause`, for each live Agent whose `trust_tier`
 * differs from its projected Trust tier. Empty when every definition
 * matches, which is the case again once these are written.
 */
export const tierRevisions = (
	events: readonly Event[],
	cause: Event,
): NewEvent[] => {
	const revisions: NewEvent[] = [];
	for (const { definition, retired } of orgState(events).agents.values()) {
		if (retired) continue;
		const projected = trustTierOf(events, definition.id);
		if (projected.tier === definition.trust_tier) continue;
		revisions.push(
			tierRevision(
				definition,
				projected.tier,
				cause.seq,
				reasonFor(definition.trust_tier, projected),
			),
		);
	}
	return revisions;
};

/**
 * The Ledger's catch-up when it opens for writing (ADR-0011): one Revision
 * by the Conductor for each Agent, Retired ones too, whose `trust_tier`
 * differs from its projected Trust tier. A Ledger written before ADR-0011
 * left these out, so each names the Event where the projected tier last
 * changed, gives the Merit or Gate change there, and says that it is
 * recorded late.
 */
export const tierCatchUp = (events: readonly Event[]): NewEvent[] => {
	const revisions: NewEvent[] = [];
	for (const { definition } of orgState(events).agents.values()) {
		const projected = trustTierOf(events, definition.id);
		const { lastChange } = projected;
		if (projected.tier === definition.trust_tier || lastChange === undefined) {
			continue;
		}
		const reason =
			lastChange.at === "Recruitment"
				? `Trust tier ${definition.trust_tier} -> ${projected.tier}: no Review or PromoteToMentor Gate has changed the projected tier since Recruitment`
				: reasonFor(definition.trust_tier, projected, lastChange.standing);
		revisions.push(
			tierRevision(
				definition,
				projected.tier,
				lastChange.seq,
				`${reason}; recorded late: the Ledger before ADR-0011 did not record this Revision`,
			),
		);
	}
	return revisions;
};

/** The definitions the Conductor revised because of the Event at `seq`. */
export const revisionsCausedBy = (
	events: readonly Event[],
	seq: Seq,
): AgentDefinition[] =>
	events.flatMap((e) =>
		e.kind === "AgentDefinitionRevised" &&
		e.actor.tag === "Conductor" &&
		e.causation_id === seq
			? [e.payload.definition]
			: [],
	);
