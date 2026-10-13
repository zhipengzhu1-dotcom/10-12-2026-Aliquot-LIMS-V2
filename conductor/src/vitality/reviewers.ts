import type { AgentId, TaskId } from "../ids.js";
import { notInOrg } from "../org/projection.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { type Actor, actorText } from "../types/actor.js";
import type { Role } from "../types/agent-definition.js";
import type { TrustTier } from "../types/merit.js";
import { trustOf } from "./trust.js";

/**
 * Who reviews an Agent of each role, per "Reviews produce Merit" in
 * docs/design/vitality-and-merit.md: the live Agents of a role, or the
 * Operator. The Specialists report to every Supervisor as one pool, so any
 * Supervisor reviews them. The design names no reviewer for the Developer
 * and the Tester, who join in slice 2; they take the Specialists' rule.
 */
const REVIEWED_BY: Readonly<Record<Role, Role | "Operator">> = {
	Director: "Operator",
	Steward: "Operator",
	Auditor: "Operator",
	Supervisor: "Director",
	Specialist: "Supervisor",
	Developer: "Supervisor",
	Tester: "Supervisor",
};

/** The tiers whose Agents may also review an Agent on Probation. */
const REVIEW_PROBATION: readonly TrustTier[] = ["Senior", "Mentor"];

const liveIds = (
	projections: Projections,
	keep: (role: Role, tier: TrustTier) => boolean,
): AgentId[] =>
	[...projections.org.agents.values()]
		.filter(
			({ definition: d, retired }) =>
				!retired && keep(d.role, trustOf(projections.trust, d.id).tier),
		)
		.map(({ definition }) => definition.id);

const orList = (ids: readonly string[]) =>
	ids.length === 0
		? "none"
		: ids.length === 1
			? ids.join("")
			: `${ids.slice(0, -1).join(", ")} or ${ids.at(-1)}`;

const article = (word: string) => (/^[AEIOU]/.test(word) ? "an" : "a");

/**
 * Who may review a Task of one Agent: the Operator when `by` names it, else
 * the live Agents of role `by`; the Auditors; and, while the Agent is on
 * Probation, the Senior and Mentor Agents. Never the Agent itself.
 */
type Reviewers = {
	readonly role: Role;
	readonly onProbation: boolean;
	readonly by: Role | "Operator";
	readonly byRole: readonly AgentId[];
	readonly auditors: readonly AgentId[];
	readonly seniors: readonly AgentId[];
};

const reviewersOf = (
	projections: Projections,
	assignee: AgentId,
): Reviewers | Refusal => {
	const role = projections.org.agents.get(assignee)?.definition.role;
	if (role === undefined) return new Refusal(notInOrg(assignee));
	const by = REVIEWED_BY[role];
	const onProbation = trustOf(projections.trust, assignee).tier === "Probation";
	const others = (keep: (role: Role, tier: TrustTier) => boolean) =>
		liveIds(projections, keep).filter((id) => id !== assignee);
	return {
		role,
		onProbation,
		by,
		byRole: by === "Operator" ? [] : others((r) => r === by),
		auditors: others((r) => r === "Auditor"),
		seniors: onProbation
			? others((_, tier) => REVIEW_PROBATION.includes(tier))
			: [],
	};
};

const mayReview = (r: Reviewers, reviewer: Actor): boolean =>
	reviewer.tag === "Operator"
		? r.by === "Operator"
		: [...r.byRole, ...r.auditors, ...r.seniors].includes(reviewer.id);

/**
 * The reviewer a completion of `assignee`'s Task names when the caller names
 * none: the Operator or the first live Agent of the role that reviews it,
 * else the first Auditor; undefined when no one may.
 */
export const reviewerOf = (
	projections: Projections,
	assignee: AgentId,
): Actor | undefined => {
	const r = reviewersOf(projections, assignee);
	if (r instanceof Refusal) return undefined;
	if (r.by === "Operator") return { tag: "Operator" };
	const [id] = [...r.byRole, ...r.auditors, ...r.seniors];
	return id === undefined ? undefined : { tag: "Agent", id };
};

/**
 * Whether `reviewer` may review a Task of `assignee`, or why not: the
 * assignee never reviews its own Task, and any other reviewer must be the
 * one its role names, the Auditor, or, while the assignee is on Probation,
 * a Senior or Mentor Agent. The completion that names a reviewer and the
 * Review itself are both decided here, so the two cannot disagree.
 */
export const reviewerRefusal = (
	projections: Projections,
	task_id: TaskId,
	assignee: AgentId,
	reviewer: Actor,
): Refusal | undefined => {
	if (reviewer.tag === "Agent" && reviewer.id === assignee) {
		return new Refusal(
			`${assignee} is the assignee of ${task_id} and cannot review it`,
		);
	}
	const r = reviewersOf(projections, assignee);
	if (r instanceof Refusal) return r;
	if (mayReview(r, reviewer)) return undefined;
	const whom = [
		r.by === "Operator"
			? "the Operator"
			: `${article(r.by)} ${r.by} (${orList(r.byRole)})`,
		`the Auditor (${orList(r.auditors)})`,
		...(r.onProbation
			? [`a Senior or Mentor Agent (${orList(r.seniors)})`]
			: []),
	];
	const status = r.onProbation ? `${r.role} on Probation` : r.role;
	return new Refusal(
		`${assignee} is ${article(r.role)} ${status}, reviewed by ${whom.slice(0, -1).join(", ")} or ${whom.at(-1)}; ${actorText(reviewer)} may not review ${task_id}`,
	);
};
