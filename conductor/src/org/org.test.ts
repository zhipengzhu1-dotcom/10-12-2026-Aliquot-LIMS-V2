import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Ledger, openLedger } from "../ledger.js";
import { orgState } from "./projection.js";
import { seedOrg } from "./seed.js";

let home: string;
let ledger: Ledger;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-org-"));
	ledger = openLedger({ home, writer: true });
});

afterEach(() => {
	ledger.close();
	rmSync(home, { recursive: true, force: true });
});

describe("org seed", () => {
	it("recruits the eight roster Agents on Probation, authored by the Operator", () => {
		const appended = seedOrg(ledger);

		const events = ledger.all();
		expect(appended).toHaveLength(8);
		expect(events.map((e) => e.kind)).toEqual(Array(8).fill("AgentRecruited"));
		expect(events.every((e) => e.actor.tag === "Operator")).toBe(true);

		const agents = [...orgState(events).agents.values()].map(
			(a) => a.definition,
		);
		expect(agents.map((d) => [d.id, d.name, d.role, d.supervisor_id])).toEqual([
			["A-odile", "Odile", "Director", undefined],
			["A-mabel", "Mabel", "Steward", undefined],
			["A-thorne", "Thorne", "Auditor", undefined],
			["A-pia", "Pia", "Supervisor", "A-odile"],
			["A-anselm", "Anselm", "Supervisor", "A-odile"],
			["A-rin", "Rin", "Specialist", "A-pia"],
			["A-ines", "Ines", "Specialist", "A-pia"],
			["A-bram", "Bram", "Specialist", "A-pia"],
		]);
		expect(agents.every((d) => d.trust_tier === "Probation")).toBe(true);
		expect(agents.every((d) => d.version === 1)).toBe(true);
		const thorne = agents.find((d) => d.id === "A-thorne");
		expect(thorne?.persona.voice).toBe(
			"Dry, precise, and unimpressed by speed",
		);
		expect(thorne?.charter.forbidden).toEqual(["Do lab work"]);
		expect(agents.find((d) => d.id === "A-bram")?.capacity).toBe(3);
		expect(agents.find((d) => d.id === "A-odile")?.capacity).toBe(5);
	});

	it("appends nothing when run a second time", () => {
		seedOrg(ledger);
		const again = seedOrg(ledger);

		expect(again).toEqual([]);
		expect(ledger.all()).toHaveLength(8);
	});
});
