import type { Event, NewEvent } from "../events.js";
import { IsoTime } from "../ids.js";
import { seal } from "../ledger.js";
import { eventOf, Row, rowOf, type Storage } from "../storage.js";

/**
 * Write `newEvents` into `storage` the way a Conductor with other rules, or
 * none, might have: numbered and hash-chained after the rows already there,
 * at `ts`, past every guard and Projection. Only for tests of a Ledger that
 * the rules in force would not write.
 */
export const forge = (
	storage: Storage,
	newEvents: readonly NewEvent[],
	ts = "2026-10-01T00:00:00.000Z",
): Event[] => {
	const last = [...storage.rows()].at(-1);
	let tip = last === undefined ? undefined : eventOf(Row.parse(last));
	const forged: Event[] = [];
	storage.transaction((insert) => {
		for (const newEvent of newEvents) {
			tip = seal(newEvent, tip, IsoTime.parse(ts));
			insert(rowOf(tip));
			forged.push(tip);
		}
	});
	return forged;
};
