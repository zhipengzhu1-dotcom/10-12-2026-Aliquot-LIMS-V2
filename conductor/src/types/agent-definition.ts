import { z } from "zod";
import { AgentId, SkillId } from "../ids.js";
import { Actor } from "./actor.js";
import { TrustTier } from "./merit.js";

export const Role = z.enum([
	"Director",
	"Steward",
	"Auditor",
	"Supervisor",
	"Specialist",
	"Developer",
	"Tester",
]);
export type Role = z.infer<typeof Role>;

export const AgentDefinition = z.strictObject({
	id: AgentId,
	version: z.number().int().positive(),
	name: z.string().min(1),
	role: Role,
	supervisor_id: AgentId.optional(),
	persona: z.strictObject({
		voice: z.string(),
		traits: z.array(z.string()),
		quirk: z.string(),
	}),
	charter: z.strictObject({
		purpose: z.string(),
		responsibilities: z.array(z.string()),
		forbidden: z.array(z.string().min(1)),
		escalation: z.string(),
	}),
	tools: z.array(z.string().min(1)),
	skills: z.array(SkillId),
	memory_ref: z.string().min(1),
	model: z.string().min(1),
	capacity: z.number().int().positive(),
	trust_tier: TrustTier,
	revised_by: Actor,
	revision_reason: z.string().min(1),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;
