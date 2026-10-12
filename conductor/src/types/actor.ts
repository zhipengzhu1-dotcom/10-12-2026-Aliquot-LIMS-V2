import { z } from "zod";
import { AgentId } from "../ids.js";

export const Actor = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Agent"), id: AgentId }),
	z.strictObject({ tag: z.literal("Operator") }),
]);
export type Actor = z.infer<typeof Actor>;
