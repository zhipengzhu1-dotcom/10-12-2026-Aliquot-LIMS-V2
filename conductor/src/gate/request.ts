import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { GateId, nextId, type Seq, type Sha256, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import type { GateKind } from "../types/gate.js";
import type { Gate } from "./projection.js";

export const DEFAULT_LIFETIME_S = 86400;

export type GateRequest = {
	readonly actor: Actor;
	readonly kind: GateKind;
	readonly payload: Gate["payload"];
	readonly task_id?: TaskId;
	readonly lifetime_s?: number;
	readonly causation_id?: Seq | undefined;
};

/** Append a GateRequested under the next free gate id. */
export const requestGate = (
	ledger: Ledger,
	{
		actor,
		kind,
		payload,
		task_id,
		lifetime_s = DEFAULT_LIFETIME_S,
		causation_id,
	}: GateRequest,
): { gate_id: GateId; payload_hash: Sha256; seq: Seq } => {
	const gate_id = GateId.parse(
		nextId("G", ledger.projections.gates.gates.keys()),
	);
	const payload_hash = sha256Hex(canonicalJson(payload));
	const { seq } = ledger.append({
		actor,
		...(task_id === undefined ? {} : { task_id }),
		...(causation_id === undefined ? {} : { causation_id }),
		kind: "GateRequested",
		payload: { gate_id, kind, payload, payload_hash, lifetime_s },
	});
	return { gate_id, payload_hash, seq };
};

/**
 * The Operator's decision on `gate`. The Ledger signs it at the time it
 * records the Event, as `decided_at`.
 */
export const gateDecision = (
	gate: Gate,
	meaning: "approve" | "reject",
	reason: string,
): Extract<NewEvent, { kind: "GateDecided" }> => ({
	actor: { tag: "Operator" },
	...(gate.task_id === undefined ? {} : { task_id: gate.task_id }),
	kind: "GateDecided",
	payload: {
		gate_id: gate.id,
		decided_by: { tag: "Operator" },
		payload_hash: sha256Hex(canonicalJson(gate.payload)),
		meaning,
		reason,
	},
});
