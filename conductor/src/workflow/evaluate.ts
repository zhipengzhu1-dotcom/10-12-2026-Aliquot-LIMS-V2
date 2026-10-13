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
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ArtifactType } from "../types/artifact.js";
import { TAT_CODES } from "../types/task.js";
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

type DatabaseVersion = {
	/** Each `samples` row's Lot, by Lab Reference. */
	readonly samples: ReadonlyMap<string, string>;
	readonly lots: readonly string[];
};

/** Read one toy LIMS database version, opened read-only from a scratch copy. */
const readDatabase = (artifact: StageArtifact): DatabaseVersion => {
	const dir = mkdtempSync(join(tmpdir(), "aliquot-evaluation-"));
	try {
		const path = join(dir, "lims.sqlite");
		writeFileSync(path, artifact.bytes);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return {
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
			};
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
