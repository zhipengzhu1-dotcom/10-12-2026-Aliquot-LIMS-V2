import { RoomId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Person } from "../types/actor.js";
import type { Room } from "../types/room.js";
import { open } from "./lifecycle.js";

export const LAB_ROOM: Room = {
	id: RoomId.parse("RM-lab"),
	name: "Lab",
	purpose:
		"The one Room every Agent belongs to, where the society stays on the same page",
	membership: { tag: "Everyone" },
	opened_by: { tag: "Operator" },
};

/**
 * Open the Lab Room as the person acting as the Operator, unless it is
 * already open. Returns whether it opened it.
 */
export const seedRooms = (ledger: Ledger, by: Person): boolean => {
	if (ledger.projections.rooms.rooms.has(LAB_ROOM.id)) return false;
	open(ledger, { ...LAB_ROOM, opened_by: by });
	return true;
};
