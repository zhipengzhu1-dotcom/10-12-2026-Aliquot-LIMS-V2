import type { Event } from "../events.js";
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
	readonly mentorGateApproved: boolean;
};

/**
 * Approvals of PromoteToMentor Gates whose payload names the Agent as
 * `agent_id`, by the seq of the decision.
 */
const mentorApprovals = (events: Iterable<Event>, agent: AgentId): number[] => {
	const forAgent = new Set<GateId>();
	const approvals: number[] = [];
	for (const e of events) {
		if (e.kind === "GateRequested" && e.payload.kind === "PromoteToMentor") {
			const p = e.payload.payload;
			if (
				typeof p === "object" &&
				p !== null &&
				!Array.isArray(p) &&
				p.agent_id === agent
			) {
				forAgent.add(e.payload.gate_id);
			}
		} else if (
			e.kind === "GateDecided" &&
			e.payload.meaning === "approve" &&
			forAgent.has(e.payload.gate_id)
		) {
			approvals.push(e.seq);
		}
	}
	return approvals;
};

/**
 * The Agent's Trust tier, folded from Probation at Recruitment over its
 * counted Reviews and approved PromoteToMentor Gates in Ledger order. A Demotion from
 * Mentor uses up the Gate: returning to Mentor needs a new one.
 */
export const trustTierOf = (
	events: readonly Event[],
	agent: AgentId,
): TrustStanding => {
	const steps = [
		...workOf(events, agent).reviews.map((r) => ({
			seq: r.seq,
			review: r.review as Review | undefined,
		})),
		...mentorApprovals(events, agent).map((seq) => ({
			seq,
			review: undefined,
		})),
	].sort((a, b) => a.seq - b.seq);

	let tier: TrustTier = "Probation";
	let gate = false;
	const counted: Review[] = [];
	for (const { review } of steps) {
		if (review === undefined) gate = true;
		else counted.push(review);
		const next = step(
			tier,
			{ ...standingOf(counted), mentorGateApproved: gate },
			review,
		);
		if (tier === "Mentor" && next !== "Mentor") gate = false;
		tier = next;
	}
	return { tier, standing: standingOf(counted), mentorGateApproved: gate };
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
