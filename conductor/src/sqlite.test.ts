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
import { canonicalJson, sha256Hex } from "./hash.js";
import { AgentId, RoomId, TaskId } from "./ids.js";
import {
	type Ledger,
	LedgerLocked,
	openLedger,
	verifyLedger,
} from "./ledger.js";
import { LAB_ROOM } from "./room/seed.js";
import { sqliteStorage } from "./storage.js";
import { forge } from "./test-support/forge.js";
import {
	type NonTaskEvent,
	scenario,
	scores,
} from "./test-support/scenario.js";

const operator = { tag: "Operator" } as const;

const opened: NonTaskEvent = {
	actor: operator,
	kind: "RoomOpened",
	payload: { room: LAB_ROOM },
};

const said = (body: string): NonTaskEvent => ({
	actor: operator,
	kind: "MessageSent",
	payload: { room_id: RoomId.parse("RM-lab"), body },
});

/** The Lab Room and `n` Messages in it. */
const appendSamples = (l: Ledger, n: number) => {
	l.append(opened);
	for (let i = 2; i <= n; i++) l.append(said(`note ${i}`));
};

/** Change the SQLite file behind the Ledger's back, as a tamperer would. */
const tamper = (sql: string) => {
	const db = new DatabaseSync(join(home, "ledger.sqlite"));
	db.exec(sql);
	db.close();
};

let home: string;
let ledger: Ledger | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-sqlite-"));
});

afterEach(() => {
	ledger?.close();
	ledger = undefined;
	rmSync(home, { recursive: true, force: true });
});

const openWriter = () => {
	ledger = openLedger({ home, writer: true });
	return ledger;
};

describe("SQLite Ledger persistence", () => {
	it("keeps its Events across opens, and the next writer appends after them", () => {
		appendSamples(openWriter(), 3);
		ledger?.close();

		ledger = openLedger({ home, writer: true });
		ledger.append(said("after"));

		expect(
			ledger
				.all()
				.map((e) => (e.kind === "MessageSent" ? e.payload.body : e.kind)),
		).toEqual(["RoomOpened", "note 2", "note 3", "after"]);
		expect(ledger.verify()).toEqual({ ok: true, count: 4 });
	});

	it("gives a reader the same Projections as the writer after a scenario", () => {
		const rin = AgentId.parse("A-rin");
		const s = scenario(undefined, { home });
		for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));
		const t = s.task(rin);
		s.run(t, 1, 0.4);
		s.appendNonTask({
			actor: operator,
			kind: "RestOrdered",
			payload: {
				agent_id: AgentId.parse("A-ines"),
				action: "begin",
				reason: "r",
			},
		});
		s.gate("PromoteToMentor", { agent_id: rin }, "reject");
		s.retire(AgentId.parse("A-bram"), "Replaced");
		s.appendNonTask(opened);
		s.appendNonTask(said("Rin is Trusted now"));

		const reader = openLedger({ home, writer: false });
		try {
			expect(reader.projections).toEqual(s.ledger.projections);
			expect(reader.projections.trust.agents.get(rin)?.tier).toBe("Trusted");
		} finally {
			reader.close();
			s.close();
		}
	});
});

describe("SQLite Ledger verify", () => {
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
			`UPDATE events SET payload = json_set(payload, '$.body', 'forged') WHERE seq = 57`,
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
		const payload = { ...JSON.parse(row.payload), body: "forged" };
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

	it("names the seq whose stored JSON no longer parses, even though the Ledger no longer opens", () => {
		appendSamples(openWriter(), 10);
		ledger?.close();
		ledger = undefined;
		tamper("UPDATE events SET actor = '{not json' WHERE seq = 4");

		expect(() => openLedger({ home, writer: false })).toThrow();
		expect(verifyLedger(home)).toMatchObject({ ok: false, seq: 4 });
	});

	it("opens no Ledger holding an Event its guards refuse, though its chain is intact", () => {
		const storage = sqliteStorage(home, true);
		const task_id = TaskId.parse("T-1");
		forge(storage, [
			opened,
			{ actor: operator, task_id, kind: "TaskStarted", payload: { task_id } },
		]);
		storage.close();

		expect(() => openLedger({ home, writer: false })).toThrow(
			`${join(home, "ledger.sqlite")} is corrupt at seq 2: TaskStarted refused: T-1 does not exist`,
		);
		expect(verifyLedger(home)).toEqual({ ok: true, count: 2 });
	});
});

describe("SQLite Ledger single writer", () => {
	const lockPath = () => join(home, "ledger.sqlite.lock");

	it("refuses a second writer while the first is open, naming the holder", () => {
		openWriter();

		const second = () => openLedger({ home, writer: true });

		expect(second).toThrow(LedgerLocked);
		expect(second).toThrow(`${lockPath()} held by pid ${process.pid}`);
	});

	it("lets a second writer open after the first closes", () => {
		openWriter().append(opened);
		ledger?.close();

		ledger = openLedger({ home, writer: true });
		ledger.append(said("after"));

		expect(ledger.all().map((e) => e.seq)).toEqual([1, 2]);
		ledger.close();
		ledger = undefined;
		expect(existsSync(lockPath())).toBe(false);
	});

	it("takes over a lock left by a process that no longer runs", () => {
		const exited = spawnSync(process.execPath, ["-e", ""]);
		writeFileSync(lockPath(), String(exited.pid));

		openWriter().append(opened);

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
		openWriter().append(opened);
		const reader = openLedger({ home, writer: false });
		try {
			expect(reader.verify()).toEqual({ ok: true, count: 1 });
			expect(() => reader.append(said("two"))).toThrow(/read-only/);
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
