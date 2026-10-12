import { z } from "zod";
import { AgentId } from "../ids.js";

/** Ranges from docs/design/vitality-and-merit.md. */
export const Vitality = z.strictObject({
	agent: AgentId,
	load: z.number().nonnegative(),
	fatigue: z.number().nonnegative(),
	friction: z.number().min(0).max(1),
	confidence: z.number().min(0).max(1),
	morale: z.number(),
});
export type Vitality = z.infer<typeof Vitality>;

export const Mood = z.enum([
	"fresh",
	"focused",
	"strained",
	"overloaded",
	"discouraged",
	"resting",
]);
export type Mood = z.infer<typeof Mood>;

export const Policy = z.strictObject({
	mayAcceptTasks: z.boolean(),
	mayOfferHelp: z.boolean(),
	mustHandOff: z.boolean(),
	mustRequestHelp: z.boolean(),
	mustNameBlocker: z.boolean(),
	schedulable: z.boolean(),
});
export type Policy = z.infer<typeof Policy>;
