import { z } from "zod";
import {
	AgentId,
	ArtifactId,
	EvaluationId,
	RunId,
	ScriptId,
	Sha256,
} from "../ids.js";
import { ArtifactType } from "./artifact.js";

export const Script = z.strictObject({
	id: ScriptId,
	version: z.number().int().positive(),
	name: z.string().min(1),
	owner_agent: AgentId,
	input_types: z.array(ArtifactType),
	output_types: z.array(ArtifactType),
	entrypoint: z.string().min(1),
	fixtures: z.array(ArtifactId),
	image_digest: Sha256,
});
export type Script = z.infer<typeof Script>;

export const ScriptRef = z.strictObject({
	id: ScriptId,
	version: z.number().int().positive(),
});
export type ScriptRef = z.infer<typeof ScriptRef>;

export const Run = z.strictObject({
	id: RunId,
	script: ScriptRef,
	inputs: z.array(ArtifactId),
	outputs: z.array(ArtifactId),
	exit_code: z.number().int(),
	stdout_ref: ArtifactId,
	stderr_ref: ArtifactId,
	duration_ms: z.number().nonnegative(),
	eval_id: EvaluationId.optional(),
});
export type Run = z.infer<typeof Run>;
