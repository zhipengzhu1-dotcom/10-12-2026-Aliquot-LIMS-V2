import type { PayloadOf } from "../events.js";
import type { GateId, IsoTime, Sha256, TaskId } from "../ids.js";
import type { Projection } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { GateDecision, GateKind, GateState } from "../types/gate.js";

/** A requested Gate, and its decision once the Operator has signed one. */
export type Gate = {
	readonly id: GateId;
	readonly kind: GateKind;
	readonly requester: Actor;
	readonly requested_at: IsoTime;
	readonly task_id?: TaskId;
	readonly payload: PayloadOf<"GateRequested">["payload"];
	readonly payload_hash: Sha256;
	readonly lifetime_s: number;
	readonly decision?: GateDecision;
};

export type Gates = {
	readonly gates: ReadonlyMap<GateId, Gate>;
};

export const GateProjection: Projection<Gates> = {
	init: { gates: new Map() },
	reduce: (state, event) => {
		switch (event.kind) {
			case "GateRequested": {
				const p = event.payload;
				const gate: Gate = {
					id: p.gate_id,
					kind: p.kind,
					requester: event.actor,
					requested_at: event.ts,
					...(event.task_id === undefined ? {} : { task_id: event.task_id }),
					payload: p.payload,
					payload_hash: p.payload_hash,
					lifetime_s: p.lifetime_s,
				};
				return { gates: new Map(state.gates).set(gate.id, gate) };
			}
			case "GateDecided": {
				const gate = state.gates.get(event.payload.gate_id);
				if (gate === undefined) return state;
				return {
					gates: new Map(state.gates).set(gate.id, {
						...gate,
						decision: event.payload,
					}),
				};
			}
			default:
				return state;
		}
	},
};

/** The first instant at which an undecided Gate counts as Expired. */
export const expiresAt = (gate: Gate): Date =>
	new Date(Date.parse(gate.requested_at) + gate.lifetime_s * 1000);

/**
 * A decided Gate keeps its decision forever. An undecided one is Open until
 * its lifetime ends and Expired from then on; expiry needs no Event, so the
 * caller supplies `now`.
 */
export const gateState = (gate: Gate, now: Date): GateState => {
	if (gate.decision !== undefined) {
		return gate.decision.meaning === "approve" ? "Approved" : "Rejected";
	}
	return now.getTime() >= expiresAt(gate).getTime() ? "Expired" : "Open";
};
