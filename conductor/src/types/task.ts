import { z } from "zod";
import { AgentId, ArtifactId, GateId, RubricId, TaskId } from "../ids.js";
import { Actor } from "./actor.js";

export const TaskState = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Proposed") }),
	z.strictObject({ tag: z.literal("Assigned"), assignee: AgentId }),
	z.strictObject({ tag: z.literal("InProgress"), assignee: AgentId }),
	z.strictObject({
		tag: z.literal("UnderReview"),
		assignee: AgentId,
		reviewer: Actor,
	}),
	z.strictObject({
		tag: z.literal("Blocked"),
		assignee: AgentId,
		gate: GateId,
	}),
	z.strictObject({ tag: z.literal("Escalated"), to: Actor }),
	z.strictObject({ tag: z.literal("Failed"), reason: z.string() }),
	z.strictObject({ tag: z.literal("Done"), assignee: AgentId }),
]);
export type TaskState = z.infer<typeof TaskState>;

export const TatClass = z.enum(["Regular", "Rush1to2Days", "Rush3to4Days"]);
export type TatClass = z.infer<typeof TatClass>;

/** The Submission Form's TAT codes and the TatClass each names (GLOSSARY.md). */
export const TAT_CODES = {
	"1": "Regular",
	"2": "Rush1to2Days",
	"3": "Rush3to4Days",
} as const satisfies Record<string, TatClass>;

export const Task = z.strictObject({
	id: TaskId,
	title: z.string().min(1),
	goal: z.string(),
	inputs: z.array(ArtifactId),
	outputs: z.array(ArtifactId),
	state: TaskState,
	rubric_id: RubricId,
	priority: z.number().int(),
	tat_class: TatClass,
	parent_task: TaskId.optional(),
});
export type Task = z.infer<typeof Task>;
