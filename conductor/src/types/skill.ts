import { z } from "zod";
import { AgentId, SkillId, TaskId } from "../ids.js";
import { Actor } from "./actor.js";

export const Skill = z.strictObject({
	id: SkillId,
	version: z.number().int().positive(),
	title: z.string().min(1),
	body_md: z.string(),
	author: Actor,
});
export type Skill = z.infer<typeof Skill>;

export const MemoryNote = z.strictObject({
	agent: AgentId,
	task_id: TaskId,
	lesson: z.string().min(1),
	applies_to: z.array(z.string()),
});
export type MemoryNote = z.infer<typeof MemoryNote>;
