import { orRefuse } from "../append-guard.js";
import type { PayloadOf } from "../events.js";
import { type AgentId, nextId, TurnId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { type Recorded, readBack } from "../lifecycle-support.js";
import type { EventActor } from "../types/actor.js";
import { vitalityProjection } from "../vitality/projection.js";
import { startRefusal } from "./guards.js";
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
