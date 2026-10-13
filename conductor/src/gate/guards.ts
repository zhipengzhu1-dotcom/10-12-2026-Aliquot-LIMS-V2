import type { AppendGuard } from "../append-guard.js";
import type { Event } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { AgentId } from "../ids.js";
import type { Projections } from "../projections.js";
import { actorText } from "../types/actor.js";
import { mentorGateRefusal } from "../vitality/trust.js";
import { agentNamedBy, expiresAt, type Gate, gateState } from "./projection.js";

type Requested = Extract<Event, { kind: "GateRequested" }>;
type Decided = Extract<Event, { kind: "GateDecided" }>;

/** A request names the true hash of its payload. */
const requestRefusal = (event: Requested) => {
	const r = event.payload;
	const actual = sha256Hex(canonicalJson(r.payload));
	return r.payload_hash === actual
		? undefined
		: `payload_hash ${r.payload_hash} is not the hash of the payload, ${actual}`;
};

/**
 * The decision Event is the electronic signature record (ADR-0006): the
 * Operator signs, at the Event's own time, the hash of the exact payload of
 * an Open Gate. Every rule reads only the Ledger, so an inspector replaying
 * it reaches the same verdicts. That the Gate exists, is undecided, and is
 * signed at the Event's `ts` is the Gate Projection's to say.
 */
const decisionRefusal = (gate: Gate | undefined, event: Decided) => {
	const d = event.payload;
	if (event.actor.tag !== "Operator") {
		return `only the Operator may decide ${d.gate_id}; the actor is ${actorText(event.actor)}`;
	}
	if (gate === undefined) return undefined;
	if (gateState(gate, new Date(event.ts)) === "Expired") {
		return `${gate.id} expired at ${expiresAt(gate).toISOString()}; the decision is at ${event.ts}`;
	}
	const signed = sha256Hex(canonicalJson(gate.payload));
	if (d.payload_hash !== signed || d.payload_hash !== gate.payload_hash) {
		return `payload_hash ${d.payload_hash} does not match ${gate.id}'s payload, which hashes to ${signed}; a changed payload needs a new Gate`;
	}
	if (event.task_id !== gate.task_id) {
		return `task_id ${event.task_id ?? "(none)"} is not the Task that requested ${gate.id}, ${gate.task_id ?? "(none)"}`;
	}
	return undefined;
};

/**
 * One approved PromoteToMentor Gate covers one Promotion (ADR-0006), so an
 * Agent holding an unused approval gets neither a new request nor a second
 * approval of one already Open. The Operator may still reject it.
 */
const mentorRefusal = (
	projections: Projections,
	event: Requested | Decided,
	gate: Pick<Gate, "kind" | "payload"> | undefined,
) => {
	if (gate?.kind !== "PromoteToMentor") return undefined;
	if (event.kind === "GateDecided" && event.payload.meaning !== "approve") {
		return undefined;
	}
	const agent = AgentId.safeParse(agentNamedBy(gate));
	return agent.success
		? mentorGateRefusal(projections.trust, agent.data)
		: undefined;
};

const gateRules: AppendGuard = (projections, event) => {
	if (event.kind === "GateRequested") {
		return (
			requestRefusal(event) ?? mentorRefusal(projections, event, event.payload)
		);
	}
	if (event.kind === "GateDecided") {
		const gate = projections.gates.gates.get(event.payload.gate_id);
		return (
			decisionRefusal(gate, event) ?? mentorRefusal(projections, event, gate)
		);
	}
	return undefined;
};

export const gateGuards: readonly AppendGuard[] = [gateRules];
