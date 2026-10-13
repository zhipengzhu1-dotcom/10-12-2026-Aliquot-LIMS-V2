import type { RoomId, Seq } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import type { Room } from "../types/room.js";
import type { Message } from "./projection.js";

/** The Room as it opened, and the seq of its RoomOpened Event. */
export type Opened = { readonly room: Room; readonly seq: Seq };

/** Open `room`, which its `opened_by` appends. */
export const open = (ledger: Ledger, room: Room): Opened => {
	const { seq } = ledger.append({
		actor: room.opened_by,
		...(room.task_id === undefined ? {} : { task_id: room.task_id }),
		kind: "RoomOpened",
		payload: { room },
	});
	return { room, seq };
};

/**
 * `actor` says `body` in `room_id`. A reply names the Message it answers in
 * `reply_to`, which the Event records as its cause.
 */
export const say = (
	ledger: Ledger,
	{
		actor,
		room_id,
		body,
		reply_to,
	}: {
		readonly actor: Actor;
		readonly room_id: RoomId;
		readonly body: string;
		readonly reply_to?: Seq | undefined;
	},
): Message => {
	const { seq } = ledger.append({
		actor,
		kind: "MessageSent",
		payload: { room_id, body },
		...(reply_to === undefined ? {} : { causation_id: reply_to }),
	});
	const message = ledger.projections.rooms.messages.at(-1);
	if (message?.seq !== seq) throw new Error(`Message ${seq} vanished`);
	return message;
};
