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
		expect(STAGES).toHaveLength(1);
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
