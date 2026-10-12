import { z } from "zod";

const hex64 = /^[0-9a-f]{64}$/;

/** Lowercase hex sha256 digest. */
export const Sha256 = z.string().regex(hex64).brand<"Sha256">();
export type Sha256 = z.infer<typeof Sha256>;

/** Position of an Event in the Ledger, starting at 1. */
export const Seq = z.number().int().positive().brand<"Seq">();
export type Seq = z.infer<typeof Seq>;

/** ISO 8601 UTC timestamp, as `Date.prototype.toISOString` writes it. */
export const IsoTime = z.iso.datetime().brand<"IsoTime">();
export type IsoTime = z.infer<typeof IsoTime>;

/** `A-<slug>`, for example `A-odile`. */
export const AgentId = z
	.string()
	.regex(/^A-[a-z0-9][a-z0-9-]*$/)
	.brand<"AgentId">();
export type AgentId = z.infer<typeof AgentId>;

/** `T-<n>`. */
export const TaskId = z
	.string()
	.regex(/^T-[0-9]+$/)
	.brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

/** `G-<n>`. */
export const GateId = z
	.string()
	.regex(/^G-[0-9]+$/)
	.brand<"GateId">();
export type GateId = z.infer<typeof GateId>;

/** `S-<name>`, for example `S-parse_submission`. */
export const ScriptId = z
	.string()
	.regex(/^S-[a-z0-9][a-z0-9_-]*$/)
	.brand<"ScriptId">();
export type ScriptId = z.infer<typeof ScriptId>;

/** `R-<n>`. */
export const RunId = z
	.string()
	.regex(/^R-[0-9]+$/)
	.brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

/** The sha256 hex of the Artifact's bytes, so the same bytes give one id. */
export const ArtifactId = z.string().regex(hex64).brand<"ArtifactId">();
export type ArtifactId = z.infer<typeof ArtifactId>;

export const RubricId = z.string().min(1).brand<"RubricId">();
export type RubricId = z.infer<typeof RubricId>;

export const SkillId = z.string().min(1).brand<"SkillId">();
export type SkillId = z.infer<typeof SkillId>;

export const EvaluationId = z.string().min(1).brand<"EvaluationId">();
export type EvaluationId = z.infer<typeof EvaluationId>;
