import { type AppendGuard, AppendRefused } from "../append-guard.js";
import { orgState } from "../org/projection.js";
import { actorText } from "../types/actor.js";
import { refusal, roomState } from "./projection.js";

/** ADR-0010: a Room opens once, and only with live Agents in its list. */
const roomOpened: AppendGuard = (ctx, event) => {
	if (event.kind !== "RoomOpened") return;
	const { room } = event.payload;
	const refuse = (reason: string): never => {
		throw new AppendRefused(`RoomOpened refused: ${reason}`);
	};
	if (roomState(ctx.events).rooms.has(room.id)) {
		refuse(`${room.id} is already open`);
	}
	if (actorText(room.opened_by) !== actorText(event.actor)) {
		refuse(
			`${actorText(event.actor)} cannot open ${room.id} on behalf of ${actorText(room.opened_by)}`,
		);
	}
	if (room.membership.tag === "Everyone") return;
	const listed = room.membership.agents;
	if (event.actor.tag === "Agent" && !listed.includes(event.actor.id)) {
		refuse(
			`${event.actor.id} is not listed in ${room.id}; an Agent may open only a Room it belongs to`,
		);
	}
	const { agents } = orgState(ctx.events);
	for (const id of listed) {
		const agent = agents.get(id);
		if (agent === undefined) return refuse(`${id} is not in the Org`);
		if (agent.retired) refuse(`${id} is Retired`);
	}
};

/** A Message is said by a member of an open Room, and answers one in it. */
const messageSent: AppendGuard = (ctx, event) => {
	if (event.kind !== "MessageSent") return;
	const { room_id } = event.payload;
	const reason = refusal(
		roomState(ctx.events),
		orgState(ctx.events),
		room_id,
		event.actor,
	);
	if (reason !== undefined) {
		throw new AppendRefused(`MessageSent refused: ${reason}`);
	}
	const { causation_id } = event;
	if (causation_id === undefined) return;
	const cause = ctx.events.find((e) => e.seq === causation_id);
	if (cause?.kind !== "MessageSent" || cause.payload.room_id !== room_id) {
		throw new AppendRefused(
			`MessageSent refused: seq ${causation_id} is not a Message in ${room_id}`,
		);
	}
};

export const roomGuards: readonly AppendGuard[] = [roomOpened, messageSent];
