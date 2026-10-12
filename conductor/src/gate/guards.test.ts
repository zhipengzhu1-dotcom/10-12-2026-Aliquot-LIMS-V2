import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { AgentId, GateId, IsoTime, type Sha256 } from "../ids.js";
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
