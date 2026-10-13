import { orRefuse } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import { type AgentId, nextId, type Seq, TurnId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { type Recorded, readBack } from "../lifecycle-support.js";
import { liveAgent } from "../org/projection.js";
import type { EventActor } from "../types/actor.js";
import type { Vitality } from "../types/vitality.js";
import { vitalityProjection } from "../vitality/projection.js";
import { type SampleOptions, sampleVitality } from "../vitality/vitality.js";
import { endOfTurnSampleRefusal, startRefusal } from "./guards.js";
import { openTurn, type TurnRecord } from "./projection.js";

const CONDUCTOR: EventActor = { tag: "Conductor" };

/**
 * Start a Turn for an Agent under the next free Turn id, as the Conductor
 * (ADR-0013). It records the model and the Mood and Policy the Agent works
 * under, as `vitality show` gives them now for an Energy budget of
 * `energyBudgetTokens`.
 */
export const startTurn = (
	ledger: Ledger,
	{
		agent,
		model,
		energyBudgetTokens,
	}: {
		readonly agent: AgentId;
		readonly model: string;
		readonly energyBudgetTokens: number;
	},
): Recorded<"turn", TurnRecord> => {
	const { projections } = ledger;
	orRefuse("TurnStarted", startRefusal(projections, agent));
	const { mood, policy } = readBack(
		vitalityProjection(projections, {
			now: ledger.now(),
			energyBudgetTokens,
		}).get(agent),
		`${agent}'s Vitality`,
	);
	const turn_id = TurnId.parse(nextId("TN", projections.turns.turns.keys()));
	const { seq } = ledger.append({
		actor: CONDUCTOR,
		kind: "TurnStarted",
		payload: { turn_id, agent, model, mood, policy },
	});
	return {
		turn: readBack(ledger.projections.turns.turns.get(turn_id), turn_id),
		seq,
	};
};

/**
 * Sample the Vitality of a finished Turn's Agent as the Conductor, naming the
 * TurnFinished at `finished` as the cause (ADR-0013). The Vitality lifecycle's
 * `sample` takes an Operator or Agent actor only, so the Conductor's own act
 * is appended here, from the same computation.
 */
export const sampleAfterTurn = (
	ledger: Ledger,
	{
		agent,
		finished,
		...options
	}: SampleOptions & { readonly agent: AgentId; readonly finished: Seq },
): Recorded<"vitality", Vitality> => {
	const { projections } = ledger;
	orRefuse("VitalitySampled", liveAgent(projections.org, agent));
	orRefuse(
		"VitalitySampled",
		endOfTurnSampleRefusal(projections, agent, finished),
	);
	const vitality = sampleVitality(projections, agent, options);
	const { seq } = ledger.append({
		actor: CONDUCTOR,
		causation_id: finished,
		kind: "VitalitySampled",
		payload: vitality,
	});
	return { vitality, seq };
};

/** Finish an open Turn as the Conductor, naming its TurnStarted as the cause. */
export const finishTurn = (
	ledger: Ledger,
	payload: PayloadOf<"TurnFinished">,
): Recorded<"turn", TurnRecord> => {
	const { turn_id } = payload;
	const started = orRefuse(
		"TurnFinished",
		openTurn(ledger.projections.turns, turn_id),
	);
	const { seq } = ledger.append({
		actor: CONDUCTOR,
		causation_id: started.seq,
		kind: "TurnFinished",
		payload,
	});
	return {
		turn: readBack(ledger.projections.turns.turns.get(turn_id), turn_id),
		seq,
	};
};
