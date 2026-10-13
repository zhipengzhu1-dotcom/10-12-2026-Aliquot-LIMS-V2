import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateSubmission } from "./evaluate.js";

/** The committed Fixture's expected record: a complete, valid submission. */
const complete = (): Record<string, Record<string, string> | string> =>
	JSON.parse(
		readFileSync(
			new URL(
				"../../../fixtures/submission-form-seed1.expected.json",
				import.meta.url,
			),
			"utf8",
		),
	);

// 13 party fields + 7 Sample fields + 3 receipt fields + the TAT code check.
const CHECKS = 24;

describe("evaluateSubmission", () => {
	it("passes the Fixture's expected record with score 1 and no findings", () => {
		expect(evaluateSubmission(complete())).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
	});

	it("fails a record whose Sample has no Lot, naming the field", () => {
		const record = complete();
		delete (record.sample as Record<string, string>).lot;

		const evaluation = evaluateSubmission(record);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo((CHECKS - 1) / CHECKS);
		expect(evaluation.findings).toEqual(["Sample: Lot is missing"]);
	});

	it("counts a blank required field as missing", () => {
		const record = complete();
		(record.bill_to as Record<string, string>).city = "   ";

		const evaluation = evaluateSubmission(record);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.findings).toEqual(["Bill To: City is missing"]);
	});

	it("does not require optional fields such as the Bill To Phone", () => {
		const record = complete();
		delete (record.bill_to as Record<string, string>).phone;
		delete (record.report_to as Record<string, string>).address;

		expect(evaluateSubmission(record).passed).toBe(true);
	});

	it("fails a TAT code outside 1, 2 and 3", () => {
		const record = complete();
		(record.sample as Record<string, string>).tat_code = "4";

		const evaluation = evaluateSubmission(record);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo((CHECKS - 1) / CHECKS);
		expect(evaluation.findings).toEqual([
			'Sample: TAT Code "4" is not a valid TAT code (1, 2 or 3)',
		]);
	});

	it("fails every check for a record that is not an object", () => {
		const evaluation = evaluateSubmission("not a record");

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBe(0);
		expect(evaluation.findings).toHaveLength(CHECKS);
	});

	it("fails the checks of a party section that is missing", () => {
		const record = complete();
		delete record.report_to;

		const evaluation = evaluateSubmission(record);

		expect(evaluation.score).toBeCloseTo((CHECKS - 3) / CHECKS);
		expect(evaluation.findings).toEqual([
			"Report To: Company is missing",
			"Report To: Contact is missing",
			"Report To: Email is missing",
		]);
	});
});
