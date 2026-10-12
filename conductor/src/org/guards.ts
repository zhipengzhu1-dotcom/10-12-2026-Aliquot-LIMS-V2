import { type AppendGuard, AppendRefused } from "../append-guard.js";
import type { Event } from "../events.js";
import {
	agentNamedBy,
	approvedGatesFor,
	gateState,
	projectGates,
} from "../gate/projection.js";
import type { AgentId } from "../ids.js";
import { actorText } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { type AgentState, type OrgState, orgState } from "./projection.js";

const existing = (state: OrgState, id: AgentId): AgentState => {
	const agent = state.agents.get(id);
	if (agent === undefined) throw new AppendRefused(`${id} is not in the Org`);
	return agent;
};

const live = (state: OrgState, id: AgentId): AgentState => {
	const agent = existing(state, id);
	if (agent.retired) {
		throw new AppendRefused(
			`${id} is Retired; its status can no longer change`,
		);
	}
	return agent;
};

/**
 * Retirement is a Gate action (ADR-0006): the Operator retires an Agent
 * through an approved RetireAgent Gate whose payload names it.
 */
const checkRetirement = (
	events: readonly Event[],
	event: Extract<Event, { kind: "AgentRetired" }>,
) => {
	const { agent_id, gate_id } = event.payload;
	if (event.actor.tag !== "Operator") {
		throw new AppendRefused(
			`only the Operator retires an Agent; ${actorText(event.actor)} tried to retire ${agent_id}`,
		);
	}
	if (gate_id === undefined) {
		throw new AppendRefused(
			`retiring ${agent_id} needs an approved RetireAgent Gate naming it; none was given`,
		);
	}
	const gates = projectGates(events);
	if (
		approvedGatesFor(gates, "RetireAgent", agent_id).some(
			(g) => g.id === gate_id,
		)
	) {
		return;
	}
	const gate = gates.gates.get(gate_id);
	if (gate === undefined) {
		throw new AppendRefused(`no Gate ${gate_id} was requested`);
	}
	throw new AppendRefused(
		`${gate_id} is a ${gate.kind} Gate, ${gateState(gate, new Date(event.ts))}, naming ${agentNamedBy(gate) ?? "no Agent"}; retiring ${agent_id} needs an approved RetireAgent Gate naming it`,
	);
};

/** How many Revisions have moved `id` into Mentor from another tier. */
const mentorPromotions = (events: readonly Event[], id: AgentId): number => {
	let tier: string | undefined;
	let promotions = 0;
	for (const e of events) {
		const definition =
			e.kind === "AgentRecruited"
				? e.payload
				: e.kind === "AgentDefinitionRevised"
					? e.payload.definition
					: undefined;
		if (definition?.id !== id) continue;
		if (definition.trust_tier === "Mentor" && tier !== "Mentor") {
			promotions += 1;
		}
		tier = definition.trust_tier;
	}
	return promotions;
};

/**
 * Mentor needs the Operator's approval on top of Merit (ADR-0007): each
 * Promotion to Mentor uses one approved PromoteToMentor Gate naming the
 * Agent, so a return to Mentor after a Demotion needs a new Gate.
 */
const checkMentorPromotion = (
	events: readonly Event[],
	from: AgentDefinition,
	to: AgentDefinition,
) => {
	if (to.trust_tier !== "Mentor" || from.trust_tier === "Mentor") return;
	const gates = approvedGatesFor(
		projectGates(events),
		"PromoteToMentor",
		to.id,
	).length;
	if (gates > mentorPromotions(events, to.id)) return;
	const used =
		gates === 0
			? "none is approved"
			: `its ${gates} approved Gate${gates === 1 ? " was" : "s were"} used by earlier Promotions`;
	throw new AppendRefused(
		`${to.id} cannot become Mentor without an approved PromoteToMentor Gate naming it; ${used}`,
	);
};

/**
 * Org rules at append. Revisions follow ADR-0005: one version at a time, and
 * only the Operator revises the Auditor.
 */
const orgGuard: AppendGuard = (ctx, event) => {
	switch (event.kind) {
		case "AgentRecruited": {
			const { id } = event.payload;
			if (orgState(ctx.events).agents.has(id)) {
				throw new AppendRefused(
					`${id} is already in the Org; change it with a Revision`,
				);
			}
			return;
		}
		case "AgentDefinitionRevised": {
			const { definition } = event.payload;
			const current = existing(orgState(ctx.events), definition.id).definition;
			if (current.role === "Auditor" && event.actor.tag !== "Operator") {
				throw new AppendRefused(
					`the Auditor can only be revised by the Operator; ${actorText(event.actor)} tried to revise ${current.id} (${current.name}, version ${current.version})`,
				);
			}
			if (definition.version !== current.version + 1) {
				throw new AppendRefused(
					`Revision to version ${definition.version} refused: ${current.id} is at version ${current.version}; the next must be ${current.version + 1}`,
				);
			}
			checkMentorPromotion(ctx.events, current, definition);
			return;
		}
		case "AgentPaused":
			live(orgState(ctx.events), event.payload.agent_id);
			return;
		case "AgentRetired":
			live(orgState(ctx.events), event.payload.agent_id);
			checkRetirement(ctx.events, event);
			return;
		case "AgentResumed": {
			const { agent_id } = event.payload;
			if (!live(orgState(ctx.events), agent_id).paused) {
				throw new AppendRefused(`${agent_id} is not paused`);
			}
			return;
		}
		default:
			return;
	}
};

export const orgGuards: readonly AppendGuard[] = [orgGuard];
