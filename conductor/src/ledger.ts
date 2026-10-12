import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Event, NewEvent } from "./events.js";
import { type AppendGuard, AppendRefused, appendGuards } from "./guards.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { IsoTime, Seq, Sha256 } from "./ids.js";

export type LedgerOptions = {
	/** The data directory. The Ledger lives at `<home>/ledger.sqlite`. */
	home: string;
	/** Open for writing. Only one writer may hold the Ledger at a time. */
	writer: boolean;
	/** Source of each Event's `ts`. Defaults to the wall clock. */
	clock?: () => Date;
	/** Guards run before every append. Defaults to `appendGuards`. */
	guards?: readonly AppendGuard[];
};

export type Ledger = {
	readonly path: string;
	/** Validate, guard, number, hash, and write one Event. Throws `AppendRefused`. */
	append(newEvent: NewEvent): Event;
	/** Every Event in seq order. */
	events(): IterableIterator<Event>;
	all(): Event[];
	/** Walk the chain from seq 1 and report the first broken link. */
	verify(): VerifyResult;
	close(): void;
};

export type VerifyResult =
	| { ok: true; count: number }
	| { ok: false; seq: number; reason: string };

const GENESIS_HASH = Sha256.parse("0".repeat(64));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY,
	ts TEXT NOT NULL,
	actor TEXT NOT NULL,
	task_id TEXT,
	causation_id INTEGER,
	kind TEXT NOT NULL,
	payload TEXT NOT NULL,
	prev_hash TEXT NOT NULL,
	hash TEXT NOT NULL
)`;

const Row = z.object({
	seq: z.number().int(),
	ts: z.string(),
	actor: z.string(),
	task_id: z.string().nullable(),
	causation_id: z.number().int().nullable(),
	kind: z.string(),
	payload: z.string(),
	prev_hash: z.string(),
	hash: z.string(),
});
type Row = z.infer<typeof Row>;

/** The fields the hash covers, with absent optional fields omitted. */
const hashedFields = (row: Row) => ({
	seq: row.seq,
	ts: row.ts,
	actor: JSON.parse(row.actor) as unknown,
	task_id: row.task_id ?? undefined,
	causation_id: row.causation_id ?? undefined,
	kind: row.kind,
	payload: JSON.parse(row.payload) as unknown,
	prev_hash: row.prev_hash,
});

const eventOf = (row: Row): Event => {
	const { prev_hash, ...rest } = hashedFields(row);
	return Event.parse({ ...stripUndefined(rest), prev_hash, hash: row.hash });
};

const stripUndefined = <T extends object>(o: T): T =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const verifyRows = (rows: Iterable<unknown>): VerifyResult => {
	let expected = 1;
	let prevHash: string = GENESIS_HASH;
	for (const raw of rows) {
		const parsed = Row.safeParse(raw);
		if (!parsed.success) {
			return { ok: false, seq: expected, reason: "row has the wrong columns" };
		}
		const row = parsed.data;
		if (row.seq !== expected) {
			return {
				ok: false,
				seq: expected,
				reason: `seq ${expected} is missing; the next row is seq ${row.seq}`,
			};
		}
		if (row.prev_hash !== prevHash) {
			return {
				ok: false,
				seq: row.seq,
				reason:
					row.seq === 1
						? "prev_hash of seq 1 is not the genesis hash"
						: `prev_hash does not match the hash of seq ${row.seq - 1}`,
			};
		}
		let fields: ReturnType<typeof hashedFields>;
		try {
			fields = hashedFields(row);
		} catch {
			return { ok: false, seq: row.seq, reason: "stored JSON does not parse" };
		}
		if (sha256Hex(canonicalJson(fields)) !== row.hash) {
			return {
				ok: false,
				seq: row.seq,
				reason: "hash does not match the Event's contents",
			};
		}
		prevHash = row.hash;
		expected++;
	}
	return { ok: true, count: expected - 1 };
};

export const openLedger = (options: LedgerOptions): Ledger => {
	const path = join(options.home, "ledger.sqlite");
	const clock = options.clock ?? (() => new Date());
	const guards = options.guards ?? appendGuards;

	mkdirSync(options.home, { recursive: true });
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);

	const selectAll = db.prepare("SELECT * FROM events ORDER BY seq");
	const insert = db.prepare(
		`INSERT INTO events (seq, ts, actor, task_id, causation_id, kind, payload, prev_hash, hash)
		 VALUES (:seq, :ts, :actor, :task_id, :causation_id, :kind, :payload, :prev_hash, :hash)`,
	);

	function* events(): IterableIterator<Event> {
		for (const row of selectAll.iterate()) yield eventOf(Row.parse(row));
	}

	const append = (newEvent: NewEvent): Event => {
		const parsed = NewEvent.safeParse(newEvent);
		if (!parsed.success) {
			throw new AppendRefused(
				`invalid Event: ${z.prettifyError(parsed.error)}`,
			);
		}
		const body = parsed.data;

		db.exec("BEGIN IMMEDIATE");
		try {
			const history = [...events()];
			const last = history.at(-1);
			const unhashed = {
				seq: Seq.parse((last?.seq ?? 0) + 1),
				ts: IsoTime.parse(clock().toISOString()),
				actor: body.actor,
				task_id: body.task_id,
				causation_id: body.causation_id,
				kind: body.kind,
				payload: body.payload,
				prev_hash: last?.hash ?? GENESIS_HASH,
			};
			const hash = sha256Hex(canonicalJson(unhashed));
			const event = Event.parse(stripUndefined({ ...unhashed, hash }));

			for (const guard of guards) guard({ events: history }, event);

			insert.run({
				seq: event.seq,
				ts: event.ts,
				actor: canonicalJson(event.actor),
				task_id: event.task_id ?? null,
				causation_id: event.causation_id ?? null,
				kind: event.kind,
				payload: canonicalJson(event.payload),
				prev_hash: event.prev_hash,
				hash: event.hash,
			});
			db.exec("COMMIT");
			return event;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};

	return {
		path,
		append,
		events,
		all: () => [...events()],
		verify: () => verifyRows(selectAll.iterate()),
		close: () => db.close(),
	};
};
