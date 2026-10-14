import type { RoomId, Seq } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { Message } from "../room/projection.js";

/** The Operator's Messages the Conductor took to run as Chains (ADR-0020). */
export type ChainState = {
	/**
	 * Each taken Message's seq and Room. The Conductor takes a Message by
	 * storing it as an Artifact, naming its MessageSent; no Agent gets a Turn
	 * for it.
	 */
	readonly taken: ReadonlyMap<Seq, RoomId>;
};

/**
 * Whether a Message is new work for the Agents: not one the Conductor took
 * for a Chain, and not the Conductor's reply to one. Both are the Chain's.
 */
export const wakesAgents = (state: ChainState, message: Message): boolean =>
	message.actor.tag !== "Conductor" && !state.taken.has(message.seq);

export const ChainProjection: Projection<ChainState> = {
	init: { taken: new Map() },
	reduce: (state, event, projections) => {
		if (
			event.kind !== "ArtifactStored" ||
			event.actor.tag !== "Conductor" ||
			event.payload.produced_by.tag !== "Operator"
		) {
			return state;
		}
		const { causation_id } = event;
		const message = projections.rooms.messages.find(
			(m) => m.seq === causation_id,
		);
		if (message === undefined || message.actor.tag !== "Operator") {
			return new Refusal(
				`the Conductor stores only an Operator's Message, naming its MessageSent; seq ${causation_id ?? "none"} is not one`,
			);
		}
		return { taken: new Map(state.taken).set(message.seq, message.room_id) };
	},
};
