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
import { Event } from "./events.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { Sha256 } from "./ids.js";

/**
 * Where a Ledger keeps its Events, one row per Event in seq order. Storage
 * only keeps rows: the Ledger numbers, hashes, guards and projects them, so
 * every storage runs the same rules (ADR-0008).
 */
export type Storage = {
	/** Where the rows live, for messages. */
	readonly path: string;
	/** Every row in seq order, as stored. */
	rows(): Iterable<unknown>;
	/** Run `body`, writing every row it inserts, or none if it throws. */
	transaction<T>(body: (insert: (row: Row) => void) => T): T;
	close(): void;
};

export const Row = z.object({
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
export type Row = z.infer<typeof Row>;

export const GENESIS_HASH = Sha256.parse("0".repeat(64));

/** The fields the hash covers, with absent optional fields omitted. */
export const hashedFields = (row: Row) => ({
	seq: row.seq,
	ts: row.ts,
	actor: JSON.parse(row.actor) as unknown,
	task_id: row.task_id ?? undefined,
	causation_id: row.causation_id ?? undefined,
	kind: row.kind,
	payload: JSON.parse(row.payload) as unknown,
	prev_hash: row.prev_hash,
});

export const stripUndefined = (o: object): Record<string, unknown> =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const eventOf = (row: Row): Event =>
	Event.parse(stripUndefined({ ...hashedFields(row), hash: row.hash }));

export const rowOf = (event: Event): Row => ({
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

export type VerifyResult =
	| { ok: true; count: number }
	| { ok: false; seq: number; reason: string };

/** Walk the chain from seq 1 and report the first broken link. */
export const verifyRows = (rows: Iterable<unknown>): VerifyResult => {
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

/** Rows held in this process only; for tests and for nothing that must last. */
export const memoryStorage = (): Storage => {
	const rows: Row[] = [];
	return {
		path: ":memory:",
		rows: () => [...rows],
		transaction: (body) => {
			const length = rows.length;
			try {
				return body((row) => rows.push(row));
			} catch (error) {
				rows.length = length;
				throw error;
			}
		},
		close: () => {},
	};
};

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

/** The SQLite file of a data directory. */
export const sqlitePath = (home: string) => join(home, "ledger.sqlite");

/**
 * The SQLite file `<home>/ledger.sqlite`, the Ledger's production storage.
 * A writer creates it and holds `<file>.lock` until it closes, so only one
 * process writes (ADR-0008); a reader needs the file to exist.
 */
export const sqliteStorage = (home: string, writer: boolean): Storage => {
	const path = sqlitePath(home);
	const lockPath = `${path}.lock`;
	let db: DatabaseSync;
	if (writer) {
		mkdirSync(home, { recursive: true });
		acquireLock(lockPath);
		try {
			db = new DatabaseSync(path);
			db.exec(SCHEMA);
		} catch (error) {
			releaseLock(lockPath);
			throw error;
		}
	} else {
		if (!existsSync(path)) throw new Error(`no Ledger at ${path}`);
		db = new DatabaseSync(path, { readOnly: true });
	}

	const selectAll = db.prepare("SELECT * FROM events ORDER BY seq");
	const insert = writer
		? db.prepare(
				`INSERT INTO events (seq, ts, actor, task_id, causation_id, kind, payload, prev_hash, hash)
				 VALUES (:seq, :ts, :actor, :task_id, :causation_id, :kind, :payload, :prev_hash, :hash)`,
			)
		: undefined;

	return {
		path,
		rows: () => selectAll.iterate(),
		transaction: (body) => {
			if (insert === undefined) {
				throw new Error(
					`Ledger at ${path} is open read-only; open it with writer: true to append`,
				);
			}
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = body((row) => insert.run(row));
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close: () => {
			db.close();
			if (writer) releaseLock(lockPath);
		},
	};
};
