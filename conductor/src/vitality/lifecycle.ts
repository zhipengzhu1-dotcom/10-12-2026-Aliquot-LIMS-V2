import { AppendRefused, refusalText } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import type { AgentId, Seq } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import type { Vitality } from "../types/vitality.js";
import { restRefusal } from "./guards.js";
import { type SampleOptions, sampleVitality } from "./vitality.js";

/**
 * Append a VitalitySampled for a live Agent, computed from the Ledger. It
 * names no cause: a sample follows the end of a Turn, which lies outside
 * Vitality.
 */
export const sample = (
	ledger: Ledger,
	{
		actor,
		agent,
		...options
	}: SampleOptions & { readonly actor: Actor; readonly agent: AgentId },
): { readonly vitality: Vitality; readonly seq: Seq } => {
	const { projections } = ledger;
	if (projections.org.agents.get(agent)?.retired !== false) {
		throw new Error(`${agent} is not a live Agent in the Org`);
	}
	const vitality = sampleVitality(projections, agent, options);
	const { seq } = ledger.append({
		actor,
		kind: "VitalitySampled",
		payload: vitality,
	});
	return { vitality, seq };
};

/**
 * Order Rest for an Agent, or end it, naming the Agent's previous
 * VitalitySampled or RestOrdered as the cause: the Vitality the order acts on.
 */
export const orderRest = (
	ledger: Ledger,
	{ actor, ...payload }: PayloadOf<"RestOrdered"> & { readonly actor: Actor },
): { readonly seq: Seq } => {
	const { projections } = ledger;
	const refusal = restRefusal(projections, payload);
	if (refusal !== undefined) {
		throw new AppendRefused(refusalText("RestOrdered", refusal));
	}
	const cause = projections.work.lastVitalitySeq.get(payload.agent_id);
	const { seq } = ledger.append({
		actor,
		kind: "RestOrdered",
		payload,
		...(cause === undefined ? {} : { causation_id: cause }),
	});
	return { seq };
};
