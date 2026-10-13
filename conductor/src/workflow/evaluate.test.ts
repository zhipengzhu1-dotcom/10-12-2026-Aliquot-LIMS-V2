import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../hash.js";
import { ArtifactId } from "../ids.js";
import type { ArtifactType } from "../types/artifact.js";
import {
	dueDate,
	evaluateReceipt,
	evaluateSubmission,
	evaluateWorkOrder,
	RECEIVING_LOG_COLUMNS,
	WORK_ORDER_COLUMNS,
} from "./evaluate.js";
import type { StageArtifact } from "./stages.js";

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

const LOT = "LT-268123";
const PRODUCT_CODE = "TLB-1475";

const stageArtifact = (
	artifact_type: ArtifactType,
	filename: string,
	bytes: Buffer,
): StageArtifact => ({
	id: ArtifactId.parse(sha256Hex(bytes)),
	artifact_type,
	filename,
	bytes,
});

/** A database version holding `samples` rows (Lab Reference, Lot) and `lots` rows. */
const database = (
	samples: readonly (readonly [string, string])[],
	lots: readonly string[],
): Buffer => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-evaluate-test-"));
	try {
		const path = join(dir, "lims.sqlite");
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TABLE lots (lot TEXT PRIMARY KEY); CREATE TABLE samples (lab_reference TEXT PRIMARY KEY, lot TEXT NOT NULL)",
		);
		for (const lot of lots) db.prepare("INSERT INTO lots VALUES (?)").run(lot);
		for (const [ref, lot] of samples) {
			db.prepare("INSERT INTO samples VALUES (?, ?)").run(ref, lot);
		}
		db.close();
		return readFileSync(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const row = (ref: string, lot = LOT, productCode = PRODUCT_CODE) => [
	ref,
	"2026-01-06",
	"15:17",
	productCode,
	"Tallowby Milk Thistle 250 mg Capsules",
	"60 ct amber glass bottle",
	lot,
	"Tallowby Botanicals LLC",
	"",
	"1",
];

/** Stage 2's Run on the Fixture's record: two containers, LR-2026-0001 and 0002, by default. */
const receiptRun = ({
	rows = [row("LR-2026-0001"), row("LR-2026-0002")],
	columns = [...RECEIVING_LOG_COLUMNS],
	written = database(
		[
			["LR-2026-0001", LOT],
			["LR-2026-0002", LOT],
		],
		[LOT],
	),
	carried,
	readBack = true,
}: {
	rows?: string[][];
	columns?: string[];
	written?: Buffer;
	carried?: Buffer;
	readBack?: boolean;
} = {}) => ({
	inputs: [
		stageArtifact(
			"SubmissionRecord",
			"submission.json",
			Buffer.from(JSON.stringify(complete())),
		),
		...(carried ? [stageArtifact("LimsDatabase", "lims.sqlite", carried)] : []),
	],
	outputs: [
		stageArtifact(
			"ReceivingLogRow",
			"receiving_log_row.xlsx",
			Buffer.from("the xlsx bytes"),
		),
		stageArtifact("LimsDatabase", "lims.sqlite", written),
		...(readBack
			? [
					stageArtifact(
						"Other",
						"receipt.json",
						Buffer.from(
							JSON.stringify({
								schema: "receipt/1",
								sheet: "01-06",
								columns,
								rows,
							}),
						),
					),
				]
			: []),
	],
});

// The row count, 4 per row (LOT#, Product Code, samples row, new Lab
// Reference), and the one lots row.
const receiptChecks = (rows: number) => 1 + 4 * rows + 1;

describe("evaluateReceipt", () => {
	it("passes one row per container with the record's Lot and Product Code, each Lab Reference a new samples row of that Lot, and one lots row", () => {
		expect(
			evaluateReceipt(
				receiptRun({
					carried: database([["LR-2026-0000", "LT-250001"]], ["LT-250001"]),
				}),
			),
		).toEqual({ score: 1, passed: true, findings: [] });
	});

	it("fails a row whose Lot differs from the record's, naming the row", () => {
		const evaluation = evaluateReceipt(
			receiptRun({
				rows: [row("LR-2026-0001"), row("LR-2026-0002", "LT-999999")],
			}),
		);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo(
			(receiptChecks(2) - 1) / receiptChecks(2),
		);
		expect(evaluation.findings).toEqual([
			"row 2 (LR-2026-0002): LOT# LT-999999 is not the record's Lot LT-268123",
		]);
	});

	it("fails a row whose Product Code differs from the record's", () => {
		const evaluation = evaluateReceipt(
			receiptRun({
				rows: [row("LR-2026-0001", LOT, "TLB-0000"), row("LR-2026-0002")],
			}),
		);

		expect(evaluation.findings).toEqual([
			"row 1 (LR-2026-0001): Product Code TLB-0000 is not the record's TLB-1475",
		]);
	});

	it("fails when the rows do not number the record's containers", () => {
		const evaluation = evaluateReceipt(
			receiptRun({ rows: [row("LR-2026-0001")] }),
		);

		expect(evaluation.score).toBeCloseTo(
			(receiptChecks(1) - 1) / receiptChecks(1),
		);
		expect(evaluation.findings).toEqual([
			"1 Receiving Log rows for 2 containers",
		]);
	});

	it("fails a Lab Reference the carried database version already holds", () => {
		const evaluation = evaluateReceipt(
			receiptRun({ carried: database([["LR-2026-0001", LOT]], [LOT]) }),
		);

		expect(evaluation.findings).toEqual([
			"row 1 (LR-2026-0001): Lab Reference LR-2026-0001 is already in the carried database",
		]);
	});

	it("fails a row with no samples row of the record's Lot, and a Lot with no lots row", () => {
		const evaluation = evaluateReceipt(
			receiptRun({
				written: database(
					[
						["LR-2026-0001", LOT],
						["LR-2026-0002", "LT-999999"],
					],
					[],
				),
			}),
		);

		expect(evaluation.findings).toEqual([
			"row 2 (LR-2026-0002): the database has no samples row for LR-2026-0002 with Lot LT-268123",
			"the database has 0 lots rows for Lot LT-268123, not 1",
		]);
	});

	it("scores 0 when the sheet's columns are not the Receiving Log's", () => {
		const evaluation = evaluateReceipt(receiptRun({ columns: ["#", "LOT#"] }));

		expect(evaluation).toEqual({
			score: 0,
			passed: false,
			findings: [
				`the sheet's columns are #, LOT#, not the Receiving Log's ${RECEIVING_LOG_COLUMNS.join(", ")}`,
			],
		});
	});

	it("scores 0 when the Run wrote no read-back or a database it cannot open", () => {
		expect(evaluateReceipt(receiptRun({ readBack: false }))).toEqual({
			score: 0,
			passed: false,
			findings: ["the Run has no receipt.json read-back"],
		});
		const unreadable = evaluateReceipt(
			receiptRun({ written: Buffer.from("not a database") }),
		);
		expect(unreadable.score).toBe(0);
		expect(unreadable.findings).toEqual([
			expect.stringMatching(/^lims\.sqlite is not a toy LIMS database: /),
		]);
	});
});

describe("dueDate", () => {
	it.each([
		["Tuesday", "2026-01-06", "Rush1to2Days", "2026-01-08"],
		["Tuesday", "2026-01-06", "Rush3to4Days", "2026-01-12"],
		["Tuesday", "2026-01-06", "Regular", "2026-01-20"],
		["Monday", "2026-07-27", "Regular", "2026-08-10"],
		["Friday", "2026-01-09", "Rush1to2Days", "2026-01-13"],
		["Saturday", "2026-01-10", "Rush1to2Days", "2026-01-13"],
	] as const)(
		"counts business days after a %s, %s, for %s: %s",
		(_, received, tat, due) => {
			expect(dueDate(received, tat)).toBe(due);
		},
	);
});

const TEST = "Average capsule weight";
const WO = "WO-2026-0001";
const DUE = "2026-01-12";

/** A database version holding `samples` rows (Lab Reference, TAT class) and `work_orders` rows. */
const workOrderDatabase = (
	samples: readonly (readonly [string, string])[],
	workOrders: readonly (readonly [string, string, string, string])[] = [],
): Buffer => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-evaluate-test-"));
	try {
		const path = join(dir, "lims.sqlite");
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TABLE samples (lab_reference TEXT PRIMARY KEY, tat_class TEXT NOT NULL); CREATE TABLE work_orders (work_order TEXT, lab_reference TEXT, test TEXT, due_date TEXT)",
		);
		for (const sample of samples) {
			db.prepare("INSERT INTO samples VALUES (?, ?)").run(...sample);
		}
		for (const row of workOrders) {
			db.prepare("INSERT INTO work_orders VALUES (?, ?, ?, ?)").run(...row);
		}
		db.close();
		return readFileSync(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const SEED1_SAMPLES = [
	["LR-2026-0001", "Rush3to4Days"],
	["LR-2026-0002", "Rush3to4Days"],
] as const;

/** Stage 3's Run on seed 1's Receiving Log row: two Samples, Rush3to4Days, received Tuesday 2026-01-06. */
const workOrderRun = ({
	due = DUE,
	rows = [
		["LR-2026-0001", TEST],
		["LR-2026-0002", TEST],
	],
	columns = [...WORK_ORDER_COLUMNS],
	carried = workOrderDatabase(SEED1_SAMPLES),
	written = workOrderDatabase(
		SEED1_SAMPLES,
		rows.map(([ref, test]) => [WO, ref, test, due] as const),
	),
	readBack = true,
}: {
	due?: string;
	rows?: (readonly [string, string])[];
	columns?: string[];
	carried?: Buffer;
	written?: Buffer;
	readBack?: boolean;
} = {}) => ({
	inputs: [
		stageArtifact(
			"ReceivingLogRow",
			"receiving_log_row.xlsx",
			Buffer.from("the xlsx bytes"),
		),
		stageArtifact("LimsDatabase", "lims.sqlite", carried),
	],
	outputs: [
		stageArtifact("WorkOrder", "work_order.xlsx", Buffer.from("the xlsx")),
		stageArtifact("LimsDatabase", "lims.sqlite", written),
		...(readBack
			? [
					stageArtifact(
						"Other",
						"work_order.json",
						Buffer.from(
							JSON.stringify({
								schema: "work_order/1",
								receiving_log_row: [
									["LR-2026-0001", "2026-01-06"],
									["LR-2026-0002", "2026-01-06"],
								],
								header: {
									"Work Order": WO,
									Client: "Tallowby Botanicals LLC",
									Lot: LOT,
									"Product Code": PRODUCT_CODE,
									Received: "2026-01-06",
									"TAT Class": "Rush3to4Days",
									"Due Date": due,
								},
								columns,
								rows,
							}),
						),
					),
				]
			: []),
	],
});

// 2 per Sample (due date, a Test), 1 per Work Order row, the new number,
// and the database's agreement.
const workOrderChecks = (samples: number, rows: number) =>
	2 * samples + rows + 2;

describe("evaluateWorkOrder", () => {
	it("passes the due date 4 business days after receipt for Rush3to4Days, a Test for each Sample, and work_orders rows that agree", () => {
		expect(evaluateWorkOrder(workOrderRun())).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
	});

	it("fails a due date one day off, naming each Sample and the date it should be", () => {
		const evaluation = evaluateWorkOrder(workOrderRun({ due: "2026-01-13" }));

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo(
			(workOrderChecks(2, 2) - 2) / workOrderChecks(2, 2),
		);
		expect(evaluation.findings).toEqual(
			["LR-2026-0001", "LR-2026-0002"].map(
				(ref) =>
					`${ref}: due date 2026-01-13 is not 2026-01-12, 4 business days after 2026-01-06 for TAT class Rush3to4Days`,
			),
		);
	});

	it("fails a Sample on the Receiving Log row that has no Test", () => {
		const evaluation = evaluateWorkOrder(
			workOrderRun({ rows: [["LR-2026-0001", TEST]] }),
		);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.findings).toEqual([
			"LR-2026-0002: the Work Order has no Test for it",
		]);
	});

	it("fails a Work Order row for a Sample not on the Receiving Log row", () => {
		const evaluation = evaluateWorkOrder(
			workOrderRun({
				rows: [
					["LR-2026-0001", TEST],
					["LR-2026-0002", TEST],
					["LR-2026-0009", TEST],
				],
				written: workOrderDatabase(
					[...SEED1_SAMPLES, ["LR-2026-0009", "Regular"]],
					["LR-2026-0001", "LR-2026-0002", "LR-2026-0009"].map(
						(ref) => [WO, ref, TEST, DUE] as const,
					),
				),
			}),
		);

		expect(evaluation.findings).toEqual([
			"Work Order row 3: LR-2026-0009 is not on the Receiving Log row",
		]);
	});

	it("fails a Sample the carried database has no samples row for", () => {
		const evaluation = evaluateWorkOrder(
			workOrderRun({
				carried: workOrderDatabase([["LR-2026-0001", "Rush3to4Days"]]),
			}),
		);

		expect(evaluation.findings).toEqual([
			"LR-2026-0002: the carried database has no samples row for it with a TAT class",
		]);
	});

	it("fails a Work Order number the carried database already holds", () => {
		const evaluation = evaluateWorkOrder(
			workOrderRun({
				carried: workOrderDatabase(SEED1_SAMPLES, [
					[WO, "LR-2026-0000", TEST, "2026-01-02"],
				]),
			}),
		);

		expect(evaluation.findings).toEqual([
			"Work Order WO-2026-0001 is already in the carried database",
		]);
	});

	it("fails work_orders rows that disagree with the document's Tests or due date", () => {
		const evaluation = evaluateWorkOrder(
			workOrderRun({
				written: workOrderDatabase(SEED1_SAMPLES, [
					[WO, "LR-2026-0001", TEST, DUE],
					[WO, "LR-2026-0002", TEST, "2026-01-20"],
				]),
			}),
		);

		expect(evaluation.findings).toEqual([
			`the work_orders rows for WO-2026-0001 (LR-2026-0001 ${TEST} ${DUE}; LR-2026-0002 ${TEST} 2026-01-20) do not agree with the Work Order (LR-2026-0001 ${TEST} ${DUE}; LR-2026-0002 ${TEST} ${DUE})`,
		]);
	});

	it("scores 0 when the Run wrote no read-back or columns other than the Work Order's", () => {
		expect(evaluateWorkOrder(workOrderRun({ readBack: false }))).toEqual({
			score: 0,
			passed: false,
			findings: ["the Run has no work_order.json read-back"],
		});
		expect(
			evaluateWorkOrder(workOrderRun({ columns: ["Lab Reference"] })),
		).toEqual({
			score: 0,
			passed: false,
			findings: [
				"the Work Order's columns are Lab Reference, not Lab Reference, Test",
			],
		});
	});
});
