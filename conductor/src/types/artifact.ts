import { z } from "zod";
import { ArtifactId, RunId, Sha256 } from "../ids.js";
import { Operator } from "./actor.js";

export const ArtifactType = z.enum([
	"SubmissionForm",
	"SubmissionRecord",
	"ReceivingLogRow",
	"LimsDatabase",
	"WorkOrder",
	"ResultWorksheet",
	"VerificationRecord",
	"ReportOfAnalysis",
	"ReceivingLog",
	"ShadowReceivingLog",
	"Comparison",
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
		Operator,
	]),
	lineage: z.array(ArtifactId),
});
export type Artifact = z.infer<typeof Artifact>;

/**
 * Where an Artifact's bytes sat when they were stored: a relative POSIX path
 * such as `submission_form.docx` or `tables/lots.csv`. Never absolute, never
 * `..`, so staging it under a directory stays inside that directory.
 */
export const ArtifactFilename = z
	.string()
	.min(1)
	.refine(
		(name) =>
			!name.startsWith("/") &&
			!/[\\\0]/.test(name) &&
			name
				.split("/")
				.every((part) => part !== "" && part !== "." && part !== ".."),
		{ message: "must be a relative path without '.', '..', or empty segments" },
	);
export type ArtifactFilename = z.infer<typeof ArtifactFilename>;

/**
 * The ArtifactStored payload: the Artifact plus the filename its bytes had the
 * first time they were stored. Content addressing keeps the first filename.
 */
export const StoredArtifact = Artifact.extend({
	filename: ArtifactFilename.optional(),
});
export type StoredArtifact = z.infer<typeof StoredArtifact>;
