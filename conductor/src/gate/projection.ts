import type { PayloadOf } from "../events.js";
import type { AgentId, GateId, IsoTime, Seq, Sha256, TaskId } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { EventActor } from "../types/actor.js";
import type { GateDecision, GateKind, GateState } from "../types/gate.js";

/** A requested Gate, and its decision once the Operator has signed one. */
export type Gate = {
	readonly id: GateId;
	readonly kind: GateKind;
	readonly requester: EventActor;
	readonly requested_at: IsoTime;
	/** The seq of the GateRequested, which the decision names as its cause. */
	readonly requested_seq: Seq;
	readonly task_id?: TaskId;
	readonly payload: PayloadOf<"GateRequested">["payload"];
	readonly payload_hash: Sha256;
	readonly lifetime_s: number;
	/** The Operator's signed decision, and the seq of its GateDecided. */
	readonly decision?: GateDecision & { readonly seq: Seq };
};

export type Gates = {
	readonly gates: ReadonlyMap<GateId, Gate>;
};

/**
 * Each Gate is requested once and decided at most once, and its decision is
 * signed at the time it is recorded (ADR-0006).
 */
export const GateProjection: Projection<Gates> = {
	init: { gates: new Map() },
	reduce: (state, event) => {
		switch (event.kind) {
			case "GateRequested": {
				const p = event.payload;
				const existing = state.gates.get(p.gate_id);
				if (existing !== undefined) {
					return new Refusal(
						`${p.gate_id} already exists, requested at ${existing.requested_at}`,
					);
				}
				const gate: Gate = {
					id: p.gate_id,
					kind: p.kind,
					requester: event.actor,
					requested_at: event.ts,
					requested_seq: event.seq,
					...(event.task_id === undefined ? {} : { task_id: event.task_id }),
					payload: p.payload,
					payload_hash: p.payload_hash,
					lifetime_s: p.lifetime_s,
				};
				return { gates: new Map(state.gates).set(gate.id, gate) };
			}
			case "GateDecided": {
				const d = event.payload;
				const gate = requestedGate(state, d.gate_id);
				if (gate instanceof Refusal) return gate;
				if (gate.decision !== undefined) {
					return new Refusal(
						`${gate.id} is already ${gateState(gate, new Date(event.ts))}`,
					);
				}
				if (d.decided_at !== event.ts) {
					return new Refusal(
						`decided_at ${d.decided_at} is not the time the decision is recorded, ${event.ts}`,
					);
				}
				return {
					gates: new Map(state.gates).set(gate.id, {
						...gate,
						decision: { ...event.payload, seq: event.seq },
					}),
				};
			}
			default:
				return state;
		}
	},
};

/** The Gate requested as `gate_id`, or the refusal of deciding one never requested. */
export const requestedGate = (gates: Gates, gate_id: GateId): Gate | Refusal =>
	gates.gates.get(gate_id) ?? new Refusal(`no Gate ${gate_id} was requested`);

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

/** A string field of a Gate payload that is a JSON object, if it has one. */
export const payloadText = (
	gate: Pick<Gate, "payload">,
	field: string,
): string | undefined => {
	const p = gate.payload;
	if (typeof p !== "object" || p === null || Array.isArray(p)) return undefined;
	const value = p[field];
	return typeof value === "string" ? value : undefined;
};

/** The Agent a Gate payload names as `agent_id`, if any. */
export const agentNamedBy = (gate: Pick<Gate, "payload">): string | undefined =>
	payloadText(gate, "agent_id");

/**
 * Gates of `kind` that the Operator approved and whose payload names
 * `agentId` as `agent_id`, in request order.
 */
export const approvedGatesFor = (
	gates: Gates,
	kind: GateKind,
	agentId: AgentId,
): readonly Gate[] =>
	[...gates.gates.values()].filter(
		(gate) =>
			gate.kind === kind &&
			gate.decision?.meaning === "approve" &&
			agentNamedBy(gate) === agentId,
	);
