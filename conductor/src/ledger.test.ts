import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEvent } from "./events.js";
import { AppendRefused } from "./guards.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { AgentId, Seq, TaskId } from "./ids.js";
import { type Ledger, LedgerLocked, openLedger } from "./ledger.js";

const odile = AgentId.parse("A-odile");

const paused = (reason: string): NewEvent => ({
	actor: { tag: "Operator" },
	kind: "AgentPaused",
	payload: { agent_id: odile, reason },
});

/** A mix of kinds, with and without the optional envelope fields. */
const sampleEvent = (i: number): NewEvent => {
	const task_id = TaskId.parse(`T-${i}`);
	switch (i % 3) {
		case 0:
			return paused(`pause ${i}`);
		case 1:
			return {
				actor: { tag: "Agent", id: odile },
				task_id,
				kind: "TaskStarted",
				payload: { task_id },
			};
		default:
			return {
				actor: { tag: "Operator" },
				task_id,
				causation_id: Seq.parse(i - 1),
				kind: "MessageSent",
				payload: { to: [{ tag: "Agent", id: odile }], body: `note ${i}` },
			};
	}
};

const appendSamples = (l: Ledger, n: number) => {
	for (let i = 1; i <= n; i++) l.append(sampleEvent(i));
};

/** Change the SQLite file behind the Ledger's back, as a tamperer would. */
const tamper = (sql: string) => {
	const db = new DatabaseSync(join(home, "ledger.sqlite"));
	db.exec(sql);
	db.close();
};

// The refusal tests hand the Ledger values the type system would reject, the
// way JSON from the command line arrives.
const untyped = (value: unknown) => value as NewEvent;

let home: string;
let ledger: Ledger | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-ledger-"));
});

afterEach(() => {
	ledger?.close();
	ledger = undefined;
	rmSync(home, { recursive: true, force: true });
});

// These tests cover the Ledger's mechanics; domain guards would refuse the
// sample Events, which name Agents and Tasks that were never created.
const openWriter = () => {
	ledger = openLedger({ home, writer: true, guards: [] });
	return ledger;
};

describe("Ledger append", () => {
	it("refuses an Event with an unknown kind and writes nothing", () => {
		const l = openWriter();
		l.append(paused("first"));

		expect(() =>
			l.append(
				untyped({
					actor: { tag: "Operator" },
					kind: "AgentDanced",
					payload: {},
				}),
			),
		).toThrow(AppendRefused);

		expect(l.all().map((e) => e.kind)).toEqual(["AgentPaused"]);
	});

	it.each([
		["a missing payload field", { agent_id: "A-odile" }],
		["a malformed AgentId", { agent_id: "odile", reason: "r" }],
		["an unknown payload field", { agent_id: "A-odile", reason: "r", x: 1 }],
	])("refuses a payload with %s and writes nothing", (_, payload) => {
		const l = openWriter();

		const append = () =>
			l.append(
				untyped({ actor: { tag: "Operator" }, kind: "AgentPaused", payload }),
			);

		expect(append).toThrow(AppendRefused);
		expect(append).toThrow(/payload/);

		expect(l.all()).toEqual([]);
	});

	it("numbers Events from 1 and chains each to the previous hash", () => {
		const l = openWriter();
		const first = l.append(paused("one"));
		const second = l.append(paused("two"));

		expect(first.seq).toBe(1);
		expect(first.prev_hash).toBe("0".repeat(64));
		expect(second.seq).toBe(2);
		expect(second.prev_hash).toBe(first.hash);
		expect(second.hash).not.toBe(first.hash);
	});

	it("stamps each Event with the injected clock", () => {
		ledger = openLedger({
			home,
			writer: true,
			clock: () => new Date("2026-10-12T09:30:00Z"),
			guards: [],
		});

		expect(ledger.append(paused("timed")).ts).toBe("2026-10-12T09:30:00.000Z");
	});

	it("runs every guard before writing, and a refusal writes nothing", () => {
		const seen: number[] = [];
		ledger = openLedger({
			home,
			writer: true,
			guards: [
				(ctx) => {
					seen.push(ctx.events.length);
				},
				(_, event) => {
					if (event.kind === "AgentPaused" && event.payload.reason === "no") {
						throw new AppendRefused("reason 'no' is refused");
					}
				},
			],
		});
		ledger.append(paused("yes"));

		expect(() => ledger?.append(paused("no"))).toThrow(
			"reason 'no' is refused",
		);
		expect(ledger.all().map((e) => e.seq)).toEqual([1]);
		expect(seen).toEqual([0, 1]);
	});
});

describe("Ledger verify", () => {
	it("passes on a freshly written Ledger of 120 Events", () => {
		const l = openWriter();
		appendSamples(l, 120);

		expect(l.verify()).toEqual({ ok: true, count: 120 });
	});

	it("passes on an empty Ledger", () => {
		expect(openWriter().verify()).toEqual({ ok: true, count: 0 });
	});

	it("names the edited seq when one payload is changed in SQLite", () => {
		const l = openWriter();
		appendSamples(l, 120);
		tamper(
			`UPDATE events SET payload = json_set(payload, '$.reason', 'forged') WHERE seq = 57`,
		);

		expect(l.verify()).toEqual({
			ok: false,
			seq: 57,
			reason: "hash does not match the Event's contents",
		});
	});

	it("names the next seq when an edited row's hash is also recomputed", () => {
		const l = openWriter();
		appendSamples(l, 120);
		const db = new DatabaseSync(join(home, "ledger.sqlite"));
		const row = db.prepare("SELECT * FROM events WHERE seq = 57").get() as {
			ts: string;
			actor: string;
			kind: string;
			payload: string;
			prev_hash: string;
		};
		const payload = { ...JSON.parse(row.payload), reason: "forged" };
		const hash = sha256Hex(
			canonicalJson({
				seq: 57,
				ts: row.ts,
				actor: JSON.parse(row.actor),
				kind: row.kind,
				payload,
				prev_hash: row.prev_hash,
			}),
		);
		db.prepare("UPDATE events SET payload = ?, hash = ? WHERE seq = 57").run(
			canonicalJson(payload),
			hash,
		);
		db.close();

		expect(l.verify()).toEqual({
			ok: false,
			seq: 58,
			reason: "prev_hash does not match the hash of seq 57",
		});
	});

	it("names the missing seq when one row is deleted in SQLite", () => {
		const l = openWriter();
		appendSamples(l, 120);
		tamper("DELETE FROM events WHERE seq = 57");

		expect(l.verify()).toEqual({
			ok: false,
			seq: 57,
			reason: "seq 57 is missing; the next row is seq 58",
		});
	});

	it("names the seq whose stored JSON no longer parses", () => {
		const l = openWriter();
		appendSamples(l, 10);
		tamper("UPDATE events SET actor = '{not json' WHERE seq = 4");

		expect(l.verify()).toMatchObject({ ok: false, seq: 4 });
	});
});

describe("Ledger single writer", () => {
	const lockPath = () => join(home, "ledger.sqlite.lock");

	it("refuses a second writer while the first is open, naming the holder", () => {
		openWriter();

		const second = () => openLedger({ home, writer: true });

		expect(second).toThrow(LedgerLocked);
		expect(second).toThrow(`${lockPath()} held by pid ${process.pid}`);
	});

	it("lets a second writer open after the first closes", () => {
		openWriter().append(paused("before"));
		ledger?.close();

		ledger = openLedger({ home, writer: true, guards: [] });
		ledger.append(paused("after"));

		expect(ledger.all().map((e) => e.seq)).toEqual([1, 2]);
		ledger.close();
		ledger = undefined;
		expect(existsSync(lockPath())).toBe(false);
	});

	it("takes over a lock left by a process that no longer runs", () => {
		const exited = spawnSync(process.execPath, ["-e", ""]);
		writeFileSync(lockPath(), String(exited.pid));

		openWriter().append(paused("recovered"));

		expect(ledger?.all()).toHaveLength(1);
		expect(readFileSync(lockPath(), "utf8")).toBe(String(process.pid));
		expect(readdirSync(home).filter((f) => f.includes(".stale-"))).toEqual([]);
	});

	it("leaves a stale lock alone while another process is taking it over", () => {
		const exited = spawnSync(process.execPath, ["-e", ""]);
		writeFileSync(lockPath(), String(exited.pid));
		writeFileSync(`${lockPath()}.takeover`, String(process.pid));

		expect(() => openLedger({ home, writer: true })).toThrow(
			`${lockPath()} held by pid ${process.pid}`,
		);
		expect(readFileSync(lockPath(), "utf8")).toBe(String(exited.pid));

		writeFileSync(`${lockPath()}.takeover`, String(exited.pid));
		expect(() => openLedger({ home, writer: true })).toThrow(
			`${lockPath()}.takeover was left by pid ${exited.pid}, which stopped while taking over`,
		);
	});

	it("lets a reader verify while a writer holds the Ledger, but not append", () => {
		openWriter().append(paused("one"));
		const reader = openLedger({ home, writer: false });
		try {
			expect(reader.verify()).toEqual({ ok: true, count: 1 });
			expect(() => reader.append(paused("two"))).toThrow(/read-only/);
		} finally {
			reader.close();
		}
	});

	it("refuses to open a reader where no Ledger exists", () => {
		expect(() => openLedger({ home, writer: false })).toThrow(
			`no Ledger at ${join(home, "ledger.sqlite")}`,
		);
	});
});
