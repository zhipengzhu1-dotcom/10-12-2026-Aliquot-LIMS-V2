import { orRefuse } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { GateId, nextId, type Seq, type Sha256, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import type { GateKind } from "../types/gate.js";
import { type Gate, requestedGate } from "./projection.js";

export const DEFAULT_LIFETIME_S = 86400;

/** The Gate as the Event left it, and the Event's seq. */
export type Recorded = { readonly gate: Gate; readonly seq: Seq };

export type GateRequest = {
	readonly actor: Actor;
	readonly kind: GateKind;
	readonly payload: Gate["payload"];
	readonly lifetime_s?: number;
};

/** The Task a Gate blocks, and the cause the Task lifecycle names. */
type Blocking = {
	readonly task_id: TaskId;
	readonly causation_id: Seq | undefined;
};

type GateEvent = Extract<NewEvent, { kind: "GateRequested" | "GateDecided" }>;

const record = (ledger: Ledger, event: GateEvent): Recorded => {
	const { seq } = ledger.append(event);
	const gate = ledger.projections.gates.gates.get(event.payload.gate_id);
	if (gate === undefined) throw new Error(`${event.payload.gate_id} vanished`);
	return { gate, seq };
};

const requested = (
	ledger: Ledger,
	{ actor, kind, payload, lifetime_s = DEFAULT_LIFETIME_S }: GateRequest,
	blocking?: Blocking,
): Recorded =>
	record(ledger, {
		actor,
		...(blocking?.task_id === undefined ? {} : { task_id: blocking.task_id }),
		...(blocking?.causation_id === undefined
			? {}
			: { causation_id: blocking.causation_id }),
		kind: "GateRequested",
		payload: {
			gate_id: GateId.parse(nextId("G", ledger.projections.gates.gates.keys())),
			kind,
			payload,
			payload_hash: sha256Hex(canonicalJson(payload)),
			lifetime_s,
		},
	});

/** Request a Gate that blocks no Task, under the next free gate id. */
export const requestGate = (ledger: Ledger, request: GateRequest): Recorded =>
	requested(ledger, request);

/**
 * Request a Gate that blocks `task_id`, naming the cause the Task lifecycle
 * gives. Biome's `lint/no-gate-request-for-task.grit` refuses this call
 * outside the Task lifecycle, so only its `block` blocks a Task on a Gate.
 */
export const requestGateForTask = (
	ledger: Ledger,
	{ task_id, causation_id, ...request }: GateRequest & Blocking,
): Recorded => requested(ledger, request, { task_id, causation_id });

/**
 * The Operator's decision on `gate_id`, signed for the payload hash the
 * Operator checked, naming the Gate's request as its cause. The Ledger
 * refuses a hash that is not the stored one, writing nothing, and stamps
 * `decided_at` with the time it records the decision (ADR-0006).
 */
export const decideGate = (
	ledger: Ledger,
	{
		gate_id,
		payload_hash,
		meaning,
		reason,
	}: {
		readonly gate_id: GateId;
		readonly payload_hash: Sha256;
		readonly meaning: "approve" | "reject";
		readonly reason: string;
	},
): Recorded => {
	const gate = orRefuse(
		"GateDecided",
		requestedGate(ledger.projections.gates, gate_id),
	);
	return record(ledger, {
		actor: { tag: "Operator" },
		...(gate.task_id === undefined ? {} : { task_id: gate.task_id }),
		causation_id: gate.requested_seq,
		kind: "GateDecided",
		payload: {
			gate_id,
			decided_by: { tag: "Operator" },
			payload_hash,
			meaning,
			reason,
		},
	});
};
