import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { sha256Hex } from "../hash.js";
import { AgentId, Sha256 } from "../ids.js";
import { TEST_OPERATOR } from "../test-support/operator.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { nameReceivingLog, readReceivingLog } from "./lifecycle.js";

let s: Scenario;
let dir: string;
beforeEach(() => {
	s = scenario("2026-10-14T09:00:00.000Z");
	dir = mkdtempSync(join(tmpdir(), "aliquot-shadow-"));
});
afterEach(() => {
	s.close();
	rmSync(dir, { recursive: true, force: true });
});

const workbook = (name: string, text: string) => {
	const path = join(dir, name);
	writeFileSync(path, text);
	return path;
};

describe("naming the lab's Receiving Log", () => {
	it("records the path and the workbook's sha256, never its contents", () => {
		const path = workbook("receiving-log.xlsx", "a cell the lab typed");

		const { receiving_log, seq } = nameReceivingLog(s.ledger, {
			actor: TEST_OPERATOR,
			path,
		});

		const event = s.events().find((e) => e.seq === seq);
		expect(event?.kind).toBe("ReceivingLogNamed");
		expect(event?.actor).toEqual(TEST_OPERATOR);
		expect(event?.payload).toEqual({
			path,
			sha256: sha256Hex("a cell the lab typed"),
		});
		expect(JSON.stringify(s.events())).not.toContain("a cell the lab typed");
		expect(receiving_log).toMatchObject({ path, seq });
	});

	it("supersedes an earlier naming, which the new one names as its cause", () => {
		const first = nameReceivingLog(s.ledger, {
			actor: TEST_OPERATOR,
			path: workbook("first.xlsx", "one"),
		});
		const second = nameReceivingLog(s.ledger, {
			actor: TEST_OPERATOR,
			path: workbook("second.xlsx", "two"),
		});

		expect(s.events().at(-1)?.causation_id).toBe(first.seq);
		expect(s.ledger.projections.shadow.receiving_log?.path).toBe(
			join(dir, "second.xlsx"),
		);
		expect(second.receiving_log.seq).toBe(second.seq);
	});

	it("refuses a relative path before reading anything", () => {
		expect(() =>
			nameReceivingLog(s.ledger, {
				actor: TEST_OPERATOR,
				path: "lab/receiving-log.xlsx",
			}),
		).toThrow(
			new AppendRefused(
				"ReceivingLogNamed refused: the Receiving Log's path lab/receiving-log.xlsx is not absolute",
			),
		);
	});

	it("is refused for an Agent and for the unnamed Operator", () => {
		const naming = {
			kind: "ReceivingLogNamed",
			payload: {
				path: "/lab/receiving-log.xlsx",
				sha256: Sha256.parse("c".repeat(64)),
			},
		} as const;

		expect(() =>
			s.appendNonTask({
				actor: { tag: "Agent", id: AgentId.parse("A-bram") },
				...naming,
			}),
		).toThrow(
			"ReceivingLogNamed refused: only a named person acting as the Operator names the lab's Receiving Log, not A-bram",
		);
		expect(() =>
			s.appendNonTask({ actor: { tag: "Operator" }, ...naming }),
		).toThrow(
			"ReceivingLogNamed refused: only a named person acting as the Operator names the lab's Receiving Log, not Operator",
		);
	});
});

describe("reading the lab's Receiving Log", () => {
	it("stores a fresh read as the person's ReceivingLog, caused by the naming", () => {
		const path = workbook("receiving-log.xlsx", "rows of the day");
		const named = nameReceivingLog(s.ledger, { actor: TEST_OPERATOR, path });
		writeFileSync(path, "rows of the day, and one more");

		const read = readReceivingLog(s.ledger, dir, TEST_OPERATOR);

		expect(read?.artifact).toMatchObject({
			id: sha256Hex("rows of the day, and one more"),
			artifact_type: "ReceivingLog",
			produced_by: TEST_OPERATOR,
			lineage: [],
			filename: "receiving-log.xlsx",
		});
		expect(s.events().at(-1)?.causation_id).toBe(named.seq);
	});

	it("reads nothing when the home names no Receiving Log", () => {
		expect(readReceivingLog(s.ledger, dir, TEST_OPERATOR)).toBeUndefined();
	});
});
