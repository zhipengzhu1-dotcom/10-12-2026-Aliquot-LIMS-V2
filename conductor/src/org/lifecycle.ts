import { orRefuse } from "../append-guard.js";
import type { EventBody } from "../events.js";
import { payloadText } from "../gate/projection.js";
import type { AgentId, GateId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { type Origin, type Recorded, readBack } from "../lifecycle-support.js";
import { Refusal } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { retirementGate } from "./guards.js";
import type { AgentState } from "./projection.js";

type OrgBody = Extract<
	EventBody,
	{
		kind:
			| "AgentRecruited"
			| "AgentDefinitionRevised"
			| "AgentPaused"
			| "AgentResumed"
			| "AgentRetired";
	}
>;

/**
 * Append `body` about `agent_id`, naming the caller's cause or else the
 * Agent's previous Org Event; a Recruitment has none.
 */
const record = (
	ledger: Ledger,
	{ actor, causation_id }: Origin,
	agent_id: AgentId,
	body: OrgBody,
): Recorded<"agent", AgentState> => {
	const cause =
		causation_id ?? ledger.projections.org.agents.get(agent_id)?.lastSeq;
	const { seq } = ledger.append({
		actor,
		...(cause === undefined ? {} : { causation_id: cause }),
		...body,
	});
	return {
		agent: readBack(ledger.projections.org.agents.get(agent_id), agent_id),
		seq,
	};
};

export const recruit = (
	ledger: Ledger,
	{ definition, ...origin }: Origin & { readonly definition: AgentDefinition },
): Recorded<"agent", AgentState> =>
	record(ledger, origin, definition.id, {
		kind: "AgentRecruited",
		payload: definition,
	});

/** Record `definition`, the full next version of an Agent's definition. */
export const revise = (
	ledger: Ledger,
	{ definition, ...origin }: Origin & { readonly definition: AgentDefinition },
): Recorded<"agent", AgentState> =>
	record(ledger, origin, definition.id, {
		kind: "AgentDefinitionRevised",
		payload: { definition },
	});

export const pause = (
	ledger: Ledger,
	{
		agent_id,
		reason,
		...origin
	}: Origin & { readonly agent_id: AgentId; readonly reason: string },
): Recorded<"agent", AgentState> =>
	record(ledger, origin, agent_id, {
		kind: "AgentPaused",
		payload: { agent_id, reason },
	});

export const resume = (
	ledger: Ledger,
	{ agent_id, ...origin }: Origin & { readonly agent_id: AgentId },
): Recorded<"agent", AgentState> =>
	record(ledger, origin, agent_id, {
		kind: "AgentResumed",
		payload: { agent_id },
	});

/**
 * Retire an Agent through the approved RetireAgent Gate `gate_id`, naming
 * the Gate's decision as the cause. The reason is the caller's, else the one
 * the Gate's payload gives.
 */
export const retire = (
	ledger: Ledger,
	{
		actor,
		agent_id,
		gate_id,
		reason,
	}: {
		readonly actor: Actor;
		readonly agent_id: AgentId;
		readonly gate_id: GateId;
		readonly reason?: string | undefined;
	},
): Recorded<"agent", AgentState> => {
	const gate = orRefuse(
		"AgentRetired",
		retirementGate(
			ledger.projections,
			{ actor, agent_id, gate_id },
			ledger.now(),
		),
	);
	const why = orRefuse(
		"AgentRetired",
		reason ??
			payloadText(gate, "reason") ??
			new Refusal(
				`${gate_id} gives no reason to retire ${agent_id}, and none was given`,
			),
	);
	return record(ledger, { actor, causation_id: gate.decision.seq }, agent_id, {
		kind: "AgentRetired",
		payload: { agent_id, reason: why, gate_id },
	});
};
