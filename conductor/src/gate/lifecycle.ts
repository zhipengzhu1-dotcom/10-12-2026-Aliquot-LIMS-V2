import { orRefuse } from "../append-guard.js";
import type { Event, NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { GateId, nextId, type Seq, type Sha256, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { type Recorded, readBack } from "../lifecycle-support.js";
import type { EventActor, Person } from "../types/actor.js";
import type { GateKind } from "../types/gate.js";
import { type Gate, requestedGate } from "./projection.js";

export const DEFAULT_LIFETIME_S = 86400;

export type GateRequest = {
	readonly actor: EventActor;
	readonly kind: GateKind;
	readonly payload: Gate["payload"];
	readonly lifetime_s?: number;
};

/** The Task a Gate blocks, if any, and the cause the request names. */
type Blocking = {
	readonly task_id?: TaskId | undefined;
	readonly causation_id: Seq | undefined;
};

type GateEvent = Extract<NewEvent, { kind: "GateRequested" | "GateDecided" }>;

/** What a Gate verb recorded, and the Event as the Ledger wrote it. */
type Written = Recorded<"gate", Gate> & { readonly event: Event };

const record = (ledger: Ledger, newEvent: GateEvent): Written => {
	const event = ledger.append(newEvent);
	const { gate_id } = newEvent.payload;
	return {
		gate: readBack(ledger.projections.gates.gates.get(gate_id), gate_id),
		seq: event.seq,
		event,
	};
};

const requested = (
	ledger: Ledger,
	{ actor, kind, payload, lifetime_s = DEFAULT_LIFETIME_S }: GateRequest,
	blocking?: Blocking,
): Recorded<"gate", Gate> =>
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

/**
 * Request a Gate that blocks no Task, under the next free gate id, naming
 * `causation_id` when the request follows from an Event.
 */
export const requestGate = (
	ledger: Ledger,
	{
		causation_id,
		...request
	}: GateRequest & { readonly causation_id?: Seq | undefined },
): Recorded<"gate", Gate> => requested(ledger, request, { causation_id });

/**
 * Request a Gate that blocks `task_id`, naming the cause the Task lifecycle
 * gives. Biome's `lint/no-gate-request-for-task.grit` refuses this call
 * outside the Task lifecycle, so only its `block` blocks a Task on a Gate.
 */
export const requestGateForTask = (
	ledger: Ledger,
	{ task_id, causation_id, ...request }: GateRequest & Blocking,
): Recorded<"gate", Gate> =>
	requested(ledger, request, { task_id, causation_id });

/**
 * The decision of `actor`, the person acting as the Operator, on `gate_id`,
 * signed for the payload hash that person checked, naming the Gate's request
 * as its cause. The Ledger refuses a hash that is not the stored one, writing
 * nothing, and stamps `decided_at` with the time it records the decision
 * (ADR-0006), so the decision Event comes back as the Ledger wrote it.
 */
export const decideGate = (
	ledger: Ledger,
	{
		actor,
		gate_id,
		payload_hash,
		meaning,
		reason,
	}: {
		readonly actor: Person;
		readonly gate_id: GateId;
		readonly payload_hash: Sha256;
		readonly meaning: "approve" | "reject";
		readonly reason: string;
	},
): Written => {
	const gate = orRefuse(
		"GateDecided",
		requestedGate(ledger.projections.gates, gate_id),
	);
	return record(ledger, {
		actor,
		...(gate.task_id === undefined ? {} : { task_id: gate.task_id }),
		causation_id: gate.requested_seq,
		kind: "GateDecided",
		payload: {
			gate_id,
			decided_by: actor,
			payload_hash,
			meaning,
			reason,
		},
	});
};
