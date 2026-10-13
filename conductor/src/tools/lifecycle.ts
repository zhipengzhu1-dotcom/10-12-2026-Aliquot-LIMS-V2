import type { PayloadOf } from "../events.js";
import type { Ledger } from "../ledger.js";
import type { Recorded } from "../lifecycle-support.js";

export type ActionRefusal = PayloadOf<"ActionRefused">;

/**
 * Record a Tool call the hook refused, as the Conductor (ADR-0013). Its cause
 * is the TurnStarted of the Agent's open Turn, the act the call came from;
 * a call from the command line has none. The envelope names the Task when
 * the call named one that exists.
 */
export const recordRefusal = (
	ledger: Ledger,
	refusal: ActionRefusal,
): Recorded<"refusal", ActionRefusal> => {
	const { turns, tasks } = ledger.projections;
	const turn_id = turns.open.get(refusal.agent);
	const cause = turn_id === undefined ? undefined : turns.turns.get(turn_id);
	const { task_id } = refusal;
	const { seq } = ledger.append({
		actor: { tag: "Conductor" },
		...(task_id !== undefined && tasks.tasks.has(task_id) ? { task_id } : {}),
		...(cause === undefined ? {} : { causation_id: cause.seq }),
		kind: "ActionRefused",
		payload: refusal,
	});
	return { refusal, seq };
};
