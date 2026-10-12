import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEvent } from "./events.js";
import { AppendRefused } from "./guards.js";
import { AgentId } from "./ids.js";
import { type Ledger, openLedger } from "./ledger.js";

const odile = AgentId.parse("A-odile");

const paused = (reason: string): NewEvent => ({
	actor: { tag: "Operator" },
	kind: "AgentPaused",
	payload: { agent_id: odile, reason },
});

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

const openWriter = () => {
	ledger = openLedger({ home, writer: true });
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
