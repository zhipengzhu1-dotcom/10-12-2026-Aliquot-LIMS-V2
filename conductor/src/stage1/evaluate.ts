/**
 * The stage 1 Evaluation: every required field of the submission record is
 * present and every TAT code is valid. The record is the `submission.json`
 * that `sandbox/scripts/parse_submission/main.py` writes (schema
 * `submission/1`, documented in that Script).
 */

import { TAT_CODES } from "../types/task.js";

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

export type SubmissionEvaluation = {
	/** Fraction of checks passed, 0 to 1. */
	score: number;
	/** Every check passed. */
	passed: boolean;
	/** One line per failed check. */
	findings: string[];
};

const objectAt = (value: unknown, key: string): Record<string, unknown> => {
	if (typeof value !== "object" || value === null) return {};
	const inner = (value as Record<string, unknown>)[key];
	return typeof inner === "object" && inner !== null
		? (inner as Record<string, unknown>)
		: {};
};

const filled = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

export const evaluateSubmission = (record: unknown): SubmissionEvaluation => {
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
