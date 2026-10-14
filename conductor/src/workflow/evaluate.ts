/**
 * The stage Evaluations.
 *
 * Stage 1: the submission record lists at least one Sample, every required
 * field of it and of each Sample is present, and every TAT code is valid.
 * The record is the `submission.json` that
 * `sandbox/scripts/parse_submission/main.py` writes (schema `submission/2`,
 * documented in that Script).
 *
 * Stage 2: the Receiving Log rows and the next toy LIMS database version
 * that `sandbox/scripts/log_receipt/main.py` writes match the record the
 * Run read, one row per container of every Sample.
 *
 * Stage 3: the Work Order that `sandbox/scripts/create_work_order/main.py`
 * writes gives every Sample on the Receiving Log row the due date this module
 * computes on its own, its Lot and a Test, is due with its last Sample, and
 * has `work_orders` rows that agree with it.
 *
 * Stage 4: the Result Worksheet that `sandbox/scripts/compute_results/main.py`
 * writes computes every average and the mean by formula from the weighings,
 * its header holds the weighings' notebook reference when they name one,
 * and the `results` rows agree with it.
 *
 * Stage 5: the Verification Record that `sandbox/scripts/verify_results/main.py`
 * writes names the worksheet and weighings the Run took, every recomputation
 * agrees with the weighings, and its verdict says so.
 *
 * Stage 6: the Report of Analysis that `sandbox/scripts/render_roa/main.py`
 * writes holds the Receiving Log row's and the carried database's values in
 * every metadata cell and the Verification Record's mean as its result, its
 * PDF shows the same, its signature area holds the weighings' notebook
 * reference when they name one, the record's verdict was pass, and the
 * `reports` row names the Sample and the PDF.
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
 * and its label on the Submission Form, and the same for each of the
 * record's `samples`. Mirrors `REQUIRED_PARTY_FIELDS`,
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
	receipt: {
		label: "Receipt",
		fields: {
			date_received: "Date Received",
			time_received: "Time Received",
			received_by: "Received By (initials)",
		},
	},
} as const;

export const REQUIRED_SAMPLE_FIELDS = {
	sample_description: "Sample Description",
	sample_type: "Sample Type",
	tat_code: "TAT Code",
	lot: "Lot",
	product_code: "Product Code",
	product_type: "Product Type",
	no_of_containers: "No. of Containers",
} as const;

const VALID_TAT_CODES: readonly string[] = Object.keys(TAT_CODES);

const asObject = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};

const objectAt = (value: unknown, key: string): Record<string, unknown> =>
	asObject(asObject(value)[key]);

const filled = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

export const evaluateSubmission = (record: unknown): Scored => {
	const findings: string[] = [];
	let checks = 0;
	const check = (ok: boolean, finding: string) => {
		checks++;
		if (!ok) findings.push(finding);
	};
	for (const [section, { label, fields }] of Object.entries(REQUIRED_FIELDS)) {
		const values = objectAt(record, section);
		for (const [key, field] of Object.entries(fields)) {
			check(filled(values[key]), `${label}: ${field} is missing`);
		}
	}

	const listed = asObject(record).samples;
	const samples = Array.isArray(listed) ? listed.map(asObject) : [];
	check(samples.length > 0, "Samples: the record lists no Sample");
	samples.forEach((sample, i) => {
		const label = `Sample ${filled(sample.no) ? sample.no : i + 1}`;
		for (const [key, field] of Object.entries(REQUIRED_SAMPLE_FIELDS)) {
			check(filled(sample[key]), `${label}: ${field} is missing`);
		}
		const tat = sample.tat_code;
		const shown = tat === undefined ? "(none)" : JSON.stringify(tat);
		check(
			typeof tat === "string" && VALID_TAT_CODES.includes(tat),
			`${label}: TAT Code ${shown} is not a valid TAT code (${VALID_TAT_CODES.slice(0, -1).join(", ")} or ${VALID_TAT_CODES.at(-1)})`,
		);
	});

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
	samples: z
		.array(
			z.object({
				sample_description: z.string(),
				sample_type: z.string(),
				lot: z.string(),
				product_code: z.string(),
				no_of_containers: z.string().regex(/^\d+$/, "is not a whole number"),
			}),
		)
		.min(1),
	submitted_by: z.object({ company: z.string(), contact: z.string() }),
	receipt: z.object({
		date_received: z.iso.date(),
		time_received: z.string(),
		received_by: z.string(),
	}),
});
type ReceivedRecord = z.infer<typeof ReceivedRecord>;
type ReceivedSample = ReceivedRecord["samples"][number];

/** Each container's Sample, Sample by Sample in form order, as stage 2 numbers them. */
const containersOf = (record: ReceivedRecord): readonly ReceivedSample[] =>
	record.samples.flatMap((sample) =>
		Array.from({ length: Number(sample.no_of_containers) }, () => sample),
	);

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

/** Each coordinate that holds a value, and its text. */
const Cells = z.record(z.string(), z.string());

/** `shadow.json` (schema `shadow/1`), as `log_receipt` documents it. */
const ShadowReadBack = z.object({
	schema: z.literal("shadow/1"),
	year: z.object({ sheet: z.string(), rows: z.array(z.number().int()) }),
	day: z.object({
		sheet: z.string(),
		rows: z.array(z.number().int()),
		made: z.boolean(),
	}),
	sheets: z.array(
		z.object({
			name: z.string(),
			before: Cells.nullable(),
			after: Cells.nullable(),
		}),
	),
});
type ShadowReadBack = z.infer<typeof ShadowReadBack>;

/**
 * Where the lab's workbook keeps each value of a received container, by
 * column letter: its headers that named the lab are not kept in the
 * Fixtures, so the columns are found by position (ADR-0018).
 * `sandbox/scripts/log_receipt/shadow.py` keeps its own copy; each side
 * places the values on its own, so a wrong column in either fails.
 */
const SHADOW_COLUMNS = {
	year: {
		B: ["Rec. DATE", (r) => r.receipt.date_received],
		C: ["Rec. Time", (r) => r.receipt.time_received],
		D: ["Product Code", (_, s) => s.product_code],
		E: ["PRODUCT NAME", (_, s) => s.sample_description],
		F: ["TYPE", (_, s) => s.sample_type],
		G: ["LOT#", (_, s) => s.lot],
		H: ["CLIENT", (r) => r.submitted_by.company],
		J: ["QTY RECD", () => "1"],
		K: ["SENT BY", (r) => r.submitted_by.contact],
		L: ["RECD BY", (r) => r.receipt.received_by],
	},
	day: {
		B: ["DATE", (r) => r.receipt.date_received],
		C: ["PRODUCT NAME", (_, s) => s.sample_description],
		D: ["TYPE", (_, s) => s.sample_type],
		E: ["LOT#", (_, s) => s.lot],
		F: ["CLIENT", (r) => r.submitted_by.company],
		H: ["QTY RECD", () => "1"],
		I: ["RECD BY", (r) => r.receipt.received_by],
	},
} satisfies Record<
	string,
	Record<
		string,
		readonly [string, (r: ReceivedRecord, s: ReceivedSample) => string]
	>
>;

/** The column of each sheet that holds the Lab Reference. */
const SHADOW_LAB_REFERENCE = { year: "M", day: "J" } as const;

const rowOf = (coordinate: string): number =>
	Number(coordinate.replace(/^[A-Z]+/, ""));

/** The day's sheet's name, as the lab names it: `July 23`. */
const daySheetName = (date: string): string => {
	const on = new Date(`${date}T00:00:00Z`);
	const month = on.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
	return `${month} ${on.getUTCDate()}`;
};

/**
 * The Shadow against the record and the receipt's Lab References: the year's
 * sheet and the day's sheet are the ones the date received names, each has
 * one new row per container holding the record's values and its Sample's in
 * the lab's columns, no cell of the lab's workbook changed or went missing,
 * and nothing was written outside the new rows but the day's sheet when it
 * is new.
 */
const checkShadow = (
	check: (ok: boolean, finding: string) => void,
	record: ReceivedRecord,
	refs: readonly string[],
	held: ShadowReadBack,
) => {
	const containers = containersOf(record);
	const received = record.receipt.date_received;
	check(
		held.year.sheet === received.slice(0, 4),
		`the Shadow's rows are in sheet ${held.year.sheet}, not the year received's ${received.slice(0, 4)}`,
	);
	check(
		held.day.sheet === daySheetName(received),
		`the Shadow's day rows are in sheet ${held.day.sheet}, not ${daySheetName(received)}`,
	);
	const sheets = new Map(held.sheets.map((s) => [s.name, s]));
	for (const part of ["year", "day"] as const) {
		const { sheet, rows } = held[part];
		const after = sheets.get(sheet)?.after ?? {};
		check(
			rows.length === refs.length,
			`the Shadow's sheet ${sheet} has ${rows.length} new rows for ${refs.length} containers`,
		);
		rows.forEach((row, i) => {
			const sample = containers[i];
			if (sample === undefined) return;
			const expected: [string, string, string][] = [
				...Object.entries(SHADOW_COLUMNS[part]).map(
					([col, [field, value]]): [string, string, string] => [
						col,
						field,
						value(record, sample),
					],
				),
				[SHADOW_LAB_REFERENCE[part], "Lab Reference", refs[i] ?? ""],
			];
			for (const [col, field, value] of expected) {
				const found = after[`${col}${row}`] ?? "";
				check(
					found === value,
					`the Shadow's sheet ${sheet} row ${row}: ${field} (${col}) is ${JSON.stringify(found)}, not ${JSON.stringify(value)}`,
				);
			}
		});
	}
	for (const { name, before, after } of held.sheets) {
		if (before === null) {
			check(
				name === held.day.sheet && held.day.made,
				`the Shadow has a sheet ${name} the lab's workbook lacks, and it is not the new day's sheet`,
			);
			continue;
		}
		if (after === null) {
			check(false, `the Shadow lost the lab's sheet ${name}`);
			continue;
		}
		const changed = Object.entries(before).filter(
			([at, value]) => after[at] !== value,
		);
		check(
			changed.length === 0,
			`the Shadow changed the lab's cells in sheet ${name}: ${changed
				.map(
					([at, value]) =>
						`${at} ${JSON.stringify(value)} to ${JSON.stringify(after[at] ?? "")}`,
				)
				.join(", ")}`,
		);
		const newRows = new Set<number>([
			...(name === held.year.sheet ? held.year.rows : []),
			...(name === held.day.sheet ? held.day.rows : []),
		]);
		const outside = Object.keys(after).filter(
			(at) => !(at in before) && !newRows.has(rowOf(at)),
		);
		check(
			outside.length === 0,
			`the Shadow wrote sheet ${name} outside its new rows: ${outside.join(", ")}`,
		);
	}
};

/**
 * Stage 2's Evaluation of its Run. Against the SubmissionRecord it read:
 * one Receiving Log row per container of every Sample, in form order, each
 * with its Sample's Lot and Product Code; one `samples` row per row's Lab
 * Reference with that Lot and one `lots` row for each Lot in the database it
 * wrote; and no row's Lab Reference in the database version it carried. The
 * rows come from
 * `receipt.json`, because the Conductor has no xlsx reader. When the Run read
 * the lab's Receiving Log, the Shadow it wrote passes `checkShadow`, read
 * from `shadow.json` for the same reason.
 */
export const evaluateReceipt = ({ inputs, outputs }: RunArtifacts): Scored => {
	try {
		const record = readJson(
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
		const containers = containersOf(record);
		check(
			sheet.rows.length === containers.length,
			`${sheet.rows.length} Receiving Log rows for ${containers.length} containers`,
		);
		sheet.rows.forEach((row, i) => {
			const ref = row[LAB_REFERENCE] ?? "";
			const at = `row ${i + 1} (${ref})`;
			const lot = containers[i]?.lot;
			const productCode = containers[i]?.product_code;
			check(
				row[LOT] === lot,
				`${at}: LOT# ${row[LOT]} is not the record's Lot ${lot}`,
			);
			check(
				row[PRODUCT_CODE] === productCode,
				`${at}: Product Code ${row[PRODUCT_CODE]} is not the record's ${productCode}`,
			);
			check(
				database.samples.get(ref) === lot,
				`${at}: the database has no samples row for ${ref} with Lot ${lot}`,
			);
			check(
				!before.has(ref),
				`${at}: Lab Reference ${ref} is already in the carried database`,
			);
		});
		for (const lot of new Set(record.samples.map((s) => s.lot))) {
			const rows = database.lots.filter((l) => l === lot).length;
			check(
				rows === 1,
				`the database has ${rows} lots rows for Lot ${lot}, not 1`,
			);
		}
		if (ofType(inputs, "ReceivingLog")) {
			if (!ofType(outputs, "ShadowReceivingLog")) {
				throw new Unreadable(
					"the Run read the lab's Receiving Log and wrote no ShadowReceivingLog",
				);
			}
			checkShadow(
				check,
				record,
				sheet.rows.map((row) => row[LAB_REFERENCE] ?? ""),
				readJson(
					outputs.find((a) => a.filename === "shadow.json"),
					"shadow.json read-back",
					ShadowReadBack,
				),
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

export const WORK_ORDER_COLUMNS = [
	"Lab Reference",
	"Test",
	"Lot",
	"Product Code",
	"TAT Class",
	"Due Date",
] as const;

/**
 * `work_order.json` (schema `work_order/2`): the Receiving Log row's Lab
 * References and dates as the Script read them, and the Work Order as it
 * read back its xlsx, a row being `WORK_ORDER_COLUMNS`.
 */
const WorkOrderReadBack = z.object({
	schema: z.literal("work_order/2"),
	receiving_log_row: z.array(z.tuple([z.string(), z.iso.date()])),
	header: z.object({ "Work Order": z.string(), "Due Date": z.string() }),
	columns: z.array(z.string()),
	rows: z.array(
		z.tuple([
			z.string(),
			z.string(),
			z.string(),
			z.string(),
			z.string(),
			z.string(),
		]),
	),
});

type WorkOrderRow = {
	readonly work_order: string;
	readonly lab_reference: string;
	readonly test: string;
	readonly due_date: string;
};

type WorkOrders = {
	/** Each `samples` row's TAT class and Lot, by Lab Reference. */
	readonly samples: ReadonlyMap<
		string,
		{ readonly tat_class: string; readonly lot: string }
	>;
	readonly rows: readonly WorkOrderRow[];
};

const readWorkOrders = (artifact: StageArtifact): WorkOrders =>
	queryDatabase(artifact, (db) => ({
		samples: new Map(
			db
				.prepare("SELECT lab_reference, tat_class, lot FROM samples")
				.all()
				.map((row) => [
					String(row.lab_reference),
					{ tat_class: String(row.tat_class), lot: String(row.lot) },
				]),
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
 * row: the Work Order has a Test for it, and each of its rows' due date is
 * the one computed here from the row's date received and the Sample's TAT
 * class in the database version the Run carried. Every Work Order row names
 * a Sample on the Receiving Log row with that Sample's Lot, the Work Order's
 * own due date is its last row's, the Work Order number is new, and the
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
			const rows = sheet.rows.filter(([onRow]) => onRow === ref);
			const tat = TatClass.safeParse(before.samples.get(ref)?.tat_class);
			if (tat.success) {
				const expected = dueDate(received, tat.data);
				const wrong = rows.find((row) => row[5] !== expected)?.[5];
				check(
					wrong === undefined,
					`${ref}: due date ${wrong} is not ${expected}, ${TAT_BUSINESS_DAYS[tat.data]} business days after ${received} for TAT class ${tat.data}`,
				);
			} else {
				check(
					false,
					`${ref}: the carried database has no samples row for it with a TAT class`,
				);
			}
			check(rows.length > 0, `${ref}: the Work Order has no Test for it`);
		}
		const received = new Set(sheet.receiving_log_row.map(([ref]) => ref));
		sheet.rows.forEach(([ref, , lot], i) => {
			check(
				received.has(ref),
				`Work Order row ${i + 1}: ${ref} is not on the Receiving Log row`,
			);
			const sampled = before.samples.get(ref)?.lot;
			check(
				lot === sampled,
				sampled === undefined
					? `Work Order row ${i + 1}: the carried database has no samples row for ${ref}`
					: `Work Order row ${i + 1}: Lot ${lot} is not ${ref}'s Lot ${sampled}`,
			);
		});
		const last = sheet.rows
			.map((row) => row[5])
			.sort()
			.at(-1);
		check(
			due === last,
			`the Work Order's due date ${due} is not its last Sample's, ${last}`,
		);
		check(
			!before.rows.some((row) => row.work_order === number),
			`Work Order ${number} is already in the carried database`,
		);
		const document = sheet.rows.map(
			([ref, test, , , , rowDue]) => `${ref} ${test} ${rowDue}`,
		);
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

/**
 * The weighings file: one entry per container, as `synth` writes
 * `weighings.json`. Weighings read from the Operator's results Message
 * (`parse_results_message`) also give each entry the notebook reference.
 */
const Weighings = z.array(
	z.object({
		container: z.int(),
		weight_of_20_g: z.number(),
		weight_taken_g: z.number(),
		notebook_reference: z.string().min(1).optional(),
	}),
);

/** The label of the notebook reference in the worksheet's header and the report's signature area. */
export const NOTEBOOK_LABEL = "Notebook Reference";

/** The one notebook reference the weighings name, or none; weighings naming two are unreadable. */
const notebookOf = (
	weighings: z.infer<typeof Weighings>,
): string | undefined => {
	const named = new Set(weighings.map((w) => w.notebook_reference));
	if (named.size > 1) {
		throw new Unreadable(
			`the weighings do not all name one notebook reference: ${[...named].map(String).join(", ")}`,
		);
	}
	return [...named][0];
};

/** The column B value of the first row whose column A holds `label`. */
const labelled = (sheet: readonly (readonly Cell[])[], label: string) =>
	sheet.find((row) => row[0] === label)?.[1];

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
 * of its container, every weighing has a row, the Mean row averages the
 * rows by formula, and the header's Notebook Reference is the weighings'
 * notebook reference, or absent when they name none. In the database
 * version the Run wrote: for every
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
		const notebook = notebookOf(weighings);
		const headed = labelled(sheet.slice(0, header), NOTEBOOK_LABEL);
		check(
			headed === notebook,
			`the header's ${NOTEBOOK_LABEL} is ${shown(headed)}, not the weighings' ${notebook ?? "(none)"}`,
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

/**
 * The Report of Analysis's Client and metadata cells by their column A
 * label, and where each value comes from: the Receiving Log column and the
 * carried database's column (the Sample's `samples` row joined to its
 * `lots` row). The Client's city line has no label, so it reads as "".
 * Mirrors `CLIENT` and `METADATA` in `sandbox/scripts/render_roa/main.py`,
 * whose Document Revision belongs to the report form and is checked
 * against the `reports` row instead.
 */
export const REPORT_METADATA: readonly {
	readonly label: string;
	readonly receivingLog?: (typeof RECEIVING_LOG_COLUMNS)[number];
	readonly database: string;
}[] = [
	{ label: "Client", receivingLog: "CLIENT", database: "client" },
	{ label: "Attention", database: "report_to_contact" },
	{ label: "Address", database: "report_to_address" },
	{ label: "", database: "report_to_city" },
	{ label: "Lab Reference", receivingLog: "#", database: "lab_reference" },
	{ label: "Product", receivingLog: "PRODUCT NAME", database: "product_name" },
	{ label: "Lot", receivingLog: "LOT#", database: "lot" },
	{
		label: "Product Code",
		receivingLog: "Product Code",
		database: "product_code",
	},
	{ label: "Product Type", receivingLog: "TYPE", database: "product_type" },
	{
		label: "Date Received",
		receivingLog: "Rec. DATE",
		database: "date_received",
	},
	{
		label: "Time Received",
		receivingLog: "Rec. Time",
		database: "time_received",
	},
	{ label: "Received By", database: "received_by" },
];

export const REPORT_RESULT_COLUMNS = [
	"Test",
	"Method",
	"Specification",
	"Result",
	"Unit",
] as const;

const RESULT = REPORT_RESULT_COLUMNS.indexOf("Result");

/** `report_of_analysis.json` (schema `report_of_analysis/1`): the Sample's Receiving Log row as the Script read it, and the report's sheet as it read back its xlsx. */
const ReportReadBack = z.object({
	schema: z.literal("report_of_analysis/1"),
	receiving_log_row: z.record(z.string(), z.string()),
	sheet: z.array(z.array(Cell)),
});

/** The Verification Record fields stage 6 reads. */
const VerifiedMean = z.object({
	schema: z.literal("verification_record/1"),
	work_order: z.string(),
	mean: z.object({ recomputed_g: z.number().nullable() }),
	verdict: z.enum(["pass", "fail"]),
});

/**
 * The strings a PDF's `Tj` operators show, one per line, read from the
 * uncompressed page streams `render_roa` writes. A compressed stream shows
 * nothing here.
 */
export const pdfText = (bytes: Buffer): string =>
	[...bytes.toString("latin1").matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj/g)]
		.map(([, shown = ""]) =>
			shown.replace(/\\([0-7]{1,3}|[\s\S])/g, (_, escaped: string) =>
				/^[0-7]/.test(escaped)
					? String.fromCharCode(Number.parseInt(escaped, 8))
					: escaped,
			),
		)
		.join("\n");

type Reported = {
	/** The Sample's `samples` row joined to its `lots` row, as text. */
	readonly sample: Readonly<Record<string, string>> | undefined;
	/** The Lab References of the Work Order's `work_orders` rows. */
	readonly onWorkOrder: ReadonlySet<string>;
	/** The Sample's `reports` row. */
	readonly report:
		| { readonly document_revision: string; readonly source_artifact: string }
		| undefined;
};

const readReported = (
	artifact: StageArtifact,
	ref: string,
	workOrder: string,
): Reported =>
	queryDatabase(artifact, (db) => {
		const sample = db
			.prepare(
				"SELECT samples.*, lots.product_code, lots.product_name, lots.product_type, lots.client FROM samples JOIN lots ON lots.lot = samples.lot WHERE samples.lab_reference = ?",
			)
			.get(ref);
		const report = db
			.prepare(
				"SELECT document_revision, source_artifact FROM reports WHERE lab_reference = ?",
			)
			.get(ref);
		return {
			sample:
				sample &&
				Object.fromEntries(
					Object.entries(sample).map(([k, v]) => [k, String(v)]),
				),
			onWorkOrder: new Set(
				db
					.prepare("SELECT lab_reference FROM work_orders WHERE work_order = ?")
					.all(workOrder)
					.map((row) => String(row.lab_reference)),
			),
			report: report && {
				document_revision: String(report.document_revision),
				source_artifact: String(report.source_artifact),
			},
		};
	});

/**
 * Stage 6's Evaluation of its Run. The Verification Record it took has
 * verdict pass. Every Client and metadata cell of the report equals the
 * value `REPORT_METADATA` names in the Sample's Receiving Log row and in
 * the database version the Run carried, and the Sample is on the record's
 * Work Order. The result equals
 * the record's recomputed mean within `RESULTS_TOLERANCE_G`. The PDF's text
 * shows the report's Lab Reference, Lot, Product Code and result to 4
 * places. The signature area's Notebook Reference, in the sheet and in the
 * PDF's text, is the notebook reference of the weighings the Run took, and
 * absent from the sheet when they name none. The `reports` row of the
 * version the Run wrote names the Sample, the report's Document Revision
 * and the PDF's Artifact id, and the carried version had none for the
 * Sample. The sheet and the Receiving Log row come from
 * `report_of_analysis.json`, because the Conductor has no xlsx reader; the
 * PDF's text is read from its bytes.
 */
export const evaluateReport = ({ inputs, outputs }: RunArtifacts): Scored => {
	try {
		const record = readJson(
			ofType(inputs, "VerificationRecord"),
			"Verification Record",
			VerifiedMean,
		);
		const notebook = notebookOf(
			readJson(ofType(inputs, "Other"), "weighings file", Weighings),
		);
		const { receiving_log_row: logged, sheet } = readJson(
			outputs.find((a) => a.filename === "report_of_analysis.json"),
			"report_of_analysis.json read-back",
			ReportReadBack,
		);
		const reports = outputs.filter(
			(a) => a.artifact_type === "ReportOfAnalysis",
		);
		const pdf = reports.find((a) => a.filename?.endsWith(".pdf"));
		if (!pdf) throw new Unreadable("the Run wrote no PDF Report of Analysis");
		if (!reports.some((a) => a.filename?.endsWith(".xlsx"))) {
			throw new Unreadable("the Run wrote no xlsx Report of Analysis");
		}
		const carried = ofType(inputs, "LimsDatabase");
		if (!carried) throw new Unreadable("the Run carried no LimsDatabase");
		const written = ofType(outputs, "LimsDatabase");
		if (!written) throw new Unreadable("the Run wrote no LimsDatabase");

		const header = sheet.findIndex((row) =>
			REPORT_RESULT_COLUMNS.every((column, i) => row[i] === column),
		);
		const resultRow = sheet[header + 1];
		if (header < 0 || !resultRow) {
			throw new Unreadable(
				`the report has no results table of the columns ${REPORT_RESULT_COLUMNS.join(", ")}`,
			);
		}
		const cells = new Map(
			sheet
				.slice(0, header)
				.filter((row) => row[1] !== null && row[1] !== undefined)
				.map((row) => [String(row[0] ?? ""), String(row[1])]),
		);
		const ref = cells.get("Lab Reference") ?? "";
		const before = readReported(carried, ref, record.work_order);
		const after = readReported(written, ref, record.work_order);

		const findings: string[] = [];
		let checks = 0;
		const check = (ok: boolean, finding: string) => {
			checks++;
			if (!ok) findings.push(finding);
		};
		check(
			record.verdict === "pass",
			`the Verification Record's verdict is ${record.verdict}, so no Report of Analysis may be rendered from it`,
		);
		check(
			before.onWorkOrder.has(ref),
			`${ref || "the report's Lab Reference"} is not a Sample of Work Order ${record.work_order}`,
		);
		for (const { label, receivingLog, database } of REPORT_METADATA) {
			const name = label || "Address, second line";
			const cell = cells.get(label);
			if (receivingLog) {
				check(
					cell === logged[receivingLog],
					`${name}: the report holds ${cell ?? "nothing"}, not the Receiving Log row's ${receivingLog} ${logged[receivingLog] ?? "(none)"}`,
				);
			}
			const stored = before.sample?.[database];
			check(
				cell === stored,
				`${name}: the report holds ${cell ?? "nothing"}, not ${stored ?? "(no samples row)"}, the carried database's ${database} for ${ref}`,
			);
		}

		const result = resultRow[RESULT];
		const mean = record.mean.recomputed_g;
		check(
			typeof result === "number" &&
				mean !== null &&
				Math.abs(result - mean) <= RESULTS_TOLERANCE_G,
			`the result is ${shown(result)}, not the Verification Record's mean ${mean ?? "(none)"}, within ${RESULTS_TOLERANCE_G} g`,
		);
		const text = pdfText(pdf.bytes);
		const shownInPdf = [
			["Lab Reference", ref],
			["Lot", cells.get("Lot")],
			["Product Code", cells.get("Product Code")],
			["result", typeof result === "number" ? result.toFixed(4) : undefined],
		] as const;
		for (const [what, value] of shownInPdf) {
			check(
				value !== undefined && text.split("\n").includes(value),
				`the PDF's text does not show the ${what} ${value ?? "(none)"}`,
			);
		}
		const signed = labelled(sheet.slice(header + 2), NOTEBOOK_LABEL);
		check(
			signed === notebook,
			`the signature area's ${NOTEBOOK_LABEL} is ${shown(signed)}, not the weighings' ${notebook ?? "(none)"}`,
		);
		if (notebook !== undefined) {
			check(
				text.split("\n").includes(notebook),
				`the PDF's text does not show the notebook reference ${notebook}`,
			);
		}

		check(
			before.report === undefined,
			`the carried database already has a reports row for ${ref}`,
		);
		check(
			after.report?.source_artifact === pdf.id,
			`the reports row for ${ref} names ${after.report?.source_artifact ?? "nothing"}, not the PDF ${pdf.id}`,
		);
		const revision = cells.get("Document Revision");
		check(
			after.report !== undefined && after.report.document_revision === revision,
			`the reports row for ${ref} has Document Revision ${after.report?.document_revision ?? "(no row)"}, not the report's ${revision ?? "(none)"}`,
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
