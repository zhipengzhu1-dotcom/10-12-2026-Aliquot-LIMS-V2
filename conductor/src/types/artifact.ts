import { z } from "zod";
import { ArtifactId, RunId, Sha256 } from "../ids.js";

export const ArtifactType = z.enum([
	"SubmissionForm",
	"ReceivingLogRow",
	"WorkOrder",
	"ResultWorksheet",
	"VerificationRecord",
	"ReportOfAnalysis",
	"Other",
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const Artifact = z.strictObject({
	id: ArtifactId,
	sha256: Sha256,
	media_type: z.string().min(1),
	artifact_type: ArtifactType,
	produced_by: z.discriminatedUnion("tag", [
		z.strictObject({ tag: z.literal("Run"), id: RunId }),
		z.strictObject({ tag: z.literal("Operator") }),
	]),
	lineage: z.array(ArtifactId),
});
export type Artifact = z.infer<typeof Artifact>;
