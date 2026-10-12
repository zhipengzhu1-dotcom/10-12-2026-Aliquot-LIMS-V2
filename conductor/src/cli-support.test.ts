import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	actorText,
	nextId,
	parseActor,
	parseOrUsage,
	parseTimeout,
	readAll,
	withLedger,
} from "./cli-support.js";
import { UsageError } from "./command.js";
import { TaskId } from "./ids.js";

describe("parseActor", () => {
	it("defaults to the Operator and accepts Operator or an Agent id", () => {
		expect(parseActor(undefined)).toEqual({ tag: "Operator" });
		expect(parseActor("Operator")).toEqual({ tag: "Operator" });
		expect(parseActor("A-rin")).toEqual({ tag: "Agent", id: "A-rin" });
	});

	it("refuses anything else as a usage error naming the flag", () => {
		expect(() => parseActor("rin", "--reviewer")).toThrow(
			new UsageError(
				'--reviewer must be Operator or an Agent id like A-odile, not "rin"',
			),
		);
	});
});

describe("actorText", () => {
	it("names the Operator or the Agent id", () => {
		expect(actorText({ tag: "Operator" })).toBe("Operator");
		expect(actorText(parseActor("A-pia"))).toBe("A-pia");
	});
});

describe("parseOrUsage", () => {
	it("returns the parsed value or throws a UsageError saying what was expected", () => {
		expect(parseOrUsage(TaskId, "T-3", "the Task id must look like T-1")).toBe(
			"T-3",
		);
		expect(() =>
			parseOrUsage(TaskId, "3", "the Task id must look like T-1"),
		).toThrow(new UsageError('the Task id must look like T-1, not "3"'));
	});
});

describe("nextId", () => {
	it("is the highest number plus one, ignoring ids of other shapes", () => {
		expect(nextId("G", [])).toBe("G-1");
		expect(nextId("T", ["T-2", "T-10", "T-3", "R-40", "T-x"])).toBe("T-11");
	});
});

describe("parseTimeout", () => {
	it("takes a positive whole number of ms", () => {
		expect(parseTimeout("60000")).toBe(60000);
		for (const bad of ["0", "-5", "1.5", "soon"]) {
			expect(() => parseTimeout(bad)).toThrow(UsageError);
		}
	});
});

describe("readAll", () => {
	it("reads a stream to the end as UTF-8", async () => {
		expect(await readAll(Readable.from([Buffer.from("Ré"), "sumé"]))).toBe(
			"Résumé",
		);
	});
});

describe("withLedger", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "aliquot-cli-support-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("closes the Ledger after a sync or async use, and after a throw", async () => {
		const lock = join(home, "ledger.sqlite.lock");
		expect(withLedger(home, true, () => existsSync(lock))).toBe(true);
		expect(existsSync(lock)).toBe(false);

		const pending = withLedger(home, true, async () => existsSync(lock));
		expect(await pending).toBe(true);
		expect(existsSync(lock)).toBe(false);

		expect(() =>
			withLedger(home, true, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(lock)).toBe(false);
	});
});
