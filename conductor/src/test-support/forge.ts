import type { Event, NewEvent } from "../events.js";
import { IsoTime, type Seq } from "../ids.js";
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

/**
 * Write the Events of `source` into `target` as a Conductor before ADR-0011
 * would have: without the Conductor's tier Revisions, each at its own `ts`,
 * with every `causation_id` renumbered to match. Returns where each source
 * seq landed in `target`.
 */
export const forgeBeforeAdr0011 = (
	source: Storage,
	target: Storage,
): ((seq: Seq) => Seq) => {
	const seqs = new Map<Seq, Seq>();
	for (const raw of source.rows()) {
		const { seq, ts, hash, prev_hash, causation_id, ...body } = eventOf(
			Row.parse(raw),
		);
		if (body.actor.tag === "Conductor") continue;
		const cause =
			causation_id === undefined ? undefined : seqs.get(causation_id);
		const [forged] = forge(
			target,
			[{ ...body, ...(cause === undefined ? {} : { causation_id: cause }) }],
			ts,
		);
		if (forged !== undefined) seqs.set(seq, forged.seq);
	}
	return (seq) => {
		const forged = seqs.get(seq);
		if (forged === undefined) throw new Error(`seq ${seq} was not forged`);
		return forged;
	};
};
