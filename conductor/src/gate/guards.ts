import { type AppendGuard, AppendRefused } from "../append-guard.js";
import type { Event } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { AgentId } from "../ids.js";
import { actorText } from "../types/actor.js";
import { mentorGateRefusal } from "../vitality/trust.js";
import {
	agentNamedBy,
	expiresAt,
	type Gate,
	gateState,
	projectGates,
} from "./projection.js";

type Requested = Extract<Event, { kind: "GateRequested" }>;
type Decided = Extract<Event, { kind: "GateDecided" }>;

const refuse = (message: string): never => {
	throw new AppendRefused(message);
};

/** A request names a fresh gate id and the true hash of its payload. */
const checkRequest = (existing: Gate | undefined, event: Requested) => {
	const r = event.payload;
	if (existing !== undefined) {
		refuse(
			`Gate ${r.gate_id} already exists, requested at ${existing.requested_at}`,
		);
	}
	const actual = sha256Hex(canonicalJson(r.payload));
	if (r.payload_hash !== actual) {
		refuse(
			`payload_hash ${r.payload_hash} is not the hash of the payload, ${actual}`,
		);
	}
};

/**
 * The decision Event is the electronic signature record (ADR-0006): the
 * Operator signs, at the Event's own time, the hash of the exact payload of
 * an Open Gate. Every rule reads only the Ledger, so an inspector replaying
 * it reaches the same verdicts.
 */
const checkDecision = (gate: Gate | undefined, event: Decided) => {
	const d = event.payload;
	if (event.actor.tag !== "Operator") {
		refuse(
			`only the Operator may decide Gate ${d.gate_id}; the actor is ${actorText(event.actor)}`,
		);
	}
	if (gate === undefined) return refuse(`no Gate ${d.gate_id} was requested`);

	const state = gateState(gate, new Date(event.ts));
	if (state === "Expired") {
		refuse(
			`Gate ${gate.id} expired at ${expiresAt(gate).toISOString()}; the decision is at ${event.ts}`,
		);
	}
	if (state !== "Open") refuse(`Gate ${gate.id} is already ${state}`);

	if (d.decided_at !== event.ts) {
		refuse(
			`decided_at ${d.decided_at} is not the time the decision is recorded, ${event.ts}`,
		);
	}
	const signed = sha256Hex(canonicalJson(gate.payload));
	if (d.payload_hash !== signed || d.payload_hash !== gate.payload_hash) {
		refuse(
			`payload_hash ${d.payload_hash} does not match Gate ${gate.id}'s payload, which hashes to ${signed}; a changed payload needs a new Gate`,
		);
	}
	if (event.task_id !== gate.task_id) {
		refuse(
			`task_id ${event.task_id ?? "(none)"} is not the Task that requested Gate ${gate.id}, ${gate.task_id ?? "(none)"}`,
		);
	}
};

/**
 * One approved PromoteToMentor Gate covers one Promotion (ADR-0006), so an
 * Agent holding an unused approval gets neither a new request nor a second
 * approval of one already Open. The Operator may still reject it.
 */
const checkMentorGate = (
	events: readonly Event[],
	event: Requested | Decided,
	gate: Pick<Gate, "kind" | "payload"> | undefined,
) => {
	if (gate?.kind !== "PromoteToMentor") return;
	if (event.kind === "GateDecided" && event.payload.meaning !== "approve") {
		return;
	}
	const agent = AgentId.safeParse(agentNamedBy(gate));
	if (!agent.success) return;
	const reason = mentorGateRefusal(events, agent.data);
	if (reason !== undefined) refuse(`${event.kind} refused: ${reason}`);
};

const gateRules: AppendGuard = (ctx, event) => {
	if (event.kind !== "GateRequested" && event.kind !== "GateDecided") return;
	const { gates } = projectGates(ctx.events);
	const gate = gates.get(event.payload.gate_id);
	if (event.kind === "GateRequested") {
		checkRequest(gate, event);
		checkMentorGate(ctx.events, event, event.payload);
	} else {
		checkDecision(gate, event);
		checkMentorGate(ctx.events, event, gate);
	}
};

export const gateGuards: readonly AppendGuard[] = [gateRules];
