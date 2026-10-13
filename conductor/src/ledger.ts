import { z } from "zod";
import { Event, NewEvent } from "./events.js";
import {
	AppendRefused,
	appendFollowOns,
	appendGuards,
	ledgerCatchUps,
	refusalText,
} from "./guards.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { IsoTime, Seq } from "./ids.js";
import { advance, emptyProjections, type Projections } from "./projections.js";
import { Refusal } from "./reduce.js";
import {
	eventOf,
	GENESIS_HASH,
	memoryStorage,
	Row,
	rowOf,
	type Storage,
	sqliteStorage,
	stripUndefined,
	type VerifyResult,
	verifyRows,
} from "./storage.js";

export { LedgerLocked, type VerifyResult } from "./storage.js";

export type LedgerOptions = {
	/** Open for writing. Only one writer may hold a SQLite Ledger at a time. */
	writer: boolean;
	/** Source of each Event's `ts`. Defaults to the wall clock. */
	clock?: () => Date;
};

export type Ledger = {
	readonly path: string;
	/** Every Projection, as of the Ledger's last Event. */
	readonly projections: Projections;
	/**
	 * Validate, number, hash, guard, project and write one Event and its
	 * follow-ons in one transaction, and return that Event. Throws
	 * `AppendRefused`, worded `<Kind> refused: <reason>`.
	 */
	append(newEvent: NewEvent): Event;
	/** Every Event in seq order. */
	events(): IterableIterator<Event>;
	all(): Event[];
	/** Walk the chain from seq 1 and report the first broken link. */
	verify(): VerifyResult;
	close(): void;
};

/**
 * The Ledger holds an Event that its Projections cannot apply, so it would
 * have refused to append it. Nothing reads such a Ledger.
 */
export class LedgerCorrupt extends Error {
	override readonly name = "LedgerCorrupt";
}

/**
 * Number and hash `newEvent` after `last`, at `ts`. A GateDecided is signed
 * at the time it is recorded, so its `decided_at` is `ts` (ADR-0006).
 */
export const seal = (
	newEvent: NewEvent,
	last: Event | undefined,
	ts: IsoTime,
) => {
	const unhashed = {
		seq: Seq.parse((last?.seq ?? 0) + 1),
		ts,
		actor: newEvent.actor,
		task_id: newEvent.task_id,
		causation_id: newEvent.causation_id,
		kind: newEvent.kind,
		payload:
			newEvent.kind === "GateDecided"
				? { ...newEvent.payload, decided_at: ts }
				: newEvent.payload,
		prev_hash: last?.hash ?? GENESIS_HASH,
	};
	const hash = sha256Hex(canonicalJson(unhashed));
	return Event.parse(stripUndefined({ ...unhashed, hash }));
};

/**
 * Parse an Event body that arrived from outside, such as JSON from the
 * command line. Throws `AppendRefused` naming every problem.
 */
export const parseNewEvent = (input: unknown): NewEvent => {
	const parsed = NewEvent.safeParse(input);
	if (!parsed.success) {
		const kind =
			typeof input === "object" &&
			input !== null &&
			"kind" in input &&
			typeof input.kind === "string"
				? input.kind
				: "Event";
		throw new AppendRefused(
			refusalText(kind, `not a valid Event: ${z.prettifyError(parsed.error)}`),
		);
	}
	return parsed.data;
};

/**
 * The Projections after `event`, or why the Ledger refuses it: a Projection
 * that cannot apply it, else the first guard that refuses it.
 */
const appended = (before: Projections, event: Event): Projections | Refusal => {
	const after = advance(before, event);
	if (after instanceof Refusal) return after;
	for (const guard of appendGuards) {
		const reason = guard(before, event);
		if (reason !== undefined) return new Refusal(reason);
	}
	return after;
};

const openOn = (storage: Storage, options: LedgerOptions): Ledger => {
	const clock = options.clock ?? (() => new Date());

	// Built once from every Event; each append then advances them by one.
	let projections = emptyProjections();
	let last: Event | undefined;
	try {
		for (const raw of storage.rows()) {
			const event = eventOf(Row.parse(raw));
			const after = advance(projections, event);
			if (after instanceof Refusal) {
				throw new LedgerCorrupt(
					`${storage.path} is corrupt at seq ${event.seq}: ${refusalText(event.kind, after.reason)}`,
				);
			}
			projections = after;
			last = event;
		}
	} catch (error) {
		storage.close();
		throw error;
	}

	/**
	 * Run `body` in one transaction, handing it a `write` that numbers,
	 * hashes, guards, projects and inserts one Event, and the Projections as
	 * of the last write. A refusal anywhere rolls back every write and leaves
	 * the Ledger as it was.
	 */
	const transaction = <T>(
		body: (
			write: (newEvent: NewEvent) => Event,
			current: () => Projections,
		) => T,
	): T => {
		if (!options.writer) {
			throw new Error(
				`Ledger at ${storage.path} is open read-only; open it with writer: true to append`,
			);
		}
		let pending = projections;
		let tip = last;
		const result = storage.transaction((insert) =>
			body(
				(newEvent) => {
					const ts = IsoTime.parse(clock().toISOString());
					const event = seal(parseNewEvent(newEvent), tip, ts);
					const after = appended(pending, event);
					if (after instanceof Refusal) {
						throw new AppendRefused(refusalText(event.kind, after.reason));
					}
					insert(rowOf(event));
					pending = after;
					tip = event;
					return event;
				},
				() => pending,
			),
		);
		projections = pending;
		last = tip;
		return result;
	};

	const append = (newEvent: NewEvent): Event =>
		transaction((write, current) => {
			const cause = write(newEvent);
			for (const followOn of appendFollowOns) {
				for (const next of followOn(current(), cause)) write(next);
			}
			return cause;
		});

	function* events(): IterableIterator<Event> {
		for (const raw of storage.rows()) yield eventOf(Row.parse(raw));
	}

	if (options.writer) {
		try {
			transaction((write, current) => {
				for (const catchUp of ledgerCatchUps) {
					for (const next of catchUp(current())) write(next);
				}
			});
		} catch (error) {
			storage.close();
			throw error;
		}
	}

	return {
		path: storage.path,
		get projections() {
			return projections;
		},
		append,
		events,
		all: () => [...events()],
		verify: () => verifyRows(storage.rows()),
		close: () => storage.close(),
	};
};

/** The Ledger in the SQLite file `<home>/ledger.sqlite` (ADR-0008). */
export const openLedger = (
	options: LedgerOptions & {
		/** The data directory. The Ledger lives at `<home>/ledger.sqlite`. */
		home: string;
	},
): Ledger => openOn(sqliteStorage(options.home, options.writer), options);

/**
 * A Ledger in memory, under the same rules as SQLite. Several Ledgers may
 * open one `storage`, as several processes open one SQLite file.
 */
export const openMemoryLedger = (
	options: Partial<LedgerOptions> & { storage?: Storage } = {},
): Ledger =>
	openOn(options.storage ?? memoryStorage(), {
		...options,
		writer: options.writer ?? true,
	});

/**
 * Walk the chain of the SQLite Ledger in `home` without projecting it, so a
 * Ledger too corrupt to open still reports its first broken link.
 */
export const verifyLedger = (home: string): VerifyResult => {
	const storage = sqliteStorage(home, false);
	try {
		return verifyRows(storage.rows());
	} finally {
		storage.close();
	}
};
