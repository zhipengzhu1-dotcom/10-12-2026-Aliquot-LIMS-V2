import { type AppendGuard, AppendRefused } from "../append-guard.js";

/** Only the Operator signs a Gate decision (ADR-0006). */
const operatorDecides: AppendGuard = (_ctx, event) => {
	if (event.kind !== "GateDecided") return;
	if (event.actor.tag !== "Operator") {
		throw new AppendRefused(
			`only the Operator may decide Gate ${event.payload.gate_id}; the actor is ${event.actor.tag} ${event.actor.id}`,
		);
	}
};

export const gateGuards: readonly AppendGuard[] = [operatorDecides];
