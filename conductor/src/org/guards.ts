import { type AppendGuard, AppendRefused } from "../append-guard.js";
import type { Event } from "../events.js";
import {
	agentNamedBy,
	approvedGatesFor,
	gateState,
	projectGates,
} from "../gate/projection.js";
import { canonicalJson } from "../hash.js";
import type { AgentId } from "../ids.js";
import { actorText } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { tierRefusal } from "../vitality/trust.js";
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
			`AgentRetired refused: only the Operator retires an Agent; ${actorText(event.actor)} tried to retire ${agent_id}`,
		);
	}
	if (gate_id === undefined) {
		throw new AppendRefused(
			`AgentRetired refused: retiring ${agent_id} needs an approved RetireAgent Gate naming it; none was given`,
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
		throw new AppendRefused(
			`AgentRetired refused: no Gate ${gate_id} was requested`,
		);
	}
	throw new AppendRefused(
		`AgentRetired refused: ${gate_id} is a ${gate.kind} Gate, ${gateState(gate, new Date(event.ts))}, naming ${agentNamedBy(gate) ?? "no Agent"}; retiring ${agent_id} needs an approved RetireAgent Gate naming it`,
	);
};

/** A definition's author is the actor that writes it (ADR-0005). */
const checkAuthor = (event: Event, definition: AgentDefinition) => {
	if (canonicalJson(definition.revised_by) === canonicalJson(event.actor)) {
		return;
	}
	throw new AppendRefused(
		`${event.kind} refused: ${definition.id}'s definition names ${actorText(definition.revised_by)} as revised_by, but the actor is ${actorText(event.actor)}`,
	);
};

/**
 * A definition records the projected Trust tier and no other (ADR-0007,
 * ADR-0011), whoever writes it.
 */
const checkTier = (
	events: readonly Event[],
	event: Event,
	definition: AgentDefinition,
) => {
	const reason = tierRefusal(events, definition.id, definition.trust_tier);
	if (reason !== undefined) {
		throw new AppendRefused(`${event.kind} refused: ${reason}`);
	}
};

const TIER_REVISION_FIELDS: ReadonlySet<string> = new Set([
	"version",
	"trust_tier",
	"revised_by",
	"revision_reason",
] satisfies (keyof AgentDefinition)[]);

/**
 * The Conductor authors only the tier Revisions that Merit and Gates require
 * (ADR-0011): each names the Event that caused it and changes the tier and
 * nothing else. The rules every Revision follows, including that the tier
 * is the projected one, run after this in `orgGuard`.
 */
const conductorGuard: AppendGuard = (ctx, event) => {
	if (event.actor.tag !== "Conductor") return;
	const refuse = (reason: string): never => {
		throw new AppendRefused(`${event.kind} refused: ${reason}`);
	};
	if (event.kind !== "AgentDefinitionRevised") {
		return refuse("the Conductor authors only tier Revisions");
	}
	const { definition } = event.payload;
	const { causation_id } = event;
	if (causation_id === undefined) {
		refuse(
			`the Conductor's Revision of ${definition.id} names no causation_id`,
		);
	}
	if (!ctx.events.some((e) => e.seq === causation_id)) {
		refuse(`causation_id ${causation_id} names no Event in the Ledger`);
	}
	const current = existing(orgState(ctx.events), definition.id).definition;
	const fields = new Set([...Object.keys(current), ...Object.keys(definition)]);
	const changed = [...fields].filter(
		(field) =>
			!TIER_REVISION_FIELDS.has(field) &&
			canonicalJson(current[field as keyof AgentDefinition]) !==
				canonicalJson(definition[field as keyof AgentDefinition]),
	);
	if (changed.length > 0) {
		refuse(
			`the Conductor's Revision of ${definition.id} may change only its Trust tier; it also changes ${changed.join(", ")}`,
		);
	}
	if (definition.trust_tier === current.trust_tier) {
		refuse(
			`the Conductor's Revision of ${definition.id} leaves its Trust tier at ${current.trust_tier}`,
		);
	}
};

/**
 * Org rules at append. Definitions follow ADR-0005: each names the actor
 * that wrote it as `revised_by`, Revisions go one version at a time, and
 * only the Operator revises the Auditor, apart from the Conductor's tier
 * Revisions.
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
			checkAuthor(event, event.payload);
			checkTier(ctx.events, event, event.payload);
			return;
		}
		case "AgentDefinitionRevised": {
			const { definition } = event.payload;
			const current = existing(orgState(ctx.events), definition.id).definition;
			if (current.role === "Auditor" && event.actor.tag === "Agent") {
				throw new AppendRefused(
					`the Auditor can only be revised by the Operator; ${actorText(event.actor)} tried to revise ${current.id} (${current.name}, version ${current.version})`,
				);
			}
			if (definition.version !== current.version + 1) {
				throw new AppendRefused(
					`Revision to version ${definition.version} refused: ${current.id} is at version ${current.version}; the next must be ${current.version + 1}`,
				);
			}
			checkAuthor(event, definition);
			checkTier(ctx.events, event, definition);
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

export const orgGuards: readonly AppendGuard[] = [conductorGuard, orgGuard];
