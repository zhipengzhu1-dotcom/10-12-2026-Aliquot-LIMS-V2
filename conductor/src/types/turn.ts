import { z } from "zod";

const tokens = z.number().int().nonnegative();

/** What the model reports a Turn used. */
export const TurnUsage = z.strictObject({
	input_tokens: tokens,
	output_tokens: tokens,
	cache_creation_tokens: tokens,
	cache_read_tokens: tokens,
	cost_usd: z.number().nonnegative(),
});
export type TurnUsage = z.infer<typeof TurnUsage>;

/** How a Turn ended: it completed, or it reached a cap, or it failed. */
export const TurnOutcome = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Completed") }),
	z.strictObject({ tag: z.literal("MaxTurns") }),
	z.strictObject({ tag: z.literal("Budget") }),
	z.strictObject({ tag: z.literal("Error"), message: z.string().min(1) }),
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;
