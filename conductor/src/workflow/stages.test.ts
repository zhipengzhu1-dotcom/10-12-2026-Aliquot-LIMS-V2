import { describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { checkStages, STAGES, type Stage } from "./stages.js";

const [submission] = STAGES;
if (!submission) throw new Error("the stage table has no stage 1");

const rin = AgentId.parse("A-rin");
const bram = AgentId.parse("A-bram");

/** Stages 1 to 5, Results worked by Rin and Verification by `verifier`. */
const table = (verifier: AgentId): Stage[] =>
	[1, 2, 3, 4, 5].map((number) => ({
		...submission,
		number,
		name: ["Submission", "Receipt", "Work Order", "Results", "Verification"][
			number - 1
		] as string,
		worked_by: number === 4 ? rin : number === 5 ? verifier : bram,
	}));

describe("the stage table", () => {
	it("has stage 1, Submission: parse_submission from a SubmissionForm to a SubmissionRecord, worked by Rin and reviewed by Pia", () => {
		expect(submission).toMatchObject({
			number: 1,
			name: "Submission",
			script: "parse_submission",
			inputs: ["SubmissionForm"],
			carried: [],
			outputs: ["SubmissionRecord"],
			worked_by: "A-rin",
			reviewed_by: "A-pia",
		});
	});

	it("has stage 2, Receipt: log_receipt from the SubmissionRecord and the carried LimsDatabase to a ReceivingLogRow and the next LimsDatabase, worked by Bram and reviewed by Pia", () => {
		expect(STAGES[1]).toMatchObject({
			number: 2,
			name: "Receipt",
			script: "log_receipt",
			inputs: ["SubmissionRecord"],
			carried: ["LimsDatabase"],
			outputs: ["ReceivingLogRow", "LimsDatabase"],
			worked_by: "A-bram",
			reviewed_by: "A-pia",
		});
	});

	it("has stage 3, Work Order: create_work_order from the ReceivingLogRow and the carried LimsDatabase to a WorkOrder and the next LimsDatabase, worked by Bram and reviewed by Pia", () => {
		expect(STAGES[2]).toMatchObject({
			number: 3,
			name: "Work Order",
			script: "create_work_order",
			inputs: ["ReceivingLogRow"],
			carried: ["LimsDatabase"],
			outputs: ["WorkOrder", "LimsDatabase"],
			worked_by: "A-bram",
			reviewed_by: "A-pia",
		});
	});

	it("has stage 4, Results: compute_results from the WorkOrder, the weighings and the carried LimsDatabase to a ResultWorksheet and the next LimsDatabase, worked by Rin and reviewed by Anselm", () => {
		expect(STAGES[3]).toMatchObject({
			number: 4,
			name: "Results",
			script: "compute_results",
			inputs: ["WorkOrder", "Other"],
			carried: ["LimsDatabase"],
			outputs: ["ResultWorksheet", "LimsDatabase"],
			worked_by: "A-rin",
			reviewed_by: "A-anselm",
		});
	});

	it("has stage 5, Verification: verify_results from the ResultWorksheet and the weighings to a VerificationRecord, worked by Bram and reviewed by Anselm", () => {
		expect(STAGES[4]).toMatchObject({
			number: 5,
			name: "Verification",
			script: "verify_results",
			inputs: ["ResultWorksheet", "Other"],
			carried: [],
			outputs: ["VerificationRecord"],
			worked_by: "A-bram",
			reviewed_by: "A-anselm",
		});
	});

	it("has stage 6, Report: render_roa from the VerificationRecord, the ReceivingLogRow, the weighings and the carried LimsDatabase to two Reports of Analysis and the next LimsDatabase, worked by Ines and reviewed by Anselm, and no stage after it", () => {
		expect(STAGES).toHaveLength(6);
		expect(STAGES[5]).toMatchObject({
			number: 6,
			name: "Report",
			script: "render_roa",
			inputs: ["VerificationRecord", "ReceivingLogRow", "Other"],
			carried: ["LimsDatabase"],
			outputs: ["ReportOfAnalysis", "ReportOfAnalysis", "LimsDatabase"],
			worked_by: "A-ines",
			reviewed_by: "A-anselm",
		});
	});

	it("is refused when stage 5 is worked by the Agent that works stage 4", () => {
		expect(checkStages(table(bram))).toHaveLength(5);
		expect(() => checkStages(table(rin))).toThrow(
			"stage table refused: stage 5 Verification is worked by A-rin, who works stage 4 Results",
		);
	});

	it("is refused when its rows are not stages 1, 2, 3 in order", () => {
		const [one, two] = table(bram);
		if (!one || !two) throw new Error("no rows");

		expect(() => checkStages([two, one])).toThrow(
			"stage table refused: row 1 is stage 2",
		);
	});
});
