import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import {
	AgentId,
	GateId,
	IsoTime,
	RubricId,
	type Sha256,
	TaskId,
} from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";

const bram = AgentId.parse("A-bram");
const g1 = GateId.parse("G-1");
const payload = { target: "receiving-screen", version: "1.2.0" };
const hashOf = (value: unknown) => sha256Hex(canonicalJson(value));

const request = (
	gate_id = g1,
	body: unknown = payload,
	lifetime_s = 3600,
): NewEvent => ({
	actor: { tag: "Agent", id: bram },
	kind: "GateRequested",
	payload: {
		gate_id,
		kind: "Deploy",
		payload: body as never,
		payload_hash: hashOf(body),
		lifetime_s,
	},
});

const decide = (
	decided_at: string,
	overrides: { payload_hash?: Sha256; actor?: NewEvent["actor"] } = {},
	gate_id = g1,
): NewEvent => ({
	actor: overrides.actor ?? { tag: "Operator" },
	kind: "GateDecided",
	payload: {
		gate_id,
		decided_by: { tag: "Operator" },
		decided_at: IsoTime.parse(decided_at),
		payload_hash: overrides.payload_hash ?? hashOf(payload),
		meaning: "approve",
		reason: "checked the diff",
	},
});

// The refusal tests hand the Ledger values the type system would reject, the
// way JSON from the command line arrives.
const untyped = (value: unknown) => value as NewEvent;

let home: string;
let now: Date;
let ledger: Ledger;

const at = (iso: string) => {
	now = new Date(iso);
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-gate-"));
	now = new Date("2026-10-12T09:00:00.000Z");
	ledger = openLedger({ home, writer: true, clock: () => now });
});

afterEach(() => {
	ledger.close();
	rmSync(home, { recursive: true, force: true });
});

const expectRefused = (event: NewEvent, reason: RegExp) => {
	const before = ledger.all().length;
	expect(() => ledger.append(event)).toThrow(AppendRefused);
	expect(() => ledger.append(event)).toThrow(reason);
	expect(ledger.all()).toHaveLength(before);
};

describe("GateDecided", () => {
	it("is refused from any actor other than the Operator", () => {
		ledger.append(request());
		at("2026-10-12T09:10:00.000Z");
		expectRefused(
			decide("2026-10-12T09:10:00.000Z", { actor: { tag: "Agent", id: bram } }),
			/only the Operator/,
		);
	});

	it("is refused when decided_by names anyone but the Operator", () => {
		ledger.append(request());
		at("2026-10-12T09:10:00.000Z");
		const event = decide("2026-10-12T09:10:00.000Z");
		expectRefused(
			untyped({
				...event,
				payload: { ...event.payload, decided_by: { tag: "Agent", id: bram } },
			}),
			/decided_by/,
		);
	});

	it("is refused for a Gate that was never requested", () => {
		expectRefused(decide("2026-10-12T09:00:00.000Z"), /no Gate G-1/);
	});

	it("is refused for a Gate that is already decided", () => {
		ledger.append(request());
		at("2026-10-12T09:10:00.000Z");
		ledger.append(decide("2026-10-12T09:10:00.000Z"));
		at("2026-10-12T09:20:00.000Z");
		expectRefused(
			decide("2026-10-12T09:20:00.000Z"),
			/G-1 is already Approved/,
		);
	});

	it("is refused once the Gate's lifetime has ended, judged by the Event's own ts", () => {
		ledger.append(request(g1, payload, 3600));
		at("2026-10-12T10:00:00.000Z");
		expectRefused(
			decide("2026-10-12T10:00:00.000Z"),
			/G-1 expired at 2026-10-12T10:00:00.000Z/,
		);
		at("2026-10-12T09:59:59.999Z");
		expect(ledger.append(decide("2026-10-12T09:59:59.999Z")).seq).toBe(2);
	});

	it("is refused when its payload_hash is not the hash of the requested payload", () => {
		ledger.append(request());
		at("2026-10-12T09:10:00.000Z");
		const changed = { ...payload, version: "1.2.1" };
		expectRefused(
			decide("2026-10-12T09:10:00.000Z", { payload_hash: hashOf(changed) }),
			/payload_hash .* does not match/,
		);
	});

	it("cannot approve a changed payload, re-requested as a new Gate, with the old hash", () => {
		ledger.append(request());
		const changed = { ...payload, version: "1.2.1" };
		const g2 = GateId.parse("G-2");
		ledger.append(request(g2, changed));
		at("2026-10-12T09:10:00.000Z");
		expectRefused(
			decide("2026-10-12T09:10:00.000Z", { payload_hash: hashOf(payload) }, g2),
			/payload_hash .* does not match/,
		);
		const approved = ledger.append(
			decide("2026-10-12T09:10:00.000Z", { payload_hash: hashOf(changed) }, g2),
		);
		expect(approved.payload).toMatchObject({ gate_id: "G-2" });
	});

	it("is refused when decided_at is not the Event's own ts", () => {
		ledger.append(request());
		at("2026-10-12T09:10:00.000Z");
		expectRefused(decide("2026-10-12T09:05:00.000Z"), /decided_at/);
	});

	it("is refused when its task_id is not the Task that requested the Gate", () => {
		ledger.append({ ...request(), task_id: TaskId.parse("T-3") });
		at("2026-10-12T09:10:00.000Z");
		const event = decide("2026-10-12T09:10:00.000Z");
		expectRefused({ ...event, task_id: TaskId.parse("T-4") }, /task_id/);
		expectRefused(event, /task_id/);
		expect(ledger.append({ ...event, task_id: TaskId.parse("T-3") }).seq).toBe(
			2,
		);
	});

	it("is accepted from the Operator with the payload's hash", () => {
		ledger.append(request());
		at("2026-10-12T09:10:00.000Z");
		const event = ledger.append(decide("2026-10-12T09:10:00.000Z"));
		expect(event).toMatchObject({
			seq: 2,
			actor: { tag: "Operator" },
			payload: { gate_id: "G-1", payload_hash: hashOf(payload) },
		});
	});
});

describe("GateRequested", () => {
	it("is refused when payload_hash is not the hash of its payload", () => {
		const event = request();
		expectRefused(
			untyped({
				...event,
				payload: { ...event.payload, payload_hash: hashOf({ other: 1 }) },
			}),
			/payload_hash .* is not the hash of the payload/,
		);
	});

	it("is refused for a kind outside the five Gate kinds", () => {
		const event = request();
		expectRefused(
			untyped({ ...event, payload: { ...event.payload, kind: "DropTable" } }),
			/kind/,
		);
	});

	it("is refused when the gate id is already taken", () => {
		ledger.append(request());
		expectRefused(request(g1, { other: "payload" }), /G-1 already exists/);
	});
});

describe("a Task that requests a Gate", () => {
	const t3 = TaskId.parse("T-3");

	it("carries its task_id on both the request and the decision, so the Task Projection can block and release it", () => {
		const asBram = { actor: { tag: "Agent", id: bram }, task_id: t3 } as const;
		ledger.append({
			actor: { tag: "Operator" },
			task_id: t3,
			kind: "TaskProposed",
			payload: {
				task_id: t3,
				title: "Deploy the receiving screen",
				goal: "Lab staff log receipts on screen",
				inputs: [],
				rubric_id: RubricId.parse("deploy"),
				priority: 1,
				tat_class: "Regular",
			},
		});
		ledger.append({
			actor: { tag: "Operator" },
			task_id: t3,
			kind: "TaskAssigned",
			payload: { task_id: t3, assignee: bram },
		});
		ledger.append({ ...asBram, kind: "TaskStarted", payload: { task_id: t3 } });
		const requested = ledger.append({ ...request(), ...asBram });
		at("2026-10-12T09:10:00.000Z");
		const decided = ledger.append({
			...decide("2026-10-12T09:10:00.000Z"),
			task_id: t3,
		});

		expect(requested).toMatchObject({
			kind: "GateRequested",
			task_id: "T-3",
			payload: { gate_id: "G-1" },
		});
		expect(decided).toMatchObject({
			kind: "GateDecided",
			actor: { tag: "Operator" },
			task_id: "T-3",
			payload: { gate_id: "G-1" },
		});
	});
});
