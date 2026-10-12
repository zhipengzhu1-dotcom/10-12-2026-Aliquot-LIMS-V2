import type { Event } from "../events.js";
import type { IsoTime, RoomId, Seq } from "../ids.js";
import type { OrgState } from "../org/projection.js";
import { fold, type Projection } from "../reduce.js";
import { type Actor, actorText } from "../types/actor.js";
import type { Room } from "../types/room.js";

/** One `MessageSent` Event, as a Room's reader sees it. */
export type Message = {
	readonly seq: Seq;
	readonly ts: IsoTime;
	readonly actor: Actor;
	readonly room_id: RoomId;
	readonly body: string;
	/** The `seq` of the Message this one answers. */
	readonly causation_id?: Seq;
};

/** Every open Room, and every Message in `seq` order. */
export type RoomState = {
	readonly rooms: ReadonlyMap<RoomId, Room>;
	readonly messages: readonly Message[];
};

/** Why a Room cannot be read. Returned, never thrown. */
export class RoomRefused {
	constructor(readonly message: string) {}
}

export const RoomProjection: Projection<RoomState> = {
	init: { rooms: new Map(), messages: [] },
	reduce: (state, event) => {
		switch (event.kind) {
			case "RoomOpened": {
				const { room } = event.payload;
				if (state.rooms.has(room.id)) return state;
				return { ...state, rooms: new Map(state.rooms).set(room.id, room) };
			}
			case "MessageSent": {
				const { room_id, body } = event.payload;
				if (!state.rooms.has(room_id)) return state;
				const message: Message = {
					seq: event.seq,
					ts: event.ts,
					actor: event.actor,
					room_id,
					body,
					...(event.causation_id === undefined
						? {}
						: { causation_id: event.causation_id }),
				};
				return { ...state, messages: [...state.messages, message] };
			}
			default:
				return state;
		}
	},
};

export const roomState = (events: Iterable<Event>): RoomState =>
	fold(events, RoomProjection.reduce, RoomProjection.init);

/**
 * The one membership rule, for saying and for reading alike. The Operator
 * belongs to every Room. An Agent belongs while it is recruited and not
 * retired, to an `Everyone` Room, or to a `Listed` Room that names it.
 */
export const isMember = (
	state: RoomState,
	org: OrgState,
	room_id: RoomId,
	actor: Actor,
): boolean => {
	const room = state.rooms.get(room_id);
	if (room === undefined) return false;
	if (actor.tag === "Operator") return true;
	const agent = org.agents.get(actor.id);
	if (agent === undefined || agent.retired) return false;
	return (
		room.membership.tag === "Everyone" ||
		room.membership.agents.includes(actor.id)
	);
};

/** Why `actor` may not act in `room_id`, or undefined when it may. */
export const refusal = (
	state: RoomState,
	org: OrgState,
	room_id: RoomId,
	actor: Actor,
): string | undefined => {
	if (!state.rooms.has(room_id)) return `${room_id} is not an open Room`;
	if (!isMember(state, org, room_id, actor)) {
		return `${actorText(actor)} is not a member of ${room_id}`;
	}
	return undefined;
};

/** Every Message in `room_id`, in `seq` order, if `reader` is a member. */
export const history = (
	state: RoomState,
	org: OrgState,
	room_id: RoomId,
	reader: Actor,
): readonly Message[] | RoomRefused => {
	const reason = refusal(state, org, room_id, reader);
	if (reason !== undefined) {
		return new RoomRefused(`history refused: ${reason}`);
	}
	return state.messages.filter((m) => m.room_id === room_id);
};

/** The Rooms `actor` may read, in the order they were opened. */
export const roomsOf = (
	state: RoomState,
	org: OrgState,
	actor: Actor,
): readonly Room[] =>
	[...state.rooms.values()].filter((room) =>
		isMember(state, org, room.id, actor),
	);
