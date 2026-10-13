import type { AppendGuard } from "../append-guard.js";
import type { Event } from "../events.js";
import {
	agentNamedBy,
	approvedGatesFor,
	gateState,
} from "../gate/projection.js";
import { canonicalJson } from "../hash.js";
import type { AgentId } from "../ids.js";
import type { Projections } from "../projections.js";
import { actorText } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { tierCauseRefusal, tierRefusal } from "../vitality/trust.js";

/**
 * Why a Retired Agent's status may not change. An Agent not in the Org is
 * left to the Org Projection, which refuses every Event about it.
 */
const retiredRefusal = (projections: Projections, id: AgentId) =>
	projections.org.agents.get(id)?.retired
		? `${id} is Retired; its status can no longer change`
		: undefined;

/**
 * Retirement is a Gate action (ADR-0006): the Operator retires an Agent
 * through an approved RetireAgent Gate whose payload names it.
 */
const retirementRefusal = (
	projections: Projections,
	event: Extract<Event, { kind: "AgentRetired" }>,
): string | undefined => {
	const { agent_id, gate_id } = event.payload;
	if (event.actor.tag !== "Operator") {
		return `only the Operator retires an Agent; ${actorText(event.actor)} tried to retire ${agent_id}`;
	}
	if (gate_id === undefined) {
		return `retiring ${agent_id} needs an approved RetireAgent Gate naming it; none was given`;
	}
	const { gates } = projections;
	if (
		approvedGatesFor(gates, "RetireAgent", agent_id).some(
			(g) => g.id === gate_id,
		)
	) {
		return undefined;
	}
	const gate = gates.gates.get(gate_id);
	if (gate === undefined) return `no Gate ${gate_id} was requested`;
	return `${gate_id} is a ${gate.kind} Gate, ${gateState(gate, new Date(event.ts))}, naming ${agentNamedBy(gate) ?? "no Agent"}; retiring ${agent_id} needs an approved RetireAgent Gate naming it`;
};

/** A definition's author is the actor that writes it (ADR-0005). */
const authorRefusal = (event: Event, definition: AgentDefinition) =>
	canonicalJson(definition.revised_by) === canonicalJson(event.actor)
		? undefined
		: `${definition.id}'s definition names ${actorText(definition.revised_by)} as revised_by, but the actor is ${actorText(event.actor)}`;

const TIER_REVISION_FIELDS: ReadonlySet<string> = new Set([
	"version",
	"trust_tier",
	"revised_by",
	"revision_reason",
] satisfies (keyof AgentDefinition)[]);

/**
 * The Conductor authors only the tier Revisions that Merit and Gates require
 * (ADR-0011): each changes the tier and nothing else, and names the Event
 * where the projected tier last changed to the tier it records. The rules
 * every Revision follows, including that the tier is the projected one, run
 * after this in `orgGuard`.
 */
const conductorGuard: AppendGuard = (projections, event) => {
	if (event.actor.tag !== "Conductor") return undefined;
	if (event.kind !== "AgentDefinitionRevised") {
		return "the Conductor authors only tier Revisions";
	}
	const { definition } = event.payload;
	const { causation_id } = event;
	if (causation_id === undefined) {
		return `the Conductor's Revision of ${definition.id} names no causation_id`;
	}
	if (causation_id >= event.seq) {
		return `causation_id ${causation_id} names no Event in the Ledger`;
	}
	const current = projections.org.agents.get(definition.id)?.definition;
	if (current === undefined) return undefined;
	const fields = new Set([...Object.keys(current), ...Object.keys(definition)]);
	const changed = [...fields].filter(
		(field) =>
			!TIER_REVISION_FIELDS.has(field) &&
			canonicalJson(current[field as keyof AgentDefinition]) !==
				canonicalJson(definition[field as keyof AgentDefinition]),
	);
	if (changed.length > 0) {
		return `the Conductor's Revision of ${definition.id} may change only its Trust tier; it also changes ${changed.join(", ")}`;
	}
	if (definition.trust_tier === current.trust_tier) {
		return `the Conductor's Revision of ${definition.id} leaves its Trust tier at ${current.trust_tier}`;
	}
	return tierCauseRefusal(
		projections.trust,
		definition.id,
		definition.trust_tier,
		causation_id,
	);
};

/**
 * Org rules at append. Definitions follow ADR-0005: each names the actor
 * that wrote it as `revised_by`, Revisions go one version at a time, and
 * only the Operator revises the Auditor, apart from the Conductor's tier
 * Revisions. Whether the Agent is in the Org is the Org Projection's to say.
 */
const orgGuard: AppendGuard = (projections, event) => {
	switch (event.kind) {
		case "AgentRecruited":
			return (
				authorRefusal(event, event.payload) ??
				tierRefusal(
					projections.trust,
					event.payload.id,
					event.payload.trust_tier,
				)
			);
		case "AgentDefinitionRevised": {
			const { definition } = event.payload;
			const current = projections.org.agents.get(definition.id)?.definition;
			if (current === undefined) return undefined;
			if (current.role === "Auditor" && event.actor.tag === "Agent") {
				return `the Auditor can only be revised by the Operator; ${actorText(event.actor)} tried to revise ${current.id} (${current.name}, version ${current.version})`;
			}
			if (definition.version !== current.version + 1) {
				return `${current.id} is at version ${current.version}, so its next Revision is version ${current.version + 1}, not ${definition.version}`;
			}
			return (
				authorRefusal(event, definition) ??
				tierRefusal(projections.trust, definition.id, definition.trust_tier)
			);
		}
		case "AgentPaused":
			return retiredRefusal(projections, event.payload.agent_id);
		case "AgentRetired":
			return (
				retiredRefusal(projections, event.payload.agent_id) ??
				retirementRefusal(projections, event)
			);
		case "AgentResumed": {
			const { agent_id } = event.payload;
			const agent = projections.org.agents.get(agent_id);
			if (agent === undefined) return undefined;
			return (
				retiredRefusal(projections, agent_id) ??
				(agent.paused ? undefined : `${agent_id} is not paused`)
			);
		}
		default:
			return undefined;
	}
};

export const orgGuards: readonly AppendGuard[] = [conductorGuard, orgGuard];
