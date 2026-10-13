import { AgentId, type ArtifactId } from "../ids.js";
import type { ArtifactType } from "../types/artifact.js";
import {
	evaluateReceipt,
	evaluateResults,
	evaluateSubmissionRecord,
	evaluateWorkOrder,
} from "./evaluate.js";
import type { Scored } from "./lifecycle.js";

/** One Artifact a stage's Run read or wrote, as the stage's Evaluation reads it. */
export type StageArtifact = {
	readonly id: ArtifactId;
	readonly artifact_type: ArtifactType;
	readonly filename?: string | undefined;
	readonly bytes: Buffer;
};

/** What a stage's Evaluation scores: the Run's input Artifacts and every Artifact it wrote. */
export type RunArtifacts = {
	readonly inputs: readonly StageArtifact[];
	readonly outputs: readonly StageArtifact[];
};

/** One row of the toy workflow. */
export type Stage = {
	readonly number: number;
	readonly name: string;
	/** The Script's name, its directory under `sandbox/scripts/`. */
	readonly script: string;
	/**
	 * Types taken from the previous stage's outputs; stage 1 takes the
	 * Fixture. `Other` is the weighings the Operator keeps beside the Fixture.
	 */
	readonly inputs: readonly ArtifactType[];
	/** Types taken from the latest Artifact of that type a Done Task's Run wrote, when there is one. */
	readonly carried: readonly ArtifactType[];
	readonly outputs: readonly ArtifactType[];
	readonly worked_by: AgentId;
	readonly reviewed_by: AgentId;
	/** Scores a Run that exited 0 and wrote an Artifact of each output type. */
	readonly evaluate: (run: RunArtifacts) => Scored;
};

const RESULTS = 4;
const VERIFICATION = 5;

/**
 * The table, or why it is refused: stages are numbered 1, 2, 3 in order,
 * and Verification is worked by a different Agent than Results.
 */
export const checkStages = (stages: readonly Stage[]): readonly Stage[] => {
	stages.forEach((stage, i) => {
		if (stage.number !== i + 1) {
			throw new Error(
				`stage table refused: row ${i + 1} is stage ${stage.number}`,
			);
		}
	});
	const results = stages[RESULTS - 1];
	const verification = stages[VERIFICATION - 1];
	if (results && verification?.worked_by === results.worked_by) {
		throw new Error(
			`stage table refused: stage ${VERIFICATION} ${verification.name} is worked by ${verification.worked_by}, who works stage ${RESULTS} ${results.name}`,
		);
	}
	return stages;
};

export const STAGES: readonly Stage[] = checkStages([
	{
		number: 1,
		name: "Submission",
		script: "parse_submission",
		inputs: ["SubmissionForm"],
		carried: [],
		outputs: ["SubmissionRecord"],
		worked_by: AgentId.parse("A-rin"),
		reviewed_by: AgentId.parse("A-pia"),
		evaluate: evaluateSubmissionRecord,
	},
	{
		number: 2,
		name: "Receipt",
		script: "log_receipt",
		inputs: ["SubmissionRecord"],
		carried: ["LimsDatabase"],
		outputs: ["ReceivingLogRow", "LimsDatabase"],
		worked_by: AgentId.parse("A-bram"),
		reviewed_by: AgentId.parse("A-pia"),
		evaluate: evaluateReceipt,
	},
	{
		number: 3,
		name: "Work Order",
		script: "create_work_order",
		inputs: ["ReceivingLogRow"],
		carried: ["LimsDatabase"],
		outputs: ["WorkOrder", "LimsDatabase"],
		worked_by: AgentId.parse("A-bram"),
		reviewed_by: AgentId.parse("A-pia"),
		evaluate: evaluateWorkOrder,
	},
	{
		number: 4,
		name: "Results",
		script: "compute_results",
		inputs: ["WorkOrder", "Other"],
		carried: ["LimsDatabase"],
		outputs: ["ResultWorksheet", "LimsDatabase"],
		worked_by: AgentId.parse("A-rin"),
		reviewed_by: AgentId.parse("A-anselm"),
		evaluate: evaluateResults,
	},
]);
