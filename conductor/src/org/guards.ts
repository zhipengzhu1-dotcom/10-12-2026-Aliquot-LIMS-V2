import { type AppendGuard, reasonOf } from "../append-guard.js";
import type { Event, EventKind } from "../events.js";
import {
	agentNamedBy,
	approvedGatesFor,
	type DecidedGate,
	gateState,
} from "../gate/projection.js";
import { canonicalJson } from "../hash.js";
import type { AgentId, GateId } from "../ids.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { Action, isAction } from "../types/action.js";
import { actorText, type EventActor } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { tierCauseRefusal, tierRefusal } from "../vitality/trust.js";
import { notInOrg } from "./projection.js";

/**
 * Why a Retired Agent's status may not change. An Agent not in the Org is
 * left to the Org Projection, which refuses every Event about it.
 */
const retiredRefusal = (projections: Projections, id: AgentId) =>
	projections.org.agents.get(id)?.retired
		? `${id} is Retired; its status can no longer change`
		: undefined;

/**
 * Retirement is a Gate action (ADR-0006): the Operator retires a live Agent
 * through an approved RetireAgent Gate whose payload names it. The Gate, or
 * why the retirement is refused at `at`.
 */
export const retirementGate = (
	projections: Projections,
	{
		actor,
		agent_id,
		gate_id,
	}: {
		readonly actor: EventActor;
		readonly agent_id: AgentId;
		readonly gate_id?: GateId | undefined;
	},
	at: Date,
): DecidedGate | Refusal => {
	if (!projections.org.agents.has(agent_id)) {
		return new Refusal(notInOrg(agent_id));
	}
	const retired = retiredRefusal(projections, agent_id);
	if (retired !== undefined) return new Refusal(retired);
	if (actor.tag !== "Operator") {
		return new Refusal(
			`only the Operator retires an Agent; ${actorText(actor)} tried to retire ${agent_id}`,
		);
	}
	if (gate_id === undefined) {
		return new Refusal(
			`retiring ${agent_id} needs an approved RetireAgent Gate naming it; none was given`,
		);
	}
	const { gates } = projections;
	const approved = approvedGatesFor(gates, "RetireAgent", agent_id).find(
		(g) => g.id === gate_id,
	);
	if (approved !== undefined) return approved;
	const gate = gates.gates.get(gate_id);
	if (gate === undefined)
		return new Refusal(`no Gate ${gate_id} was requested`);
	return new Refusal(
		`${gate_id} is a ${gate.kind} Gate, ${gateState(gate, at)}, naming ${agentNamedBy(gate) ?? "no Agent"}; retiring ${agent_id} needs an approved RetireAgent Gate naming it`,
	);
};

/** A definition's author is the actor that writes it (ADR-0005). */
const authorRefusal = (event: Event, definition: AgentDefinition) =>
	canonicalJson(definition.revised_by) === canonicalJson(event.actor)
		? undefined
		: `${definition.id}'s definition names ${actorText(definition.revised_by)} as revised_by, but the actor is ${actorText(event.actor)}`;

/** A definition grants only Skills that a SkillPublished has published. */
const skillRefusal = (
	projections: Projections,
	definition: AgentDefinition,
) => {
	const unpublished = definition.skills.find(
		(id) => !projections.training.skills.has(id),
	);
	return unpublished === undefined
		? undefined
		: `${definition.id}'s definition grants the Skill ${unpublished}, which has not been published`;
};

/**
 * A Charter forbids only Actions. A definition recorded before the vocabulary
 * holds free text (ADR-0012), which its Revisions, the Conductor's tier
 * Revisions among them, may carry over; no definition adds any.
 */
const forbiddenRefusal = (
	definition: AgentDefinition,
	current?: AgentDefinition,
) => {
	const carried: readonly string[] = current?.charter.forbidden ?? [];
	const unknown = definition.charter.forbidden.find(
		(entry) => !isAction(entry) && !carried.includes(entry),
	);
	return unknown === undefined
		? undefined
		: `${definition.id}'s Charter forbids ${JSON.stringify(unknown)}, which is not an Action; the Actions are ${Action.options.join(", ")}`;
};

const TIER_REVISION_FIELDS: ReadonlySet<string> = new Set([
	"version",
	"trust_tier",
	"revised_by",
	"revision_reason",
] satisfies (keyof AgentDefinition)[]);

/**
 * The Events the Conductor records of its own acts (ADR-0013). Their own
 * domain's guards hold their rules, including that no one else records them.
 */
const CONDUCTOR_ACTS: ReadonlySet<EventKind> = new Set([
	"TurnStarted",
	"TurnFinished",
	"ActionRefused",
]);

/**
 * Apart from its own acts, the Conductor authors only the tier Revisions that
 * Merit and Gates require (ADR-0011): each changes the tier and nothing else,
 * and names the Event where the projected tier last changed to the tier it
 * records. The rules every Revision follows, including that the tier is the
 * projected one, run after this in `orgGuard`.
 */
const conductorGuard: AppendGuard = (projections, event) => {
	if (event.actor.tag !== "Conductor" || CONDUCTOR_ACTS.has(event.kind)) {
		return undefined;
	}
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
				forbiddenRefusal(event.payload) ??
				skillRefusal(projections, event.payload) ??
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
				forbiddenRefusal(definition, current) ??
				skillRefusal(projections, definition) ??
				tierRefusal(projections.trust, definition.id, definition.trust_tier)
			);
		}
		case "AgentPaused":
			return retiredRefusal(projections, event.payload.agent_id);
		case "AgentRetired":
			return reasonOf(
				retirementGate(
					projections,
					{ actor: event.actor, ...event.payload },
					new Date(event.ts),
				),
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
