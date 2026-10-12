import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Event, NewEvent } from "./events.js";
import { type AppendGuard, AppendRefused, appendGuards } from "./guards.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { IsoTime, Seq, Sha256 } from "./ids.js";
import { tierRevisions } from "./vitality/projection.js";

export type LedgerOptions = {
	/** The data directory. The Ledger lives at `<home>/ledger.sqlite`. */
	home: string;
	/** Open for writing. Only one writer may hold the Ledger at a time. */
	writer: boolean;
	/** Source of each Event's `ts`. Defaults to the wall clock. */
	clock?: () => Date;
	/** Guards run before every append. Defaults to `appendGuards`. */
	guards?: readonly AppendGuard[];
	/** Follow-ons run after every append. Defaults to `[tierRevisions]`. */
	followOns?: readonly FollowOn[];
};

/**
 * The Events an append requires after its cause, given the Ledger with the
 * cause at its end. The Ledger writes them in the same transaction, through
 * the same guards, and writes none of them, nor the cause, if any is refused.
 */
export type FollowOn = (events: readonly Event[], cause: Event) => NewEvent[];

export type Ledger = {
	readonly path: string;
	/**
	 * Validate, guard, number, hash, and write one Event and its follow-ons
	 * in one transaction, and return that Event. Throws `AppendRefused`.
	 */
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

const insertStatement = (db: DatabaseSync) =>
	db.prepare(
		`INSERT INTO events (seq, ts, actor, task_id, causation_id, kind, payload, prev_hash, hash)
		 VALUES (:seq, :ts, :actor, :task_id, :causation_id, :kind, :payload, :prev_hash, :hash)`,
	);

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

const stripUndefined = (o: object): Record<string, unknown> =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const eventOf = (row: Row): Event =>
	Event.parse(stripUndefined({ ...hashedFields(row), hash: row.hash }));

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

/**
 * Parse an Event body that arrived from outside, such as JSON from the
 * command line. Throws `AppendRefused` naming every problem.
 */
export const parseNewEvent = (input: unknown): NewEvent => {
	const parsed = NewEvent.safeParse(input);
	if (!parsed.success) {
		const kind =
			typeof input === "object" && input !== null && "kind" in input
				? ` of kind ${JSON.stringify(input.kind)}`
				: "";
		throw new AppendRefused(
			`invalid Event${kind}: ${z.prettifyError(parsed.error)}`,
		);
	}
	return parsed.data;
};

/** Another process holds the Ledger for writing. */
export class LedgerLocked extends Error {
	override readonly name = "LedgerLocked";
	constructor(lockPath: string, pid: number | "unknown") {
		super(`${lockPath} held by pid ${pid}`);
	}
}

const errnoIs = (error: unknown, code: string) =>
	error instanceof Error && "code" in error && error.code === code;

const isRunning = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoIs(error, "EPERM");
	}
};

/** The pid a lock file names; undefined when the file is gone. */
const lockHolder = (path: string): number | "unknown" | undefined => {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errnoIs(error, "ENOENT")) return undefined;
		throw error;
	}
	const pid = Number(text.trim());
	return Number.isInteger(pid) && pid > 0 ? pid : "unknown";
};

/** Create `path` holding our pid; false when it already exists. */
const createExclusive = (path: string): boolean => {
	try {
		writeFileSync(path, String(process.pid), { flag: "wx" });
		return true;
	} catch (error) {
		if (errnoIs(error, "EEXIST")) return false;
		throw error;
	}
};

/**
 * Create the lock file with our pid, taking over one whose pid is dead.
 *
 * Two processes can find the same stale lock at once. If each deleted it
 * and created its own, the slower one would delete the faster one's fresh
 * lock and both would write. Renaming the stale file aside first does not
 * help: the slower rename can move the faster process's fresh lock, and a
 * third process can create the lock in the gap. So a takeover happens only
 * under a second lock, `<lock>.takeover`, created with `wx`. While a process
 * holds it, nobody else removes the lock file, and nobody creates one while
 * it exists, so the dead pid that process reads is still the one it removes.
 * A process that finds a takeover in progress reports the lock as held.
 */
const acquireLock = (lockPath: string) => {
	const takeover = `${lockPath}.takeover`;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (createExclusive(lockPath)) return;
		const stale = lockHolder(lockPath);
		if (stale === undefined) continue; // released meanwhile; try again
		if (stale === "unknown" || isRunning(stale)) {
			throw new LedgerLocked(lockPath, stale);
		}
		if (!createExclusive(takeover)) {
			const other = lockHolder(takeover);
			if (typeof other === "number" && !isRunning(other)) {
				throw new Error(
					`${takeover} was left by pid ${other}, which stopped while taking over ${lockPath}; check that no Conductor runs, then delete ${takeover}`,
				);
			}
			throw new LedgerLocked(lockPath, other ?? "unknown");
		}
		try {
			if (lockHolder(lockPath) === stale) rmSync(lockPath, { force: true });
			if (createExclusive(lockPath)) return;
			throw new LedgerLocked(lockPath, lockHolder(lockPath) ?? "unknown");
		} finally {
			rmSync(takeover, { force: true });
		}
	}
	throw new LedgerLocked(lockPath, "unknown");
};

const releaseLock = (lockPath: string) => {
	if (
		existsSync(lockPath) &&
		readFileSync(lockPath, "utf8") === String(process.pid)
	) {
		rmSync(lockPath);
	}
};

const openDatabase = (path: string, writer: boolean) => {
	if (!writer) {
		if (!existsSync(path)) throw new Error(`no Ledger at ${path}`);
		return new DatabaseSync(path, { readOnly: true });
	}
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	return db;
};

export const openLedger = (options: LedgerOptions): Ledger => {
	const path = join(options.home, "ledger.sqlite");
	const lockPath = `${path}.lock`;
	const clock = options.clock ?? (() => new Date());
	const guards = options.guards ?? appendGuards;
	const followOns = options.followOns ?? [tierRevisions];

	if (options.writer) {
		mkdirSync(options.home, { recursive: true });
		acquireLock(lockPath);
	}
	let db: DatabaseSync;
	try {
		db = openDatabase(path, options.writer);
	} catch (error) {
		if (options.writer) releaseLock(lockPath);
		throw error;
	}

	const selectAll = db.prepare("SELECT * FROM events ORDER BY seq");
	const insert = options.writer ? insertStatement(db) : undefined;

	function* events(): IterableIterator<Event> {
		for (const row of selectAll.iterate()) yield eventOf(Row.parse(row));
	}

	// The writer holds the lock, so no one else appends; the Events it has
	// read once stay current and each append only adds to them.
	let appended: Event[] | undefined;

	const append = (newEvent: NewEvent): Event => {
		if (!insert) {
			throw new Error(
				`Ledger at ${path} is open read-only; open it with writer: true to append`,
			);
		}
		/** Number, hash, guard and insert one Event after `written`, and add it there. */
		const write = (written: Event[], newEvent: NewEvent): Event => {
			const body = parseNewEvent(newEvent);
			const last = written.at(-1);
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

			for (const guard of guards) guard({ events: written }, event);

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
			written.push(event);
			return event;
		};

		db.exec("BEGIN IMMEDIATE");
		try {
			appended ??= [...events()];
			// A copy, so a refusal anywhere in the transaction leaves `appended`
			// as the Ledger was before the call.
			const written = [...appended];
			const cause = write(written, newEvent);
			for (const followOn of followOns) {
				for (const next of followOn(written, cause)) write(written, next);
			}
			db.exec("COMMIT");
			appended = written;
			return cause;
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
		close: () => {
			db.close();
			if (options.writer) releaseLock(lockPath);
		},
	};
};
