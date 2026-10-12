import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { GateId, IsoTime, nextId, type Sha256, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import type { GateKind } from "../types/gate.js";
import { type Gate, projectGates } from "./projection.js";

export const DEFAULT_LIFETIME_S = 86400;

export type GateRequest = {
	readonly actor: Actor;
	readonly kind: GateKind;
	readonly payload: Gate["payload"];
	readonly task_id?: TaskId;
	readonly lifetime_s?: number;
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
	}: GateRequest,
): { gate_id: GateId; payload_hash: Sha256 } => {
	const gate_id = GateId.parse(
		nextId("G", projectGates(ledger.events()).gates.keys()),
	);
	const payload_hash = sha256Hex(canonicalJson(payload));
	ledger.append({
		actor,
		...(task_id === undefined ? {} : { task_id }),
		kind: "GateRequested",
		payload: { gate_id, kind, payload, payload_hash, lifetime_s },
	});
	return { gate_id, payload_hash };
};

/**
 * The Operator's decision on `gate`, signed at `at`, which must also be the
 * time the Ledger records the Event.
 */
export const gateDecision = (
	gate: Gate,
	at: Date,
	meaning: "approve" | "reject",
	reason: string,
): NewEvent => ({
	actor: { tag: "Operator" },
	...(gate.task_id === undefined ? {} : { task_id: gate.task_id }),
	kind: "GateDecided",
	payload: {
		gate_id: gate.id,
		decided_by: { tag: "Operator" },
		decided_at: IsoTime.parse(at.toISOString()),
		payload_hash: sha256Hex(canonicalJson(gate.payload)),
		meaning,
		reason,
	},
});
