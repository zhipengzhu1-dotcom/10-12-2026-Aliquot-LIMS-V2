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
	evaluateReport,
	evaluateResults,
	evaluateSubmission,
	evaluateVerification,
	evaluateWorkOrder,
	MEAN_AVERAGE_WEIGHT,
	NITROSAMINE_IMPURITIES,
	NOTEBOOK_LABEL,
	pdfText,
	RECEIVING_LOG_COLUMNS,
	REPORT_METADATA,
	REPORT_RESULT_COLUMNS,
	RESULT_WORKSHEET_COLUMNS,
	WORK_ORDER_COLUMNS,
} from "./evaluate.js";
import type { StageArtifact } from "./stages.js";

type Fields = Record<string, string>;
type SubmissionRecord = Record<string, Fields | string> & { samples: Fields[] };

/** The committed Fixture's expected record: a complete, valid submission. */
const complete = (): SubmissionRecord =>
	JSON.parse(
		readFileSync(
			new URL(
				"../../../fixtures/submission-form-seed1.expected.json",
				import.meta.url,
			),
			"utf8",
		),
	);

const firstSample = (record: SubmissionRecord): Fields => {
	const [sample] = record.samples;
	if (sample === undefined) throw new Error("the Fixture lists no Sample");
	return sample;
};

// 13 party fields + 3 receipt fields + a Sample listed + 7 fields and the
// TAT code check of its one Sample.
const CHECKS = 25;

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
		delete firstSample(record).lot;

		const evaluation = evaluateSubmission(record);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo((CHECKS - 1) / CHECKS);
		expect(evaluation.findings).toEqual(["Sample 1: Lot is missing"]);
	});

	it("checks every Sample of the record, naming the Sample by its line", () => {
		const record = complete();
		const first = firstSample(record);
		record.samples.push({ ...first, no: "2", product_code: "" });

		const evaluation = evaluateSubmission(record);

		expect(evaluation.score).toBeCloseTo((CHECKS + 7) / (CHECKS + 8));
		expect(evaluation.findings).toEqual(["Sample 2: Product Code is missing"]);
	});

	it("fails a record that lists no Sample", () => {
		const record = complete();
		record.samples = [];

		const evaluation = evaluateSubmission(record);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.findings).toEqual([
			"Samples: the record lists no Sample",
		]);
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
		firstSample(record).tat_code = "4";

		const evaluation = evaluateSubmission(record);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo((CHECKS - 1) / CHECKS);
		expect(evaluation.findings).toEqual([
			'Sample 1: TAT Code "4" is not a valid TAT code (1, 2 or 3)',
		]);
	});

	it("fails every check for a record that is not an object", () => {
		const evaluation = evaluateSubmission("not a record");

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBe(0);
		expect(evaluation.findings).toHaveLength(13 + 3 + 1);
		expect(evaluation.findings).toContain(
			"Samples: the record lists no Sample",
		);
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
	record = complete(),
}: {
	rows?: string[][];
	columns?: string[];
	written?: Buffer;
	carried?: Buffer;
	readBack?: boolean;
	record?: SubmissionRecord;
} = {}) => ({
	inputs: [
		stageArtifact(
			"SubmissionRecord",
			"submission.json",
			Buffer.from(JSON.stringify(record)),
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

	it("checks each row against its own Sample when the record lists several, and each Lot's lots row", () => {
		const record = complete();
		record.samples.push({
			...firstSample(record),
			no: "2",
			lot: "LT-269999",
			no_of_containers: "1",
		});
		const written = database(
			[
				["LR-2026-0001", LOT],
				["LR-2026-0002", LOT],
				["LR-2026-0003", "LT-269999"],
			],
			[LOT, "LT-269999"],
		);
		const rows = [
			row("LR-2026-0001"),
			row("LR-2026-0002"),
			row("LR-2026-0003", "LT-269999"),
		];

		expect(evaluateReceipt(receiptRun({ record, rows, written }))).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
		const swapped = evaluateReceipt(
			receiptRun({
				record,
				rows: [
					row("LR-2026-0001"),
					row("LR-2026-0002", "LT-269999"),
					row("LR-2026-0003"),
				],
				written: database(
					[
						["LR-2026-0001", LOT],
						["LR-2026-0002", "LT-269999"],
						["LR-2026-0003", LOT],
					],
					[LOT],
				),
			}),
		);
		expect(swapped.findings).toEqual([
			`row 2 (LR-2026-0002): LOT# LT-269999 is not the record's Lot ${LOT}`,
			`row 2 (LR-2026-0002): the database has no samples row for LR-2026-0002 with Lot ${LOT}`,
			"row 3 (LR-2026-0003): LOT# LT-268123 is not the record's Lot LT-269999",
			"row 3 (LR-2026-0003): the database has no samples row for LR-2026-0003 with Lot LT-269999",
			"the database has 0 lots rows for Lot LT-269999, not 1",
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

type Cells = Record<string, string>;

/** The seed 1 record's values in the lab's columns, as `log_receipt` writes them. */
const yearRow = (n: number, ref: string, lot = LOT): Cells => ({
	[`A${n}`]: String(n - 3),
	[`B${n}`]: "2026-01-06",
	[`C${n}`]: "15:17",
	[`D${n}`]: PRODUCT_CODE,
	[`E${n}`]: "Tallowby Milk Thistle 250 mg Capsules",
	[`F${n}`]: "FP",
	[`G${n}`]: lot,
	[`H${n}`]: "Tallowby Botanicals LLC",
	[`J${n}`]: "1",
	[`K${n}`]: "Senna Halloway",
	[`L${n}`]: "LG",
	[`M${n}`]: ref,
});
const dayRow = (n: number, ref: string): Cells => ({
	[`A${n}`]: String(n - 2),
	[`B${n}`]: "2026-01-06",
	[`C${n}`]: "Tallowby Milk Thistle 250 mg Capsules",
	[`D${n}`]: "FP",
	[`E${n}`]: LOT,
	[`F${n}`]: "Tallowby Botanicals LLC",
	[`H${n}`]: "1",
	[`I${n}`]: "LG",
	[`J${n}`]: ref,
});
const LABS_YEAR: Cells = { A3: "#", G3: "LOT#", A4: "1", G4: "P147463" };

/** `shadow.json` for seed 1's two containers: the year's rows 5 and 6, a new `January 6`. */
const held = (
	overrides: {
		year?: Cells;
		day?: Cells | null;
		labs?: { name: string; before: Cells | null; after: Cells | null }[];
	} = {},
) => ({
	schema: "shadow/1",
	year: { sheet: "2026", rows: [5, 6] },
	day: { sheet: "January 6", rows: [3, 4], made: true },
	sheets: [
		{
			name: "2026",
			before: LABS_YEAR,
			after: overrides.year ?? {
				...LABS_YEAR,
				...yearRow(5, "LR-2026-0001"),
				...yearRow(6, "LR-2026-0002"),
			},
		},
		...(overrides.labs ?? []),
		{
			name: "January 6",
			before: null,
			after: overrides.day ?? {
				...dayRow(3, "LR-2026-0001"),
				...dayRow(4, "LR-2026-0002"),
			},
		},
	],
});

const shadowRun = (readBack: object | undefined) => {
	const run = receiptRun();
	return {
		inputs: [
			...run.inputs,
			stageArtifact(
				"ReceivingLog",
				"receiving-log.xlsx",
				Buffer.from("the lab's xlsx"),
			),
		],
		outputs: [
			...run.outputs,
			...(readBack
				? [
						stageArtifact(
							"ShadowReceivingLog",
							"receiving_log_shadow.xlsx",
							Buffer.from("the Shadow's xlsx"),
						),
						stageArtifact(
							"Other",
							"shadow.json",
							Buffer.from(JSON.stringify(readBack)),
						),
					]
				: []),
		],
	};
};

describe("evaluateReceipt with the lab's Receiving Log", () => {
	it("passes a Shadow with one row per container in the lab's columns of the year's and the day's sheets, and every lab cell kept", () => {
		expect(evaluateReceipt(shadowRun(held()))).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
	});

	it("fails a new row whose Lot is not the record's, naming the sheet, row and column", () => {
		const evaluation = evaluateReceipt(
			shadowRun(
				held({
					year: {
						...LABS_YEAR,
						...yearRow(5, "LR-2026-0001"),
						...yearRow(6, "LR-2026-0002", "LT-999999"),
					},
				}),
			),
		);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.findings).toEqual([
			`the Shadow's sheet 2026 row 6: LOT# (G) is "LT-999999", not "${LOT}"`,
		]);
	});

	it("fails a Shadow that changed a cell of the lab's or wrote outside its new rows", () => {
		const evaluation = evaluateReceipt(
			shadowRun(
				held({
					year: {
						...LABS_YEAR,
						G4: "P147464",
						P4: "a note",
						...yearRow(5, "LR-2026-0001"),
						...yearRow(6, "LR-2026-0002"),
					},
				}),
			),
		);

		expect(evaluation.findings).toEqual([
			'the Shadow changed the lab\'s cells in sheet 2026: G4 "P147463" to "P147464"',
			"the Shadow wrote sheet 2026 outside its new rows: P4",
		]);
	});

	it("fails a Shadow that lost a sheet of the lab's", () => {
		const evaluation = evaluateReceipt(
			shadowRun(
				held({ labs: [{ name: "July 23", before: { A1: "#" }, after: null }] }),
			),
		);

		expect(evaluation.findings).toEqual([
			"the Shadow lost the lab's sheet July 23",
		]);
	});

	it("scores 0 when the Run read the lab's Receiving Log and wrote no Shadow", () => {
		expect(evaluateReceipt(shadowRun(undefined))).toEqual({
			score: 0,
			passed: false,
			findings: [
				"the Run read the lab's Receiving Log and wrote no ShadowReceivingLog",
			],
		});
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

/**
 * A database version holding `samples` rows (Lab Reference, TAT class, and
 * Lot, seed 1's when not given) and `work_orders` rows.
 */
const workOrderDatabase = (
	samples: readonly (readonly [string, string, string?])[],
	workOrders: readonly (readonly [string, string, string, string])[] = [],
): Buffer => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-evaluate-test-"));
	try {
		const path = join(dir, "lims.sqlite");
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TABLE samples (lab_reference TEXT PRIMARY KEY, tat_class TEXT NOT NULL, lot TEXT NOT NULL); CREATE TABLE work_orders (work_order TEXT, lab_reference TEXT, test TEXT, due_date TEXT)",
		);
		for (const [ref, tat, lot = LOT] of samples) {
			db.prepare("INSERT INTO samples VALUES (?, ?, ?)").run(ref, tat, lot);
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

type WorkOrderRow = readonly [
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
];

/** A Work Order row for a Sample of seed 1's Lot, Rush3to4Days. */
const planned = (
	ref: string,
	due = DUE,
	lot = LOT,
	tat = "Rush3to4Days",
): WorkOrderRow => [ref, TEST, lot, PRODUCT_CODE, tat, due, "", ""];

/** Stage 3's Run on seed 1's Receiving Log row: two Samples, Rush3to4Days, received Tuesday 2026-01-06. */
const workOrderRun = ({
	due = DUE,
	rows = [planned("LR-2026-0001", due), planned("LR-2026-0002", due)],
	receivingLogRow = ["LR-2026-0001", "LR-2026-0002"],
	columns = [...WORK_ORDER_COLUMNS],
	carried = workOrderDatabase(SEED1_SAMPLES),
	written = workOrderDatabase(
		SEED1_SAMPLES,
		rows.map(([ref, test, , , , rowDue]) => [WO, ref, test, rowDue] as const),
	),
	readBack = true,
}: {
	due?: string;
	rows?: WorkOrderRow[];
	receivingLogRow?: string[];
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
								schema: "work_order/2",
								receiving_log_row: receivingLogRow.map((ref) => [
									ref,
									"2026-01-06",
								]),
								header: {
									"Work Order": WO,
									Client: "Tallowby Botanicals LLC",
									Received: "2026-01-06",
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

// 2 per Sample (due date, a Test), 2 per Work Order row (on the Receiving
// Log row, its Lot), the Work Order's due date, the new number, and the
// database's agreement.
const workOrderChecks = (samples: number, rows: number) =>
	2 * samples + 2 * rows + 3;

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
			workOrderRun({ rows: [planned("LR-2026-0001")] }),
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
					planned("LR-2026-0001"),
					planned("LR-2026-0002"),
					planned("LR-2026-0009"),
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
			"Work Order row 3: the carried database has no samples row for LR-2026-0009",
		]);
	});

	it("passes a Work Order that plans each of several Samples with its own Lot and due date, due with the last", () => {
		const carried = workOrderDatabase([
			...SEED1_SAMPLES,
			["LR-2026-0003", "Regular", "LT-269999"],
		]);
		const rows = [
			planned("LR-2026-0001"),
			planned("LR-2026-0002"),
			planned("LR-2026-0003", "2026-01-20", "LT-269999", "Regular"),
		];
		const run = (due: string, rowsOf = rows) =>
			evaluateWorkOrder(
				workOrderRun({
					due,
					rows: rowsOf,
					receivingLogRow: ["LR-2026-0001", "LR-2026-0002", "LR-2026-0003"],
					carried,
				}),
			);

		expect(run("2026-01-20")).toEqual({ score: 1, passed: true, findings: [] });
		expect(run(DUE).findings).toEqual([
			`the Work Order's due date ${DUE} is not its last Sample's, 2026-01-20`,
		]);
		expect(
			run("2026-01-20", [
				planned("LR-2026-0001"),
				planned("LR-2026-0002"),
				planned("LR-2026-0003", "2026-01-20", LOT, "Regular"),
			]).findings,
		).toEqual([
			`Work Order row 3: Lot ${LOT} is not LR-2026-0003's Lot LT-269999`,
		]);
		expect(
			run("2026-01-20", [
				planned("LR-2026-0001"),
				planned("LR-2026-0002"),
				planned("LR-2026-0003", DUE, "LT-269999", "Regular"),
			]).findings,
		).toEqual([
			"LR-2026-0003: due date 2026-01-12 is not 2026-01-20, 10 business days after 2026-01-06 for TAT class Regular",
			"the Work Order's due date 2026-01-20 is not its last Sample's, 2026-01-12",
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
			"Work Order row 2: the carried database has no samples row for LR-2026-0002",
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
				"the Work Order's columns are Lab Reference, not Lab Reference, Test, Lot, Product Code, TAT Class, Due Date, Analyte, Limit",
			],
		});
	});

	it("passes one work_orders row for a Nitrosamine impurities Test of two analytes, and fails a row naming no analyte", () => {
		const nitrosamines = (analyte: string, limit: string): WorkOrderRow => [
			"LR-2026-0002",
			NITROSAMINE_IMPURITIES,
			LOT,
			PRODUCT_CODE,
			"Rush3to4Days",
			DUE,
			analyte,
			limit,
		];
		const run = (rows: WorkOrderRow[]) =>
			evaluateWorkOrder(
				workOrderRun({
					rows,
					written: workOrderDatabase(SEED1_SAMPLES, [
						[WO, "LR-2026-0001", TEST, DUE],
						[WO, "LR-2026-0002", NITROSAMINE_IMPURITIES, DUE],
					]),
				}),
			);

		expect(
			run([
				planned("LR-2026-0001"),
				nitrosamines("NDMA", "96 ng/day"),
				nitrosamines("NDEA", "0.03 ppm"),
			]),
		).toEqual({ score: 1, passed: true, findings: [] });
		expect(
			run([planned("LR-2026-0001"), nitrosamines("", "")]).findings,
		).toEqual([
			`Work Order row 2: LR-2026-0002's ${NITROSAMINE_IMPURITIES} names no analyte`,
		]);
	});
});

type Cell = string | number | null;

const NAME = "Tallowby Milk Thistle 250 mg Capsules";
const SEED1_WEIGHINGS = [
	{ container: 1, weight_of_20_g: 7.0886, weight_taken_g: 0.3541 },
	{ container: 2, weight_of_20_g: 7.2103, weight_taken_g: 0.3422 },
];
const SEED1_MEAN = (7.0886 / 20 + 7.2103 / 20) / 2;

/** The sheet `compute_results` writes for seed 1, as its read-back holds it. */
const seed1Sheet = (): Cell[][] => [
	["Result Worksheet: Average Capsule Weight", ...Array(7).fill(null)],
	["Work Order", WO, ...Array(6).fill(null)],
	["Test", TEST, ...Array(6).fill(null)],
	Array(8).fill(null),
	[...RESULT_WORKSHEET_COLUMNS],
	[1, PRODUCT_CODE, NAME, "Complete", LOT, 7.0886, 0.3541, "=F6/20"],
	[2, PRODUCT_CODE, NAME, "Complete", LOT, 7.2103, 0.3422, "=F7/20"],
	[...Array(6).fill(null), "Mean", "=AVERAGE(H6:H7)"],
];

/** A database version holding `samples` (Lab Reference, container), `work_orders` and `results` rows. */
const resultsDatabase = (
	results: readonly (readonly [string, string, number])[] = [],
): Buffer => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-evaluate-test-"));
	try {
		const path = join(dir, "lims.sqlite");
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TABLE samples (lab_reference TEXT PRIMARY KEY, container INTEGER); CREATE TABLE work_orders (work_order TEXT, lab_reference TEXT, test TEXT); CREATE TABLE results (lab_reference TEXT, test TEXT, value REAL)",
		);
		["LR-2026-0001", "LR-2026-0002"].forEach((ref, i) => {
			db.prepare("INSERT INTO samples VALUES (?, ?)").run(ref, i + 1);
			db.prepare("INSERT INTO work_orders VALUES (?, ?, ?)").run(WO, ref, TEST);
		});
		for (const row of results) {
			db.prepare("INSERT INTO results VALUES (?, ?, ?)").run(...row);
		}
		db.close();
		return readFileSync(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const SEED1_RESULTS = [
	["LR-2026-0001", TEST, 7.0886 / 20],
	["LR-2026-0001", MEAN_AVERAGE_WEIGHT, SEED1_MEAN],
	["LR-2026-0002", TEST, 7.2103 / 20],
	["LR-2026-0002", MEAN_AVERAGE_WEIGHT, SEED1_MEAN],
] as const;

/** Stage 4's Run on seed 1's Work Order and weighings. */
const resultsRun = ({
	sheet = seed1Sheet(),
	weighings = SEED1_WEIGHINGS,
	written = resultsDatabase(SEED1_RESULTS),
	readBack = true,
}: {
	sheet?: Cell[][];
	weighings?: readonly {
		container: number;
		weight_of_20_g: number;
		weight_taken_g: number;
		notebook_reference?: string;
	}[];
	written?: Buffer;
	readBack?: boolean;
} = {}) => ({
	inputs: [
		stageArtifact("WorkOrder", "work_order.xlsx", Buffer.from("the xlsx")),
		stageArtifact(
			"Other",
			"submission-form-seed1.weighings.json",
			Buffer.from(JSON.stringify(weighings)),
		),
		stageArtifact("LimsDatabase", "lims.sqlite", resultsDatabase()),
	],
	outputs: [
		stageArtifact(
			"ResultWorksheet",
			"result_worksheet.xlsx",
			Buffer.from("the xlsx"),
		),
		stageArtifact("LimsDatabase", "lims.sqlite", written),
		...(readBack
			? [
					stageArtifact(
						"Other",
						"result_worksheet.json",
						Buffer.from(
							JSON.stringify({ schema: "result_worksheet/1", sheet }),
						),
					),
				]
			: []),
	],
});

// 3 per row (formula, two weights), 1 per weighing, the Mean formula, the
// notebook reference, the Work Order's rows, and 2 per Sample (its average,
// the mean).
const resultsChecks = (rows: number, weighings: number, samples: number) =>
	3 * rows + weighings + 3 + 2 * samples;

/** Seed 1's weighings as `parse_results_message` writes them, each naming NB-07 p.31. */
const NOTED = SEED1_WEIGHINGS.map((w) => ({
	...w,
	notebook_reference: "NB-07 p.31",
}));

/** Seed 1's sheet with the notebook reference in row 4 of the header. */
const notedSheet = (): Cell[][] => {
	const sheet = seed1Sheet();
	sheet[3] = [NOTEBOOK_LABEL, "NB-07 p.31", ...Array(6).fill(null)];
	return sheet;
};

describe("evaluateResults", () => {
	it("passes seed 1's worksheet: each average and the mean by formula, the weighings as values, and results rows that agree", () => {
		expect(evaluateResults(resultsRun())).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
	});

	it("fails a typed value in place of an average's formula or the mean's, naming the row", () => {
		const sheet = seed1Sheet();
		(sheet[5] as Cell[])[7] = 0.35443;
		(sheet[7] as Cell[])[7] = 0.3574725;

		const evaluation = evaluateResults(resultsRun({ sheet }));

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo(
			(resultsChecks(2, 2, 2) - 2) / resultsChecks(2, 2, 2),
		);
		expect(evaluation.findings).toEqual([
			"row 6 (container 1): Average Weight (g) is 0.35443, not the formula =F6/20",
			"the Mean row's Average Weight (g) is 0.3574725, not the formula =AVERAGE(H6:H7)",
		]);
	});

	it("fails a weight that is not its container's weighing, and a weighing with no row", () => {
		const sheet = seed1Sheet();
		(sheet[6] as Cell[])[5] = 7.21;

		const evaluation = evaluateResults(
			resultsRun({
				sheet,
				weighings: [
					...SEED1_WEIGHINGS,
					{ container: 3, weight_of_20_g: 7.1, weight_taken_g: 0.35 },
				],
			}),
		);

		expect(evaluation.findings).toEqual([
			"row 7 (container 2): Weight of 20 Capsules (g) 7.21 is not the weighing's 7.2103",
			"container 3: the worksheet has no row for its weighing",
		]);
	});

	it("fails a results row that disagrees with the worksheet by more than 0.0001 g, and passes one within it", () => {
		const off = (by: number) =>
			resultsDatabase(
				SEED1_RESULTS.map(([ref, test, value]) =>
					ref === "LR-2026-0001" && test === TEST
						? ([ref, test, value + by] as const)
						: ([ref, test, value] as const),
				),
			);

		expect(evaluateResults(resultsRun({ written: off(0.00009) })).passed).toBe(
			true,
		);
		expect(
			evaluateResults(resultsRun({ written: off(0.001) })).findings,
		).toEqual([
			`LR-2026-0001: results holds ${7.0886 / 20 + 0.001} for ${TEST}, not ${7.0886 / 20}, container 1's Weight of 20 Capsules (g) / 20, within 0.0001 g`,
		]);
	});

	it("fails a Sample with no results rows, and a mean that is not the mean of the averages", () => {
		const evaluation = evaluateResults(
			resultsRun({
				written: resultsDatabase([
					["LR-2026-0001", TEST, 7.0886 / 20],
					["LR-2026-0001", MEAN_AVERAGE_WEIGHT, 7.0886 / 20],
				]),
			}),
		);

		expect(evaluation.findings).toEqual([
			`LR-2026-0001: results holds ${7.0886 / 20} for ${MEAN_AVERAGE_WEIGHT}, not ${SEED1_MEAN}, the mean of the worksheet's averages, within 0.0001 g`,
			`LR-2026-0002: results holds no row for ${TEST}, not ${7.2103 / 20}, container 2's Weight of 20 Capsules (g) / 20, within 0.0001 g`,
			`LR-2026-0002: results holds no row for ${MEAN_AVERAGE_WEIGHT}, not ${SEED1_MEAN}, the mean of the worksheet's averages, within 0.0001 g`,
		]);
	});

	it("passes a header that holds the weighings' notebook reference, and fails one that does not", () => {
		expect(
			evaluateResults(resultsRun({ weighings: NOTED, sheet: notedSheet() })),
		).toEqual({ score: 1, passed: true, findings: [] });

		const missing = evaluateResults(resultsRun({ weighings: NOTED }));
		expect(missing.passed).toBe(false);
		expect(missing.findings).toEqual([
			"the header's Notebook Reference is empty, not the weighings' NB-07 p.31",
		]);
		expect(
			evaluateResults(resultsRun({ sheet: notedSheet() })).findings,
		).toEqual([
			"the header's Notebook Reference is NB-07 p.31, not the weighings' (none)",
		]);
	});

	it("scores 0 on weighings that name two notebook references", () => {
		const weighings = NOTED.map((w, i) =>
			i === 0 ? w : { ...w, notebook_reference: "NB-07 p.32" },
		);
		expect(evaluateResults(resultsRun({ weighings }))).toEqual({
			score: 0,
			passed: false,
			findings: [
				"the weighings do not all name one notebook reference: NB-07 p.31, NB-07 p.32",
			],
		});
	});

	it("scores 0 when the Run wrote no read-back, a sheet without the columns, or no Mean row", () => {
		expect(evaluateResults(resultsRun({ readBack: false }))).toEqual({
			score: 0,
			passed: false,
			findings: ["the Run has no result_worksheet.json read-back"],
		});
		expect(
			evaluateResults(resultsRun({ sheet: seed1Sheet().slice(0, 4) })),
		).toEqual({
			score: 0,
			passed: false,
			findings: [
				`the worksheet has no row of the Result Worksheet's columns ${RESULT_WORKSHEET_COLUMNS.join(", ")}`,
			],
		});
		expect(
			evaluateResults(resultsRun({ sheet: seed1Sheet().slice(0, 7) })),
		).toEqual({
			score: 0,
			passed: false,
			findings: ["the worksheet has no Mean row"],
		});
	});
});

type Recomputed = {
	row: number;
	formula: string | null;
	recomputed_g: number | null;
};

/** The record `verify_results` writes for seed 1's worksheet. */
const seed1Record = (worksheet: string, weighings: string) => ({
	schema: "verification_record/1",
	worksheet,
	weighings,
	tolerance_g: 0.0001,
	work_order: WO,
	rows: [
		{ container: 1, row: 6, formula: "=F6/20", recomputed_g: 7.0886 / 20 },
		{ container: 2, row: 7, formula: "=F7/20", recomputed_g: 7.2103 / 20 },
	] as (Recomputed & { container: Cell })[],
	mean: {
		row: 8,
		formula: "=AVERAGE(H6:H7)",
		recomputed_g: SEED1_MEAN,
	} as Recomputed,
	missing_containers: [] as number[],
	verdict: "pass" as "pass" | "fail",
});

type VerificationRecordJson = ReturnType<typeof seed1Record>;

const WORKSHEET = stageArtifact(
	"ResultWorksheet",
	"result_worksheet.xlsx",
	Buffer.from("the xlsx"),
);
const WEIGHINGS = stageArtifact(
	"Other",
	"submission-form-seed1.weighings.json",
	Buffer.from(JSON.stringify(SEED1_WEIGHINGS)),
);

/** Stage 5's Run on seed 1's worksheet and weighings, writing the record `edit` makes of seed 1's. */
const verificationRun = (
	edit: (record: VerificationRecordJson) => void = () => {},
) => {
	const record = seed1Record(WORKSHEET.id, WEIGHINGS.id);
	edit(record);
	return {
		inputs: [WORKSHEET, WEIGHINGS],
		outputs: [
			stageArtifact(
				"VerificationRecord",
				"verification_record.json",
				Buffer.from(JSON.stringify(record)),
			),
		],
	};
};

// The worksheet and the weighings it names, 1 per weighing, 1 per row, the
// mean, and the verdict.
const verificationChecks = (weighings: number, rows: number) =>
	2 + weighings + rows + 2;

describe("evaluateVerification", () => {
	it("passes seed 1's record: it names the Run's worksheet and weighings, every recomputation agrees with the weighings, and its verdict is pass", () => {
		expect(evaluateVerification(verificationRun())).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
	});

	it("fails a record whose typed average disagrees with its weights, even with its verdict fail, naming the row and the mean", () => {
		const evaluation = evaluateVerification(
			verificationRun((record) => {
				const [first] = record.rows;
				if (!first) throw new Error("no row");
				first.formula = null;
				first.recomputed_g = 0.36443;
				record.mean.recomputed_g = (0.36443 + 7.2103 / 20) / 2;
				record.verdict = "fail";
			}),
		);

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo(
			(verificationChecks(2, 2) - 2) / verificationChecks(2, 2),
		);
		expect(evaluation.findings).toEqual([
			`row 6 (container 1): a typed value recomputes to 0.36443, not ${7.0886 / 20}, the weighing's weight of 20 capsules / 20, within 0.0001 g`,
			`the Mean row's =AVERAGE(H6:H7) recomputes to ${(0.36443 + 7.2103 / 20) / 2}, not ${SEED1_MEAN}, the mean of the weighings' averages, within 0.0001 g`,
		]);
	});

	it("passes a recomputation within 0.0001 g of the weighing and fails one beyond it", () => {
		const off = (by: number) =>
			evaluateVerification(
				verificationRun((record) => {
					const [first] = record.rows;
					if (first) first.recomputed_g = 7.0886 / 20 + by;
				}),
			);

		expect(off(0.00009).passed).toBe(true);
		expect(off(0.001).findings).toEqual([
			`row 6 (container 1): =F6/20 recomputes to ${7.0886 / 20 + 0.001}, not ${7.0886 / 20}, the weighing's weight of 20 capsules / 20, within 0.0001 g`,
			"the record's verdict is pass, but a recomputation disagrees",
		]);
	});

	it("fails a verdict of fail on a worksheet that agrees, and a weighing with no row", () => {
		expect(
			evaluateVerification(
				verificationRun((record) => {
					record.verdict = "fail";
				}),
			).findings,
		).toEqual(["the record's verdict is fail, but every recomputation agrees"]);
		expect(
			evaluateVerification(
				verificationRun((record) => {
					record.rows.pop();
				}),
			).findings,
		).toEqual([
			"container 2: the record has no row for its weighing",
			"the record's verdict is pass, but a recomputation disagrees",
		]);
	});

	it("fails a record that names another worksheet or other weighings than the Run took", () => {
		const other = "0".repeat(64);

		expect(
			evaluateVerification(
				verificationRun((record) => {
					record.worksheet = other;
					record.weighings = other;
				}),
			).findings,
		).toEqual([
			`the record verifies ${other}, not the Result Worksheet ${WORKSHEET.id} the Run took`,
			`the record checks against ${other}, not the weighings ${WEIGHINGS.id} the Run took`,
		]);
	});

	it("scores 0 when the Run wrote no Verification Record, or one that is not JSON", () => {
		expect(
			evaluateVerification({ inputs: [WORKSHEET, WEIGHINGS], outputs: [] }),
		).toEqual({
			score: 0,
			passed: false,
			findings: ["the Run has no Verification Record"],
		});
		expect(
			evaluateVerification({
				inputs: [WORKSHEET, WEIGHINGS],
				outputs: [
					stageArtifact(
						"VerificationRecord",
						"verification_record.json",
						Buffer.from("not json"),
					),
				],
			}).findings,
		).toEqual([
			expect.stringMatching(/^verification_record\.json is not JSON/),
		]);
	});
});

const REF = "LR-2026-0001";
const RESULT_G = Number(SEED1_MEAN.toFixed(4));

/** Seed 1's Sample: its `samples` row joined to its `lots` row. */
const SEED1_SAMPLE = {
	lab_reference: REF,
	lot: LOT,
	date_received: "2026-01-06",
	time_received: "15:17",
	received_by: "LG",
	report_to_contact: "Maren Vantongeren",
	report_to_address: "39 Juniper Mill Drive",
	report_to_city: "Orrin Bay, NY 14999",
	product_code: PRODUCT_CODE,
	product_name: NAME,
	product_type: "60 ct amber glass bottle",
	client: "Tallowby Botanicals LLC",
};

/** Seed 1's Receiving Log row for LR-2026-0001, as `render_roa` reads it back. */
const seed1LogRow = (): Record<string, string> =>
	Object.fromEntries(
		RECEIVING_LOG_COLUMNS.map((column, i) => [column, row(REF)[i] ?? ""]),
	);

/**
 * The sheet `render_roa` writes for seed 1, as its read-back holds it, each
 * labelled cell from `cells`, and the signature area's notebook reference
 * when one is given.
 */
const reportSheet = (
	cells: Record<string, string>,
	notebook?: string,
): Cell[][] => {
	const labelled = (label: string): Cell[] => [
		label || null,
		cells[label] ?? null,
	];
	return [
		["Quillmere Analytical Laboratories", null],
		["27 Wrenfield Court, Velmora, NJ 07999", null],
		["Tel (201) 555-0100 · reports@quillmere.example", null],
		[null, null],
		["REPORT OF ANALYSIS", null],
		[null, null],
		...["Client", "Attention", "Address", ""].map(labelled),
		[null, null],
		...[
			"Lab Reference",
			"Product",
			"Lot",
			"Product Code",
			"Product Type",
			"Document Revision",
			"Date Received",
			"Time Received",
			"Received By",
		].map(labelled),
		[null, null],
		[null, null],
		[...REPORT_RESULT_COLUMNS],
		[TEST, "QAL-SOP-114", "Report value", RESULT_G, "g"],
		[null, null],
		[null, null],
		["Rendered By", null, "Verified By"],
		["render_roa", null, "Verification Record 0123456789ab, verdict pass"],
		["Signature: ______________", null, "Signature: ______________"],
		["Date: ______________", null, "Date: ______________"],
		...(notebook === undefined
			? []
			: [
					[null, null],
					[NOTEBOOK_LABEL, notebook],
				]),
	];
};

/** Seed 1's report cells: each `REPORT_METADATA` value of the Sample, and the form's revision. */
const seed1Cells = (): Record<string, string> => ({
	...Object.fromEntries(
		REPORT_METADATA.map(({ label, database }) => [
			label,
			SEED1_SAMPLE[database as keyof typeof SEED1_SAMPLE],
		]),
	),
	"Document Revision": "Rev. 03",
});

/** A PDF page stream showing each string with `Tj`, uncompressed, as reportlab writes it. */
const pdfShowing = (shown: readonly string[]): Buffer =>
	Buffer.from(
		[
			"%PDF-1.4",
			"stream",
			...shown.map(
				(text) =>
					`BT 1 0 0 1 72 700 Tm (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T* ET`,
			),
			"endstream",
		].join("\n"),
		"latin1",
	);

const SEED1_PDF = [REF, NAME, LOT, PRODUCT_CODE, RESULT_G.toFixed(4)];

/** A database version holding seed 1's Sample, the Work Order's rows and `reports` rows. */
const reportDatabase = (
	reports: readonly (readonly [string, string, string])[] = [],
): Buffer => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-evaluate-test-"));
	try {
		const path = join(dir, "lims.sqlite");
		const db = new DatabaseSync(path);
		const { product_code, product_name, product_type, client, ...sample } =
			SEED1_SAMPLE;
		db.exec(
			`CREATE TABLE lots (lot TEXT PRIMARY KEY, product_code TEXT, product_name TEXT, product_type TEXT, client TEXT);
			CREATE TABLE samples (${Object.keys(sample).join(", ")});
			CREATE TABLE work_orders (work_order TEXT, lab_reference TEXT, test TEXT);
			CREATE TABLE reports (lab_reference TEXT PRIMARY KEY, issued_date TEXT, document_revision TEXT, source_artifact TEXT)`,
		);
		db.prepare("INSERT INTO lots VALUES (?, ?, ?, ?, ?)").run(
			LOT,
			product_code,
			product_name,
			product_type,
			client,
		);
		db.prepare(
			`INSERT INTO samples VALUES (${Object.keys(sample)
				.map(() => "?")
				.join(", ")})`,
		).run(...Object.values(sample));
		for (const ref of [REF, "LR-2026-0002"]) {
			db.prepare("INSERT INTO work_orders VALUES (?, ?, ?)").run(WO, ref, TEST);
		}
		for (const [ref, revision, source] of reports) {
			db.prepare("INSERT INTO reports VALUES (?, '2026-10-13', ?, ?)").run(
				ref,
				revision,
				source,
			);
		}
		db.close();
		return readFileSync(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

/** Stage 6's Run on seed 1, each part of what it read and wrote replaceable. */
const reportRun = ({
	record = seed1Record(WORKSHEET.id, WEIGHINGS.id),
	logRow = seed1LogRow(),
	cells = seed1Cells(),
	pdf = pdfShowing(SEED1_PDF),
	carried = reportDatabase(),
	reports,
	weighings = SEED1_WEIGHINGS,
	notebook,
}: {
	record?: VerificationRecordJson;
	logRow?: Record<string, string>;
	cells?: Record<string, string>;
	pdf?: Buffer;
	carried?: Buffer;
	reports?: readonly (readonly [string, string, string])[];
	weighings?: readonly object[];
	/** The notebook reference the sheet's signature area holds. */
	notebook?: string;
} = {}) => {
	const pdfId = sha256Hex(pdf);
	return {
		inputs: [
			stageArtifact(
				"VerificationRecord",
				"verification_record.json",
				Buffer.from(JSON.stringify(record)),
			),
			stageArtifact(
				"ReceivingLogRow",
				"receiving_log_row.xlsx",
				Buffer.from("the row"),
			),
			stageArtifact(
				"Other",
				"weighings.json",
				Buffer.from(JSON.stringify(weighings)),
			),
			stageArtifact("LimsDatabase", "lims.sqlite", carried),
		],
		outputs: [
			stageArtifact(
				"LimsDatabase",
				"lims.sqlite",
				reportDatabase(reports ?? [[REF, "Rev. 03", pdfId]]),
			),
			stageArtifact(
				"Other",
				"report_of_analysis.json",
				Buffer.from(
					JSON.stringify({
						schema: "report_of_analysis/1",
						receiving_log_row: logRow,
						sheet: reportSheet(cells, notebook),
					}),
				),
			),
			stageArtifact("ReportOfAnalysis", "report_of_analysis.pdf", pdf),
			stageArtifact(
				"ReportOfAnalysis",
				"report_of_analysis.xlsx",
				Buffer.from("the xlsx"),
			),
		],
	};
};

// The verdict, the Work Order, 1 per database column and 1 per Receiving Log
// column of the metadata, the result, 4 in the PDF, the signature area's
// notebook reference, and 3 on the reports rows.
const REPORT_CHECKS =
	2 +
	REPORT_METADATA.length +
	REPORT_METADATA.filter((m) => m.receivingLog).length +
	1 +
	4 +
	1 +
	3;

describe("evaluateReport", () => {
	it("passes seed 1's report: every metadata cell is the Receiving Log row's and the database's, the result is the record's mean, the PDF shows it, and the reports row names the PDF", () => {
		expect(evaluateReport(reportRun())).toEqual({
			score: 1,
			passed: true,
			findings: [],
		});
	});

	it("fails a metadata cell that differs from the Receiving Log row, naming the cell and both sources", () => {
		const cells = seed1Cells();
		cells["Product Type"] = "90 ct amber glass bottle";

		const evaluation = evaluateReport(reportRun({ cells }));

		expect(evaluation.passed).toBe(false);
		expect(evaluation.score).toBeCloseTo((REPORT_CHECKS - 2) / REPORT_CHECKS);
		expect(evaluation.findings).toEqual([
			"Product Type: the report holds 90 ct amber glass bottle, not the Receiving Log row's TYPE 60 ct amber glass bottle",
			"Product Type: the report holds 90 ct amber glass bottle, not 60 ct amber glass bottle, the carried database's product_type for LR-2026-0001",
		]);
	});

	it("fails a Receiving Log row read back with a value the report and the database do not hold", () => {
		const logRow = seed1LogRow();
		logRow["Rec. Time"] = "15:71";

		expect(evaluateReport(reportRun({ logRow })).findings).toEqual([
			"Time Received: the report holds 15:17, not the Receiving Log row's Rec. Time 15:71",
		]);
	});

	it("fails a report rendered from a Verification Record whose verdict is fail", () => {
		const record = seed1Record(WORKSHEET.id, WEIGHINGS.id);
		record.verdict = "fail";

		const evaluation = evaluateReport(reportRun({ record }));

		expect(evaluation.passed).toBe(false);
		expect(evaluation.findings).toEqual([
			"the Verification Record's verdict is fail, so no Report of Analysis may be rendered from it",
		]);
	});

	it("fails a result that is not the record's mean, and a PDF that does not show it", () => {
		const record = seed1Record(WORKSHEET.id, WEIGHINGS.id);
		record.mean.recomputed_g = SEED1_MEAN + 0.001;

		expect(evaluateReport(reportRun({ record })).findings).toEqual([
			`the result is ${RESULT_G}, not the Verification Record's mean ${SEED1_MEAN + 0.001}, within 0.0001 g`,
		]);
		expect(
			evaluateReport(reportRun({ pdf: pdfShowing(SEED1_PDF.slice(0, -1)) }))
				.findings,
		).toEqual([
			`the PDF's text does not show the result ${RESULT_G.toFixed(4)}`,
		]);
	});

	it("fails a reports row that names another Artifact than the PDF, or a carried database that already reported the Sample", () => {
		const other = "0".repeat(64);
		const pdfId = sha256Hex(pdfShowing(SEED1_PDF));

		expect(
			evaluateReport(reportRun({ reports: [[REF, "Rev. 03", other]] }))
				.findings,
		).toEqual([
			`the reports row for ${REF} names ${other}, not the PDF ${pdfId}`,
		]);
		expect(
			evaluateReport(
				reportRun({ carried: reportDatabase([[REF, "Rev. 03", other]]) }),
			).findings,
		).toEqual([`the carried database already has a reports row for ${REF}`]);
	});

	it("passes a signature area and a PDF that show the weighings' notebook reference, and fails either without it", () => {
		const noted = SEED1_WEIGHINGS.map((w) => ({
			...w,
			notebook_reference: "NB-07 p.31",
		}));
		const pdf = pdfShowing([...SEED1_PDF, NOTEBOOK_LABEL, "NB-07 p.31"]);

		expect(
			evaluateReport(
				reportRun({ weighings: noted, notebook: "NB-07 p.31", pdf }),
			),
		).toEqual({ score: 1, passed: true, findings: [] });
		expect(
			evaluateReport(reportRun({ weighings: noted, notebook: "NB-07 p.31" }))
				.findings,
		).toEqual([
			"the PDF's text does not show the notebook reference NB-07 p.31",
		]);
		expect(
			evaluateReport(reportRun({ weighings: noted, pdf })).findings,
		).toEqual([
			"the signature area's Notebook Reference is empty, not the weighings' NB-07 p.31",
		]);
	});

	it("fails a Sample that is not on the record's Work Order", () => {
		const record = seed1Record(WORKSHEET.id, WEIGHINGS.id);
		record.work_order = "WO-2026-0999";

		expect(evaluateReport(reportRun({ record })).findings).toEqual([
			`${REF} is not a Sample of Work Order WO-2026-0999`,
		]);
	});

	it("scores 0 when the Run wrote no PDF", () => {
		const run = reportRun();

		expect(
			evaluateReport({
				...run,
				outputs: run.outputs.filter(
					(o) => o.filename !== "report_of_analysis.pdf",
				),
			}),
		).toEqual({
			score: 0,
			passed: false,
			findings: ["the Run wrote no PDF Report of Analysis"],
		});
	});
});

describe("pdfText", () => {
	it("reads each string a Tj shows, unescaping parentheses, backslashes and octal codes", () => {
		expect(
			pdfText(
				Buffer.from(
					"BT (Tel \\(201\\) 555-0100 \\267 a\\\\b) Tj T* ET\nBT (LR-2026-0001) Tj ET",
					"latin1",
				),
			),
		).toBe("Tel (201) 555-0100 · a\\b\nLR-2026-0001");
	});
});
