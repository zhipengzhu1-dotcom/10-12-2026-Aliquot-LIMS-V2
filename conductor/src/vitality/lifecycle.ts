import { orRefuse } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import type { AgentId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Origin, Recorded } from "../lifecycle-support.js";
import { liveAgent } from "../org/projection.js";
import type { Actor } from "../types/actor.js";
import type { Vitality } from "../types/vitality.js";
import { restRefusal } from "./guards.js";
import { type SampleOptions, sampleVitality } from "./vitality.js";

/**
 * Append a VitalitySampled for a live Agent, computed from the Ledger. A
 * sample taken at the end of a Turn names that TurnFinished as its cause,
 * which the caller gives because it lies outside Vitality; any other sample
 * names none.
 */
export const sample = (
	ledger: Ledger,
	{
		actor,
		causation_id,
		agent,
		...options
	}: SampleOptions & Origin & { readonly agent: AgentId },
): Recorded<"vitality", Vitality> => {
	const { projections } = ledger;
	orRefuse("VitalitySampled", liveAgent(projections.org, agent));
	const vitality = sampleVitality(projections, agent, options);
	const { seq } = ledger.append({
		actor,
		...(causation_id === undefined ? {} : { causation_id }),
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
	{ actor, ...order }: PayloadOf<"RestOrdered"> & { readonly actor: Actor },
): Recorded<"order", PayloadOf<"RestOrdered">> => {
	const { projections } = ledger;
	orRefuse("RestOrdered", restRefusal(projections, order));
	const cause = projections.work.lastVitalitySeq.get(order.agent_id);
	const { seq } = ledger.append({
		actor,
		kind: "RestOrdered",
		payload: order,
		...(cause === undefined ? {} : { causation_id: cause }),
	});
	return { order, seq };
};
