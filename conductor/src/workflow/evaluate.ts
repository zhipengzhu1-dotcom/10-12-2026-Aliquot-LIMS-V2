/**
 * The stage Evaluations.
 *
 * Stage 1: every required field of the submission record is present and
 * every TAT code is valid. The record is the `submission.json` that
 * `sandbox/scripts/parse_submission/main.py` writes (schema `submission/1`,
 * documented in that Script).
 *
 * Stage 2: the Receiving Log rows and the next toy LIMS database version
 * that `sandbox/scripts/log_receipt/main.py` writes match the record the
 * Run read.
 *
 * Stage 3: the Work Order that `sandbox/scripts/create_work_order/main.py`
 * writes has the due date this module computes on its own, a Test for
 * every Sample on the Receiving Log row, and `work_orders` rows that agree
 * with it.
 *
 * Stage 4: the Result Worksheet that `sandbox/scripts/compute_results/main.py`
 * writes computes every average and the mean by formula from the weighings,
 * and the `results` rows agree with it.
 *
 * Stage 5: the Verification Record that `sandbox/scripts/verify_results/main.py`
 * writes names the worksheet and weighings the Run took, every recomputation
 * agrees with the weighings, and its verdict says so.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ArtifactType } from "../types/artifact.js";
import { TAT_CODES, TatClass } from "../types/task.js";
import type { Scored } from "./lifecycle.js";
import type { RunArtifacts, StageArtifact } from "./stages.js";

/**
 * Required fields per section: the record key, then each field's record key
 * and its label on the Submission Form. Mirrors `REQUIRED_PARTY_FIELDS`,
 * `REQUIRED_SAMPLE_FIELDS` and `REQUIRED_RECEIPT_FIELDS` in
 * `sandbox/synth/submission_form.py`; change both together.
 */
export const REQUIRED_FIELDS = {
	submitted_by: {
		label: "Submitted By",
		fields: {
			company: "Company",
			contact: "Contact",
			address: "Address",
			city: "City",
			phone: "Phone",
			email: "Email",
		},
	},
	bill_to: {
		label: "Bill To",
		fields: {
			company: "Company",
			contact: "Contact",
			address: "Address",
			city: "City",
		},
	},
	report_to: {
		label: "Report To",
		fields: { company: "Company", contact: "Contact", email: "Email" },
	},
	sample: {
		label: "Sample",
		fields: {
			sample_description: "Sample Description",
			sample_type: "Sample Type",
			tat_code: "TAT Code",
			lot: "Lot",
			product_code: "Product Code",
			product_type: "Product Type",
			no_of_containers: "No. of Containers",
		},
	},
	receipt: {
		label: "Receipt",
		fields: {
			date_received: "Date Received",
			time_received: "Time Received",
			received_by: "Received By (initials)",
		},
	},
} as const;

const VALID_TAT_CODES: readonly string[] = Object.keys(TAT_CODES);

const objectAt = (value: unknown, key: string): Record<string, unknown> => {
	if (typeof value !== "object" || value === null) return {};
	const inner = (value as Record<string, unknown>)[key];
	return typeof inner === "object" && inner !== null
		? (inner as Record<string, unknown>)
		: {};
};

const filled = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

export const evaluateSubmission = (record: unknown): Scored => {
	const findings: string[] = [];
	let checks = 0;
	for (const [section, { label, fields }] of Object.entries(REQUIRED_FIELDS)) {
		const values = objectAt(record, section);
		for (const [key, field] of Object.entries(fields)) {
			checks++;
			if (!filled(values[key])) findings.push(`${label}: ${field} is missing`);
		}
	}

	checks++;
	const tat = objectAt(record, "sample").tat_code;
	if (typeof tat !== "string" || !VALID_TAT_CODES.includes(tat)) {
		const shown = tat === undefined ? "(none)" : JSON.stringify(tat);
		findings.push(
			`Sample: TAT Code ${shown} is not a valid TAT code (${VALID_TAT_CODES.slice(0, -1).join(", ")} or ${VALID_TAT_CODES.at(-1)})`,
		);
	}

	return {
		score: (checks - findings.length) / checks,
		passed: findings.length === 0,
		findings,
	};
};

const failed = (finding: string): Scored => ({
	score: 0,
	passed: false,
	findings: [finding],
});

/** Stage 1's Evaluation of its Run: the SubmissionRecord, read as JSON and checked. */
export const evaluateSubmissionRecord = ({ outputs }: RunArtifacts): Scored => {
	const record = outputs.find((o) => o.artifact_type === "SubmissionRecord");
	if (!record) return failed("the Run wrote no SubmissionRecord");
	let parsed: unknown;
	try {
		parsed = JSON.parse(record.bytes.toString("utf8"));
	} catch (error) {
		return failed(
			`${record.filename ?? record.id} is not JSON: ${(error as Error).message}`,
		);
	}
	return evaluateSubmission(parsed);
};

/** The Receiving Log's columns, in order, as `sandbox/synth/receiving_log.py` writes them. */
export const RECEIVING_LOG_COLUMNS = [
	"#",
	"Rec. DATE",
	"Rec. Time",
	"Product Code",
	"PRODUCT NAME",
	"TYPE",
	"LOT#",
	"CLIENT",
	"EXP DATE",
	"QTY RECD",
] as const;

const LAB_REFERENCE = RECEIVING_LOG_COLUMNS.indexOf("#");
const PRODUCT_CODE = RECEIVING_LOG_COLUMNS.indexOf("Product Code");
const LOT = RECEIVING_LOG_COLUMNS.indexOf("LOT#");

/** The record fields stage 2 checks the rows against. */
const ReceivedRecord = z.object({
	sample: z.object({
		lot: z.string(),
		product_code: z.string(),
		no_of_containers: z.string().regex(/^\d+$/, "is not a whole number"),
	}),
});

/** `receipt.json` (schema `receipt/1`): the sheet as the Script read back its xlsx. */
const ReadBack = z.object({
	schema: z.literal("receipt/1"),
	columns: z.array(z.string()),
	rows: z.array(z.array(z.string())),
});

/** An Artifact the Evaluation cannot read, which fails it outright. */
class Unreadable extends Error {}

const nameOf = (artifact: StageArtifact) => artifact.filename ?? artifact.id;

const readJson = <T>(
	artifact: StageArtifact | undefined,
	what: string,
	schema: z.ZodType<T>,
): T => {
	if (!artifact) throw new Unreadable(`the Run has no ${what}`);
	let value: unknown;
	try {
		value = JSON.parse(artifact.bytes.toString("utf8"));
	} catch (error) {
		throw new Unreadable(
			`${nameOf(artifact)} is not JSON: ${(error as Error).message}`,
		);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Unreadable(
			`${nameOf(artifact)} is not a ${what}: ${z.prettifyError(parsed.error)}`,
		);
	}
	return parsed.data;
};

/** Query one toy LIMS database version, opened read-only from a scratch copy. */
const queryDatabase = <T>(
	artifact: StageArtifact,
	query: (db: DatabaseSync) => T,
): T => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-evaluation-"));
	try {
		const path = join(dir, "lims.sqlite");
		writeFileSync(path, artifact.bytes);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return query(db);
		} finally {
			db.close();
		}
	} catch (error) {
		throw new Unreadable(
			`${nameOf(artifact)} is not a toy LIMS database: ${(error as Error).message}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

type DatabaseVersion = {
	/** Each `samples` row's Lot, by Lab Reference. */
	readonly samples: ReadonlyMap<string, string>;
	readonly lots: readonly string[];
};

const readDatabase = (artifact: StageArtifact): DatabaseVersion =>
	queryDatabase(artifact, (db) => ({
		samples: new Map(
			db
				.prepare("SELECT lab_reference, lot FROM samples")
				.all()
				.map((row) => [String(row.lab_reference), String(row.lot)]),
		),
		lots: db
			.prepare("SELECT lot FROM lots")
			.all()
			.map((row) => String(row.lot)),
	}));

const ofType = (artifacts: readonly StageArtifact[], type: ArtifactType) =>
	artifacts.find((a) => a.artifact_type === type);

/**
 * Stage 2's Evaluation of its Run. Against the SubmissionRecord it read:
 * one Receiving Log row per container, each with the record's Lot and
 * Product Code; one `samples` row per row's Lab Reference with that Lot and
 * one `lots` row for the Lot in the database it wrote; and no row's Lab
 * Reference in the database version it carried. The rows come from
 * `receipt.json`, because the Conductor has no xlsx reader.
 */
export const evaluateReceipt = ({ inputs, outputs }: RunArtifacts): Scored => {
	try {
		const { sample } = readJson(
			ofType(inputs, "SubmissionRecord"),
			"SubmissionRecord",
			ReceivedRecord,
		);
		const sheet = readJson(
			outputs.find((a) => a.filename === "receipt.json"),
			"receipt.json read-back",
			ReadBack,
		);
		const written = ofType(outputs, "LimsDatabase");
		if (!written) throw new Unreadable("the Run wrote no LimsDatabase");
		const database = readDatabase(written);
		const carried = ofType(inputs, "LimsDatabase");
		const before = carried ? readDatabase(carried).samples : new Map();

		if (sheet.columns.join("\0") !== RECEIVING_LOG_COLUMNS.join("\0")) {
			throw new Unreadable(
				`the sheet's columns are ${sheet.columns.join(", ")}, not the Receiving Log's ${RECEIVING_LOG_COLUMNS.join(", ")}`,
			);
		}

		const findings: string[] = [];
		let checks = 0;
		const check = (ok: boolean, finding: string) => {
			checks++;
			if (!ok) findings.push(finding);
		};
		const containers = Number(sample.no_of_containers);
		check(
			sheet.rows.length === containers,
			`${sheet.rows.length} Receiving Log rows for ${containers} containers`,
		);
		sheet.rows.forEach((row, i) => {
			const ref = row[LAB_REFERENCE] ?? "";
			const at = `row ${i + 1} (${ref})`;
			check(
				row[LOT] === sample.lot,
				`${at}: LOT# ${row[LOT]} is not the record's Lot ${sample.lot}`,
			);
			check(
				row[PRODUCT_CODE] === sample.product_code,
				`${at}: Product Code ${row[PRODUCT_CODE]} is not the record's ${sample.product_code}`,
			);
			check(
				database.samples.get(ref) === sample.lot,
				`${at}: the database has no samples row for ${ref} with Lot ${sample.lot}`,
			);
			check(
				!before.has(ref),
				`${at}: Lab Reference ${ref} is already in the carried database`,
			);
		});
		const lots = database.lots.filter((lot) => lot === sample.lot).length;
		check(
			lots === 1,
			`the database has ${lots} lots rows for Lot ${sample.lot}, not 1`,
		);

		return {
			score: (checks - findings.length) / checks,
			passed: findings.length === 0,
			findings,
		};
	} catch (error) {
		if (error instanceof Unreadable) return failed(error.message);
		throw error;
	}
};

/**
 * Business days from the date received to the due date, by TAT class.
 * `create_work_order` keeps its own table; each side computes the date on
 * its own, so a wrong date in either fails the Evaluation.
 */
export const TAT_BUSINESS_DAYS = {
	Regular: 10,
	Rush1to2Days: 2,
	Rush3to4Days: 4,
} as const satisfies Record<TatClass, number>;

/** The TAT class's business days (Monday to Friday, no holidays) after `received`, as YYYY-MM-DD. */
export const dueDate = (received: string, tat: TatClass): string => {
	const day = new Date(`${received}T00:00:00Z`);
	for (let left: number = TAT_BUSINESS_DAYS[tat]; left > 0; ) {
		day.setUTCDate(day.getUTCDate() + 1);
		const weekday = day.getUTCDay();
		if (weekday !== 0 && weekday !== 6) left--;
	}
	return day.toISOString().slice(0, 10);
};

export const WORK_ORDER_COLUMNS = ["Lab Reference", "Test"] as const;

/**
 * `work_order.json` (schema `work_order/1`): the Receiving Log row's Lab
 * References and dates as the Script read them, and the Work Order as it
 * read back its xlsx.
 */
const WorkOrderReadBack = z.object({
	schema: z.literal("work_order/1"),
	receiving_log_row: z.array(z.tuple([z.string(), z.iso.date()])),
	header: z.object({ "Work Order": z.string(), "Due Date": z.string() }),
	columns: z.array(z.string()),
	rows: z.array(z.tuple([z.string(), z.string()])),
});

type WorkOrderRow = {
	readonly work_order: string;
	readonly lab_reference: string;
	readonly test: string;
	readonly due_date: string;
};

type WorkOrders = {
	/** Each `samples` row's TAT class, by Lab Reference. */
	readonly tatClasses: ReadonlyMap<string, string>;
	readonly rows: readonly WorkOrderRow[];
};

const readWorkOrders = (artifact: StageArtifact): WorkOrders =>
	queryDatabase(artifact, (db) => ({
		tatClasses: new Map(
			db
				.prepare("SELECT lab_reference, tat_class FROM samples")
				.all()
				.map((row) => [String(row.lab_reference), String(row.tat_class)]),
		),
		rows: db
			.prepare(
				"SELECT work_order, lab_reference, test, due_date FROM work_orders",
			)
			.all()
			.map((row) => ({
				work_order: String(row.work_order),
				lab_reference: String(row.lab_reference),
				test: String(row.test),
				due_date: String(row.due_date),
			})),
	}));

/**
 * Stage 3's Evaluation of its Run. For every Sample on the Receiving Log
 * row: the Work Order's due date is the one computed here from the row's
 * date received and the Sample's TAT class in the database version the Run
 * carried, and the Work Order has a Test for it. Every Work Order row names
 * a Sample on the Receiving Log row, the Work Order number is new, and the
 * `work_orders` rows of the version the Run wrote agree with the document.
 * The Work Order comes from `work_order.json`, because the Conductor has no
 * xlsx reader.
 */
export const evaluateWorkOrder = ({
	inputs,
	outputs,
}: RunArtifacts): Scored => {
	try {
		const sheet = readJson(
			outputs.find((a) => a.filename === "work_order.json"),
			"work_order.json read-back",
			WorkOrderReadBack,
		);
		const carried = ofType(inputs, "LimsDatabase");
		if (!carried) throw new Unreadable("the Run carried no LimsDatabase");
		const written = ofType(outputs, "LimsDatabase");
		if (!written) throw new Unreadable("the Run wrote no LimsDatabase");
		const before = readWorkOrders(carried);
		const after = readWorkOrders(written);
		if (sheet.columns.join("\0") !== WORK_ORDER_COLUMNS.join("\0")) {
			throw new Unreadable(
				`the Work Order's columns are ${sheet.columns.join(", ")}, not ${WORK_ORDER_COLUMNS.join(", ")}`,
			);
		}

		const findings: string[] = [];
		let checks = 0;
		const check = (ok: boolean, finding: string) => {
			checks++;
			if (!ok) findings.push(finding);
		};
		const { "Work Order": number, "Due Date": due } = sheet.header;
		for (const [ref, received] of sheet.receiving_log_row) {
			const tat = TatClass.safeParse(before.tatClasses.get(ref));
			if (tat.success) {
				const expected = dueDate(received, tat.data);
				check(
					due === expected,
					`${ref}: due date ${due} is not ${expected}, ${TAT_BUSINESS_DAYS[tat.data]} business days after ${received} for TAT class ${tat.data}`,
				);
			} else {
				check(
					false,
					`${ref}: the carried database has no samples row for it with a TAT class`,
				);
			}
			check(
				sheet.rows.some(([onRow]) => onRow === ref),
				`${ref}: the Work Order has no Test for it`,
			);
		}
		const received = new Set(sheet.receiving_log_row.map(([ref]) => ref));
		sheet.rows.forEach(([ref], i) => {
			check(
				received.has(ref),
				`Work Order row ${i + 1}: ${ref} is not on the Receiving Log row`,
			);
		});
		check(
			!before.rows.some((row) => row.work_order === number),
			`Work Order ${number} is already in the carried database`,
		);
		const document = sheet.rows.map(([ref, test]) => `${ref} ${test} ${due}`);
		const database = after.rows
			.filter((row) => row.work_order === number)
			.map((row) => `${row.lab_reference} ${row.test} ${row.due_date}`);
		check(
			document.sort().join("; ") === database.sort().join("; "),
			`the work_orders rows for ${number} (${database.join("; ") || "none"}) do not agree with the Work Order (${document.join("; ")})`,
		);

		return {
			score: (checks - findings.length) / checks,
			passed: findings.length === 0,
			findings,
		};
	} catch (error) {
		if (error instanceof Unreadable) return failed(error.message);
		throw error;
	}
};

/** The Result Worksheet's columns, in order, as `sandbox/synth/result_worksheet.py` writes them. */
export const RESULT_WORKSHEET_COLUMNS = [
	"#",
	"Code",
	"Name",
	"Status",
	"Lot#",
	"Weight of 20 Capsules (g)",
	"Weight Taken (g)",
	"Average Weight (g)",
] as const;

const CONTAINER = RESULT_WORKSHEET_COLUMNS.indexOf("#");
const WEIGHT_OF_20 = RESULT_WORKSHEET_COLUMNS.indexOf(
	"Weight of 20 Capsules (g)",
);
const WEIGHT_TAKEN = RESULT_WORKSHEET_COLUMNS.indexOf("Weight Taken (g)");
const AVERAGE = RESULT_WORKSHEET_COLUMNS.indexOf("Average Weight (g)");

/** How far a `results` value may be from the worksheet's arithmetic, in g. */
export const RESULTS_TOLERANCE_G = 0.0001;
export const AVERAGE_WEIGHT_TEST = "Average capsule weight";
/** The `results` test name of the mean of a Work Order's averages. */
export const MEAN_AVERAGE_WEIGHT = "Average capsule weight, Work Order mean";

const Cell = z.union([z.string(), z.number(), z.null()]);
type Cell = z.infer<typeof Cell>;

/** `result_worksheet.json` (schema `result_worksheet/1`): the sheet as the Script read back its xlsx, formulas as text. */
const WorksheetReadBack = z.object({
	schema: z.literal("result_worksheet/1"),
	sheet: z.array(z.array(Cell)),
});

/** The weighings file: one entry per container, as `synth` writes `weighings.json`. */
const Weighings = z.array(
	z.object({
		container: z.int(),
		weight_of_20_g: z.number(),
		weight_taken_g: z.number(),
	}),
);

const shown = (cell: Cell | undefined) =>
	cell === undefined || cell === null ? "empty" : String(cell);

type Results = {
	/** Each `samples` row's container number, by Lab Reference. */
	readonly containers: ReadonlyMap<string, number>;
	readonly workOrders: readonly Omit<WorkOrderRow, "due_date">[];
	/** Each `results` row's value, by Lab Reference and test. */
	readonly values: ReadonlyMap<string, number>;
};

const resultKey = (ref: string, test: string) => `${ref}\0${test}`;

const readResults = (artifact: StageArtifact): Results =>
	queryDatabase(artifact, (db) => ({
		containers: new Map(
			db
				.prepare("SELECT lab_reference, container FROM samples")
				.all()
				.map((row) => [String(row.lab_reference), Number(row.container)]),
		),
		workOrders: db
			.prepare("SELECT work_order, lab_reference, test FROM work_orders")
			.all()
			.map((row) => ({
				work_order: String(row.work_order),
				lab_reference: String(row.lab_reference),
				test: String(row.test),
			})),
		values: new Map(
			db
				.prepare("SELECT lab_reference, test, value FROM results")
				.all()
				.map((row) => [
					resultKey(String(row.lab_reference), String(row.test)),
					Number(row.value),
				]),
		),
	}));

/**
 * Stage 4's Evaluation of its Run. On the worksheet: every container row's
 * average is the formula `=F<row>/20`, its two weights equal the weighing
 * of its container, every weighing has a row, and the Mean row averages
 * the rows by formula. In the database version the Run wrote: for every
 * Sample of the Work Order, as the carried version lists them, the
 * `results` row for "Average capsule weight" equals its container row's
 * weight of 20 capsules divided by 20, and its Work Order mean row equals
 * the mean of those, each within `RESULTS_TOLERANCE_G`. The worksheet
 * comes from `result_worksheet.json`, because the Conductor has no xlsx
 * reader; the weighings are the Run's `Other` input.
 */
export const evaluateResults = ({ inputs, outputs }: RunArtifacts): Scored => {
	try {
		const { sheet } = readJson(
			outputs.find((a) => a.filename === "result_worksheet.json"),
			"result_worksheet.json read-back",
			WorksheetReadBack,
		);
		const weighings = readJson(
			ofType(inputs, "Other"),
			"weighings file",
			Weighings,
		);
		const carried = ofType(inputs, "LimsDatabase");
		if (!carried) throw new Unreadable("the Run carried no LimsDatabase");
		const written = ofType(outputs, "LimsDatabase");
		if (!written) throw new Unreadable("the Run wrote no LimsDatabase");
		const before = readResults(carried);
		const after = readResults(written);

		const header = sheet.findIndex((row) =>
			RESULT_WORKSHEET_COLUMNS.every((column, i) => row[i] === column),
		);
		if (header < 0) {
			throw new Unreadable(
				`the worksheet has no row of the Result Worksheet's columns ${RESULT_WORKSHEET_COLUMNS.join(", ")}`,
			);
		}
		const body = sheet.slice(header + 1);
		const meanAt = body.findIndex((row) => row[WEIGHT_TAKEN] === "Mean");
		const meanRow = body[meanAt];
		if (!meanRow) throw new Unreadable("the worksheet has no Mean row");
		// Sheet rows count from 1, and the first container row follows the column row.
		const first = header + 2;
		const rows = body.slice(0, meanAt).map((cells, i) => ({
			at: first + i,
			cells,
		}));
		const number = sheet.find((row) => row[0] === "Work Order")?.[1];

		const findings: string[] = [];
		let checks = 0;
		const check = (ok: boolean, finding: string) => {
			checks++;
			if (!ok) findings.push(finding);
		};
		const weighingOf = new Map(weighings.map((w) => [w.container, w]));
		const averages = new Map<number, number>();
		for (const { at, cells } of rows) {
			const container = cells[CONTAINER];
			const weighing =
				typeof container === "number" ? weighingOf.get(container) : undefined;
			const where = `row ${at} (container ${shown(container)})`;
			const average = cells[AVERAGE];
			check(
				average === `=F${at}/20`,
				`${where}: Average Weight (g) is ${shown(average)}, not the formula =F${at}/20`,
			);
			const of20 = cells[WEIGHT_OF_20];
			check(
				weighing !== undefined && of20 === weighing.weight_of_20_g,
				`${where}: Weight of 20 Capsules (g) ${shown(of20)} is not the weighing's ${weighing?.weight_of_20_g ?? "(none)"}`,
			);
			const taken = cells[WEIGHT_TAKEN];
			check(
				weighing !== undefined && taken === weighing.weight_taken_g,
				`${where}: Weight Taken (g) ${shown(taken)} is not the weighing's ${weighing?.weight_taken_g ?? "(none)"}`,
			);
			if (typeof container === "number" && typeof of20 === "number") {
				averages.set(container, of20 / 20);
			}
		}
		for (const { container } of weighings) {
			check(
				rows.some(({ cells }) => cells[CONTAINER] === container),
				`container ${container}: the worksheet has no row for its weighing`,
			);
		}
		const meanFormula = `=AVERAGE(H${first}:H${first + rows.length - 1})`;
		check(
			meanRow[AVERAGE] === meanFormula,
			`the Mean row's Average Weight (g) is ${shown(meanRow[AVERAGE])}, not the formula ${meanFormula}`,
		);

		const refs = before.workOrders
			.filter((r) => r.work_order === number && r.test === AVERAGE_WEIGHT_TEST)
			.map((r) => r.lab_reference);
		check(
			refs.length > 0,
			`Work Order ${shown(number)} has no ${AVERAGE_WEIGHT_TEST} rows in the carried database`,
		);
		const mean =
			[...averages.values()].reduce((sum, a) => sum + a, 0) / averages.size;
		const agrees = (value: number | undefined, expected: number | undefined) =>
			value !== undefined &&
			expected !== undefined &&
			Math.abs(value - expected) <= RESULTS_TOLERANCE_G;
		for (const ref of refs) {
			const container = before.containers.get(ref);
			const expected =
				container === undefined ? undefined : averages.get(container);
			const value = after.values.get(resultKey(ref, AVERAGE_WEIGHT_TEST));
			check(
				agrees(value, expected),
				`${ref}: results holds ${value ?? "no row"} for ${AVERAGE_WEIGHT_TEST}, not ${expected ?? "(no worksheet row)"}, container ${container ?? "(none)"}'s Weight of 20 Capsules (g) / 20, within ${RESULTS_TOLERANCE_G} g`,
			);
			const meanValue = after.values.get(resultKey(ref, MEAN_AVERAGE_WEIGHT));
			check(
				agrees(meanValue, mean),
				`${ref}: results holds ${meanValue ?? "no row"} for ${MEAN_AVERAGE_WEIGHT}, not ${mean}, the mean of the worksheet's averages, within ${RESULTS_TOLERANCE_G} g`,
			);
		}

		return {
			score: (checks - findings.length) / checks,
			passed: findings.length === 0,
			findings,
		};
	} catch (error) {
		if (error instanceof Unreadable) return failed(error.message);
		throw error;
	}
};

/** One recomputed cell of a Verification Record. */
const Recomputed = z.object({
	row: z.int(),
	formula: z.string().nullable(),
	recomputed_g: z.number().nullable(),
});

/** `verification_record.json` (schema `verification_record/1`), the fields stage 5 checks. */
const VerificationRecordFile = z.object({
	schema: z.literal("verification_record/1"),
	worksheet: z.string(),
	weighings: z.string(),
	rows: z.array(Recomputed.extend({ container: Cell })),
	mean: Recomputed,
	verdict: z.enum(["pass", "fail"]),
});

/**
 * Stage 5's Evaluation of its Run. The Verification Record names the Result
 * Worksheet and the weighings the Run took; it has a row for every
 * weighing; each row's recomputed average is its container's weight of 20
 * capsules divided by 20, and the recomputed mean the mean of those, each
 * within `RESULTS_TOLERANCE_G`, computed here from the Run's weighings; and
 * its verdict is `pass` exactly when all of that agrees. The Run's
 * Artifacts name no Agent, so the rule that the Verifier is not the
 * worksheet's author is the workflow guard's, on whoever takes the Task.
 */
export const evaluateVerification = ({
	inputs,
	outputs,
}: RunArtifacts): Scored => {
	try {
		const record = readJson(
			ofType(outputs, "VerificationRecord"),
			"Verification Record",
			VerificationRecordFile,
		);
		const worksheet = ofType(inputs, "ResultWorksheet");
		if (!worksheet) throw new Unreadable("the Run took no ResultWorksheet");
		const given = ofType(inputs, "Other");
		const weighings = readJson(given, "weighings file", Weighings);

		const findings: string[] = [];
		let checks = 0;
		const check = (ok: boolean, finding: string) => {
			checks++;
			if (!ok) findings.push(finding);
		};
		check(
			record.worksheet === worksheet.id,
			`the record verifies ${record.worksheet}, not the Result Worksheet ${worksheet.id} the Run took`,
		);
		check(
			record.weighings === given?.id,
			`the record checks against ${record.weighings}, not the weighings ${given?.id} the Run took`,
		);

		const named = findings.length;
		const within = (value: number | null, expected: number | undefined) =>
			value !== null &&
			expected !== undefined &&
			Math.abs(value - expected) <= RESULTS_TOLERANCE_G;
		const averageOf = new Map(
			weighings.map((w) => [w.container, w.weight_of_20_g / 20]),
		);
		for (const { container } of weighings) {
			check(
				record.rows.some((r) => r.container === container),
				`container ${container}: the record has no row for its weighing`,
			);
		}
		for (const row of record.rows) {
			const expected =
				typeof row.container === "number"
					? averageOf.get(row.container)
					: undefined;
			check(
				within(row.recomputed_g, expected),
				`row ${row.row} (container ${shown(row.container)}): ${row.formula ?? "a typed value"} recomputes to ${row.recomputed_g ?? "nothing"}, not ${expected ?? "(no weighing)"}, the weighing's weight of 20 capsules / 20, within ${RESULTS_TOLERANCE_G} g`,
			);
		}
		const averages = [...averageOf.values()];
		const mean = averages.reduce((sum, a) => sum + a, 0) / averages.length;
		check(
			within(record.mean.recomputed_g, mean),
			`the Mean row's ${record.mean.formula ?? "typed value"} recomputes to ${record.mean.recomputed_g ?? "nothing"}, not ${mean}, the mean of the weighings' averages, within ${RESULTS_TOLERANCE_G} g`,
		);
		const agrees = findings.length === named;
		check(
			record.verdict === (agrees ? "pass" : "fail"),
			`the record's verdict is ${record.verdict}, but ${agrees ? "every recomputation agrees" : "a recomputation disagrees"}`,
		);

		return {
			score: (checks - findings.length) / checks,
			passed: findings.length === 0,
			findings,
		};
	} catch (error) {
		if (error instanceof Unreadable) return failed(error.message);
		throw error;
	}
};
