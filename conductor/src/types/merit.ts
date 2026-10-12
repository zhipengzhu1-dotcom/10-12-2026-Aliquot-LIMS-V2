import { z } from "zod";
import { TaskId } from "../ids.js";
import { Actor } from "./actor.js";

export const Score = z.literal([0, 1, 2, 3]);
export type Score = z.infer<typeof Score>;

export const Review = z.strictObject({
	task_id: TaskId,
	reviewer: Actor,
	quality: Score,
	traceability: Score,
	boundary_adherence: Score,
	collaboration: Score,
	timeliness: Score,
	note: z.string(),
});
export type Review = z.infer<typeof Review>;

export const TrustTier = z.enum(["Probation", "Trusted", "Senior", "Mentor"]);
export type TrustTier = z.infer<typeof TrustTier>;
