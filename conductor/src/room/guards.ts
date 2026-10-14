import type { AppendGuard } from "../append-guard.js";
import { notInOrg } from "../org/projection.js";
import { actorText } from "../types/actor.js";
import { refusal } from "./projection.js";

/**
 * ADR-0010: a Room opens only with live Agents in its list. That it opens
 * once is the Room Projection's to say.
 */
const roomOpened: AppendGuard = (projections, event) => {
	if (event.kind !== "RoomOpened") return undefined;
	const { room } = event.payload;
	if (actorText(room.opened_by) !== actorText(event.actor)) {
		return `${actorText(event.actor)} cannot open ${room.id} on behalf of ${actorText(room.opened_by)}`;
	}
	if (room.membership.tag === "Everyone") return undefined;
	const listed = room.membership.agents;
	if (event.actor.tag === "Agent" && !listed.includes(event.actor.id)) {
		return `${event.actor.id} is not listed in ${room.id}; an Agent may open only a Room it belongs to`;
	}
	for (const id of listed) {
		const agent = projections.org.agents.get(id);
		if (agent === undefined) return notInOrg(id);
		if (agent.retired) return `${id} is Retired`;
	}
	return undefined;
};

/**
 * A Message is said by a member of an open Room, and answers one in it. The
 * Conductor belongs to no Room, but it answers an Operator's Message it took
 * to run as a Chain (ADR-0021), and only that one.
 */
const messageSent: AppendGuard = (projections, event) => {
	if (event.kind !== "MessageSent") return undefined;
	const { room_id } = event.payload;
	if (event.actor.tag === "Conductor") {
		const { causation_id } = event;
		const taken =
			causation_id === undefined
				? undefined
				: projections.chains.taken.get(causation_id);
		return taken === room_id
			? undefined
			: `the Conductor says only a reply to an Operator's Message in ${room_id} it took for a Chain; seq ${causation_id ?? "none"} is not one`;
	}
	const reason = refusal(
		projections.rooms,
		projections.org,
		room_id,
		event.actor,
	);
	if (reason !== undefined) return reason;
	const { causation_id } = event;
	if (causation_id === undefined) return undefined;
	const cause = projections.rooms.messages.find((m) => m.seq === causation_id);
	return cause?.room_id === room_id
		? undefined
		: `seq ${causation_id} is not a Message in ${room_id}`;
};

export const roomGuards: readonly AppendGuard[] = [roomOpened, messageSent];
