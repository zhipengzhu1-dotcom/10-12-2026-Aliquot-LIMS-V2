import { type AppendGuard, reasonOf } from "../append-guard.js";
import type { AgentId } from "../ids.js";
import { liveAgent } from "../org/projection.js";
import type { Projections } from "../projections.js";
import { Refusal } from "../reduce.js";
import { actorText } from "../types/actor.js";
import { restInEffect } from "../vitality/vitality.js";

/** A Turn starts for a live Agent that is not paused, not resting, and has no open Turn. */
export const startRefusal = (
	projections: Projections,
	agent: AgentId,
): Refusal | undefined => {
	const live = liveAgent(projections.org, agent);
	if (live instanceof Refusal) return live;
	if (live.paused) return new Refusal(`${agent} is paused`);
	if (restInEffect(projections.work, agent)) {
		return new Refusal(`${agent} is resting`);
	}
	const open = projections.turns.open.get(agent);
	return open === undefined
		? undefined
		: new Refusal(`${agent} already has an open Turn, ${open}`);
};

/**
 * Only the Conductor records a Turn (ADR-0013). A Turn finishes naming its
 * TurnStarted as the cause. That a Turn starts once and finishes once is the
 * Turn Projection's to say.
 */
const turnRules: AppendGuard = (projections, event) => {
	if (event.kind !== "TurnStarted" && event.kind !== "TurnFinished") {
		return undefined;
	}
	const { turn_id } = event.payload;
	if (event.actor.tag !== "Conductor") {
		return `only the Conductor records a Turn; ${actorText(event.actor)} tried to record ${turn_id}`;
	}
	if (event.kind === "TurnStarted") {
		return reasonOf(startRefusal(projections, event.payload.agent));
	}
	const turn = projections.turns.turns.get(turn_id);
	if (turn === undefined || event.causation_id === turn.seq) return undefined;
	return `${turn_id} finishes naming its TurnStarted, seq ${turn.seq}, as its cause, not ${event.causation_id ?? "none"}`;
};

export const turnGuards: readonly AppendGuard[] = [turnRules];
