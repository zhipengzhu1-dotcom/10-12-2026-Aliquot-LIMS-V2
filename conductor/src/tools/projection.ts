import type { TaskId } from "../ids.js";
import type { Projection } from "../reduce.js";
import type { EventActor } from "../types/actor.js";

/** Who proposed each Task, which the AcceptOwnProposal Action reads. */
export type ProposalState = {
	readonly proposedBy: ReadonlyMap<TaskId, EventActor>;
};

export const ProposalProjection: Projection<ProposalState> = {
	init: { proposedBy: new Map() },
	reduce: (state, event) =>
		event.kind === "TaskProposed"
			? {
					proposedBy: new Map(state.proposedBy).set(
						event.payload.task_id,
						event.actor,
					),
				}
			: state,
};
