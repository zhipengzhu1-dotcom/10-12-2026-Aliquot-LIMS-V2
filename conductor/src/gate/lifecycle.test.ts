import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../hash.js";
import { AgentId, GateId, Sha256 } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { block } from "../task/lifecycle.js";
import { TEST_OPERATOR } from "../test-support/operator.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import { decideGate, requestGate } from "./lifecycle.js";

const bram: Actor = { tag: "Agent", id: AgentId.parse("A-bram") };
const payload = { target: "receiving-screen", version: "1.2.0" };
// sha256 of {"target":"receiving-screen","version":"1.2.0"}, from shasum.
const payloadHash = Sha256.parse(
	"644b4ff33f551679c2cafd567934dd65cb8ea3d3c6bae02b1d676fafc67892e5",
);

let s: Scenario;
let ledger: Ledger;

beforeEach(() => {
	s = scenario("2026-10-12T09:00:00.000Z");
	ledger = s.ledger;
});

afterEach(() => s.close());

const eventAt = (seq: number) => ledger.all().find((e) => e.seq === seq);

const deploy = () =>
	requestGate(ledger, { actor: bram, kind: "Deploy", payload });

/** Run `refused`, expect it to throw `reason`, and expect nothing written. */
const expectRefused = (refused: () => unknown, reason: string) => {
	const before = ledger.all().length;
	expect(refused).toThrow(reason);
	expect(ledger.all(), "a refusal writes nothing").toHaveLength(before);
};

describe("requesting a Gate", () => {
	it("requests a Gate under the next free gate id, for the hash of its payload, naming no cause and no Task, and returns the Gate and its seq", () => {
		const first = deploy();
		const second = requestGate(ledger, {
			actor: { tag: "Operator" },
			kind: "RetireAgent",
			payload: { agent_id: "A-rin" },
			lifetime_s: 60,
		});

		expect(first.gate).toMatchObject({
			id: "G-1",
			kind: "Deploy",
			requester: bram,
			payload,
			payload_hash: payloadHash,
			lifetime_s: 86400,
		});
		expect(second.gate).toMatchObject({ id: "G-2", lifetime_s: 60 });
		const stored = eventAt(first.seq);
		expect(stored).toMatchObject({
			kind: "GateRequested",
			actor: bram,
			payload: { gate_id: "G-1", payload_hash: payloadHash },
		});
		expect(stored?.causation_id).toBeUndefined();
		expect(stored?.task_id).toBeUndefined();
	});
});

describe("deciding a Gate", () => {
	it("records the Operator's decision on the payload hash the Operator checked, naming the Gate's request as its cause, and returns the decided Gate", () => {
		const requested = deploy();
		s.at("2026-10-12T09:10:00.000Z");

		const decided = decideGate(ledger, {
			actor: TEST_OPERATOR,
			gate_id: requested.gate.id,
			payload_hash: payloadHash,
			meaning: "approve",
			reason: "diff checked",
		});

		expect(decided.gate.decision).toEqual({
			gate_id: "G-1",
			decided_by: TEST_OPERATOR,
			decided_at: "2026-10-12T09:10:00.000Z",
			payload_hash: payloadHash,
			meaning: "approve",
			reason: "diff checked",
			seq: decided.seq,
		});
		expect(eventAt(decided.seq)).toMatchObject({
			kind: "GateDecided",
			actor: TEST_OPERATOR,
			causation_id: requested.seq,
		});
	});

	it("names the blocked Task, which goes back InProgress", () => {
		const task_id = s.task(AgentId.parse("A-bram"));
		const blocked = block(ledger, {
			actor: bram,
			task_id,
			kind: "Deploy",
			payload,
		});

		const decided = decideGate(ledger, {
			actor: TEST_OPERATOR,
			gate_id: blocked.gate.id,
			payload_hash: payloadHash,
			meaning: "reject",
			reason: "wrong version",
		});

		expect(eventAt(decided.seq)).toMatchObject({
			task_id,
			causation_id: blocked.seq,
		});
		expect(ledger.projections.tasks.tasks.get(task_id)?.state).toEqual({
			tag: "InProgress",
			assignee: "A-bram",
		});
	});

	it("refuses a payload hash that is not the stored one, and writes nothing", () => {
		deploy();
		const other = sha256Hex(canonicalJson({ ...payload, version: "1.2.1" }));

		expectRefused(
			() =>
				decideGate(ledger, {
					actor: TEST_OPERATOR,
					gate_id: GateId.parse("G-1"),
					payload_hash: Sha256.parse(other),
					meaning: "approve",
					reason: "ok",
				}),
			`GateDecided refused: payload_hash ${other} does not match G-1's payload, which hashes to ${payloadHash}`,
		);
	});

	it("refuses a Gate that was never requested, and writes nothing", () => {
		expectRefused(
			() =>
				decideGate(ledger, {
					actor: TEST_OPERATOR,
					gate_id: GateId.parse("G-9"),
					payload_hash: payloadHash,
					meaning: "approve",
					reason: "ok",
				}),
			"GateDecided refused: no Gate G-9 was requested",
		);
	});
});
