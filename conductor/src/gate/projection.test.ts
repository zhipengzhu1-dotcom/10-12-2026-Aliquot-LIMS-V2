import { describe, expect, it } from "vitest";
import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { AgentId, GateId } from "../ids.js";
import { openMemoryLedger } from "../ledger.js";
import { gateState } from "./projection.js";

const g1 = GateId.parse("G-1");
const payload = { target: "receiving-screen", version: "1.2.0" };
const payloadHash = sha256Hex(canonicalJson(payload));

const requested: NewEvent = {
	actor: { tag: "Agent", id: AgentId.parse("A-bram") },
	kind: "GateRequested",
	payload: {
		gate_id: g1,
		kind: "Deploy",
		payload,
		payload_hash: payloadHash,
		lifetime_s: 3600,
	},
};

const decided = (meaning: "approve" | "reject"): NewEvent => ({
	actor: { tag: "Operator" },
	kind: "GateDecided",
	payload: {
		gate_id: g1,
		decided_by: { tag: "Operator" },
		payload_hash: payloadHash,
		meaning,
		reason: "looks right",
	},
});

/** G-1, requested at 09:00 and decided at 09:30 when `meaning` is given. */
const gate = (meaning?: "approve" | "reject") => {
	let now = new Date("2026-10-12T09:00:00.000Z");
	const ledger = openMemoryLedger({ clock: () => now });
	ledger.append(requested);
	if (meaning !== undefined) {
		now = new Date("2026-10-12T09:30:00.000Z");
		ledger.append(decided(meaning));
	}
	const g = ledger.projections.gates.gates.get(g1);
	if (g === undefined) throw new Error("G-1 missing");
	return g;
};

describe("GateProjection", () => {
	it("records who requested a Gate, when and at which seq, and the payload's hash", () => {
		expect(gate()).toEqual({
			id: "G-1",
			kind: "Deploy",
			requester: { tag: "Agent", id: "A-bram" },
			requested_at: "2026-10-12T09:00:00.000Z",
			requested_seq: 1,
			payload,
			payload_hash:
				"644b4ff33f551679c2cafd567934dd65cb8ea3d3c6bae02b1d676fafc67892e5",
			lifetime_s: 3600,
		});
	});

	it("attaches the decision, signed at its Event's time, to its Gate", () => {
		expect(gate("reject").decision).toEqual({
			gate_id: "G-1",
			decided_by: { tag: "Operator" },
			decided_at: "2026-10-12T09:30:00.000Z",
			payload_hash: payloadHash,
			meaning: "reject",
			reason: "looks right",
			seq: 2,
		});
	});
});

describe("gateState", () => {
	const at = (iso: string) => new Date(iso);

	it("is Open until the lifetime ends, then Expired with no new Event", () => {
		expect(gateState(gate(), at("2026-10-12T09:59:59.999Z"))).toBe("Open");
		expect(gateState(gate(), at("2026-10-12T10:00:00.000Z"))).toBe("Expired");
	});

	it("is Approved or Rejected once decided, whatever the time", () => {
		const late = at("2026-12-31T00:00:00.000Z");
		expect(gateState(gate("approve"), late)).toBe("Approved");
		expect(gateState(gate("reject"), late)).toBe("Rejected");
	});
});
