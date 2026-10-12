import { describe, expect, it } from "vitest";
import type { Event } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { AgentId, GateId, IsoTime, Seq, Sha256, TaskId } from "../ids.js";
import { fold } from "../reduce.js";
import { GateProjection, gateState } from "./projection.js";

const zeros = Sha256.parse("0".repeat(64));
const g1 = GateId.parse("G-1");
const payload = { target: "receiving-screen", version: "1.2.0" };
const payloadHash = sha256Hex(canonicalJson(payload));

// The projection reads only the Event's fields, so these Events skip the
// Ledger; the hash chain is the Ledger's concern, not the Projection's.
const recorded = (seq: number, ts: string) => ({
	seq: Seq.parse(seq),
	ts: IsoTime.parse(ts),
	prev_hash: zeros,
	hash: zeros,
});

const requested: Event = {
	...recorded(1, "2026-10-12T09:00:00.000Z"),
	actor: { tag: "Agent", id: AgentId.parse("A-bram") },
	task_id: TaskId.parse("T-3"),
	kind: "GateRequested",
	payload: {
		gate_id: g1,
		kind: "Deploy",
		payload,
		payload_hash: payloadHash,
		lifetime_s: 3600,
	},
};

const decided = (meaning: "approve" | "reject"): Event => ({
	...recorded(2, "2026-10-12T09:30:00.000Z"),
	actor: { tag: "Operator" },
	kind: "GateDecided",
	payload: {
		gate_id: g1,
		decided_by: { tag: "Operator" },
		decided_at: IsoTime.parse("2026-10-12T09:30:00.000Z"),
		payload_hash: payloadHash,
		meaning,
		reason: "looks right",
	},
});

const gatesOf = (events: Event[]) =>
	fold(events, GateProjection.reduce, GateProjection.init).gates;

describe("GateProjection", () => {
	it("records who requested a Gate, when, for which Task, and the payload's hash", () => {
		const gate = gatesOf([requested]).get(g1);
		expect(gate).toEqual({
			id: "G-1",
			kind: "Deploy",
			requester: { tag: "Agent", id: "A-bram" },
			requested_at: "2026-10-12T09:00:00.000Z",
			task_id: "T-3",
			payload,
			payload_hash:
				"644b4ff33f551679c2cafd567934dd65cb8ea3d3c6bae02b1d676fafc67892e5",
			lifetime_s: 3600,
		});
	});

	it("attaches the decision to its Gate", () => {
		const gate = gatesOf([requested, decided("reject")]).get(g1);
		expect(gate?.decision).toMatchObject({ meaning: "reject" });
	});

	it("gives the same state when the same Events are folded twice", () => {
		const events = [requested, decided("approve")];
		expect(gatesOf(events)).toEqual(gatesOf(events));
		// A reducer that mutated its input would have filled the shared init.
		expect(GateProjection.init.gates.size).toBe(0);
	});
});

describe("gateState", () => {
	const at = (iso: string) => new Date(iso);

	it("is Open until the lifetime ends, then Expired with no new Event", () => {
		const gate = gatesOf([requested]).get(g1);
		if (!gate) throw new Error("G-1 missing");
		expect(gateState(gate, at("2026-10-12T09:59:59.999Z"))).toBe("Open");
		expect(gateState(gate, at("2026-10-12T10:00:00.000Z"))).toBe("Expired");
	});

	it("is Approved or Rejected once decided, whatever the time", () => {
		const late = at("2026-12-31T00:00:00.000Z");
		const approved = gatesOf([requested, decided("approve")]).get(g1);
		const rejected = gatesOf([requested, decided("reject")]).get(g1);
		if (!approved || !rejected) throw new Error("G-1 missing");
		expect(gateState(approved, late)).toBe("Approved");
		expect(gateState(rejected, late)).toBe("Rejected");
	});
});
