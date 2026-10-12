import type { Event } from "../events.js";
import { approvedGatesFor, projectGates } from "../gate/projection.js";
import { sha256Hex } from "../hash.js";
import type { AgentId, GateId, TaskId } from "../ids.js";
import type { Review, TrustTier } from "../types/merit.js";
import { type Standing, standingOf } from "./merit.js";
import { workOf } from "./work.js";

const ORDER: readonly TrustTier[] = [
	"Probation",
	"Trusted",
	"Senior",
	"Mentor",
];
const rank = (t: TrustTier) => ORDER.indexOf(t);
const below = (t: TrustTier): TrustTier => ORDER[Math.max(0, rank(t) - 1)] ?? t;

export type TierInput = Standing & { readonly mentorGateApproved: boolean };

/**
 * Merit and tenure needed for each tier, from the Trust tier table of
 * docs/design/vitality-and-merit.md. Mentor adds the PromoteToMentor Gate.
 */
export const TIER_THRESHOLDS = {
	Trusted: { merit: 2.0, reviewedTasks: 10 },
	Senior: { merit: 2.5, reviewedTasks: 20 },
} as const;

const meets = (s: Standing, t: keyof typeof TIER_THRESHOLDS) =>
	s.merit !== undefined &&
	s.merit >= TIER_THRESHOLDS[t].merit &&
	s.reviewedTasks >= TIER_THRESHOLDS[t].reviewedTasks;

/** The highest tier Merit and tenure reach, ignoring boundary scores. */
const meritTier = (input: TierInput): TrustTier => {
	if (meets(input, "Senior")) {
		return input.mentorGateApproved ? "Mentor" : "Senior";
	}
	return meets(input, "Trusted") ? "Trusted" : "Probation";
};

/**
 * The tier an Agent qualifies for: Merit and tenure, and no boundary score
 * below 2 in the window. This is the bar for a Promotion; `trustTierOf`
 * decides what an Agent already holding a tier keeps.
 */
export const tierOf = (input: TierInput): TrustTier =>
	input.window.some((r) => r.boundary_adherence < 2)
		? "Probation"
		: meritTier(input);

/**
 * One step of the Trust tier after a Review or an approved PromoteToMentor Gate:
 * - a boundary score of 0 demotes one tier at once;
 * - otherwise the Agent is promoted to the tier it qualifies for, if higher;
 * - and falls to the tier its Merit and tenure still reach, if lower.
 * A 0 in the window keeps `tierOf` at Probation, so the lost tier cannot be
 * regained until the 0 leaves the window.
 */
const step = (
	current: TrustTier,
	input: TierInput,
	latest: Review | undefined,
): TrustTier => {
	if (latest?.boundary_adherence === 0) return below(current);
	const qualified = tierOf(input);
	if (rank(qualified) > rank(current)) return qualified;
	const supported = meritTier(input);
	return rank(supported) < rank(current) ? supported : current;
};

export type TrustStanding = {
	readonly tier: TrustTier;
	readonly standing: Standing;
	/** Approved PromoteToMentor Gates naming the Agent that no Promotion has used, oldest first. */
	readonly unusedMentorGates: readonly GateId[];
	/** The Gate the current Mentor tenure used; absent below Mentor. */
	readonly mentorGate?: GateId;
};

type Step =
	| { readonly seq: number; readonly tag: "Review"; readonly review: Review }
	| { readonly seq: number; readonly tag: "Approval"; readonly gate: GateId };

/**
 * The decisions approving PromoteToMentor Gates that name the Agent, so they
 * interleave with its Reviews in Ledger order.
 */
const mentorApprovals = (events: readonly Event[], agent: AgentId): Step[] => {
	const approved = new Set(
		approvedGatesFor(projectGates(events), "PromoteToMentor", agent).map(
			(gate) => gate.id,
		),
	);
	return events.flatMap((e): Step[] =>
		e.kind === "GateDecided" && approved.has(e.payload.gate_id)
			? [{ seq: e.seq, tag: "Approval", gate: e.payload.gate_id }]
			: [],
	);
};

/**
 * The Agent's Trust tier, folded from Probation at Recruitment over its
 * counted Reviews and approved PromoteToMentor Gates in Ledger order. One
 * Gate covers one Promotion to Mentor: a step into Mentor uses the oldest
 * unused Gate, and a Demotion from Mentor leaves it used, so a return to
 * Mentor needs another.
 */
export const trustTierOf = (
	events: readonly Event[],
	agent: AgentId,
): TrustStanding => {
	const steps: Step[] = [
		...workOf(events, agent).reviews.map(
			(r): Step => ({ seq: r.seq, tag: "Review", review: r.review }),
		),
		...mentorApprovals(events, agent),
	].sort((a, b) => a.seq - b.seq);

	let tier: TrustTier = "Probation";
	let mentorGate: GateId | undefined;
	const unused: GateId[] = [];
	const counted: Review[] = [];
	for (const s of steps) {
		if (s.tag === "Approval") unused.push(s.gate);
		else counted.push(s.review);
		const next = step(
			tier,
			{
				...standingOf(counted),
				mentorGateApproved: tier === "Mentor" || unused.length > 0,
			},
			s.tag === "Review" ? s.review : undefined,
		);
		if (next !== "Mentor") mentorGate = undefined;
		else if (tier !== "Mentor") mentorGate = unused.shift();
		tier = next;
	}
	return {
		tier,
		standing: standingOf(counted),
		unusedMentorGates: unused,
		...(mentorGate === undefined ? {} : { mentorGate }),
	};
};

/**
 * Why a definition may not record `tier` for the Agent, or undefined when it
 * may: only the projected Trust tier is allowed.
 */
export const tierRefusal = (
	events: readonly Event[],
	agent: AgentId,
	tier: TrustTier,
): string | undefined => {
	const projected = trustTierOf(events, agent);
	if (projected.tier === tier) return undefined;
	if (tier === "Mentor" && projected.unusedMentorGates.length === 0) {
		return `${agent} cannot be Mentor: no approved, unused PromoteToMentor Gate names it; its projected Trust tier is ${projected.tier}`;
	}
	return `${agent}'s projected Trust tier is ${projected.tier}, not ${tier}`;
};

/** How many Tasks per Review each tier gets: 1 in n. */
export const REVIEW_ONE_IN: Readonly<Record<TrustTier, number>> = {
	Probation: 1,
	Trusted: 3,
	Senior: 5,
	Mentor: 5,
};

/**
 * Whether a Task of an Agent at `tier` gets a Review. Chosen from the hash of
 * the Task id, never at random, so every fold of the Ledger picks the same
 * Tasks.
 */
export const reviewSampled = (taskId: TaskId, tier: TrustTier): boolean =>
	Number.parseInt(sha256Hex(taskId).slice(0, 8), 16) % REVIEW_ONE_IN[tier] ===
	0;

/**
 * Whether a Task of `assignee` must be reviewed: the assignee's projected
 * Trust tier, and whether the sample for that tier picks the Task.
 */
export const reviewSampleOf = (
	events: readonly Event[],
	assignee: AgentId,
	taskId: TaskId,
): { readonly tier: TrustTier; readonly sampled: boolean } => {
	const { tier } = trustTierOf(events, assignee);
	return { tier, sampled: reviewSampled(taskId, tier) };
};
