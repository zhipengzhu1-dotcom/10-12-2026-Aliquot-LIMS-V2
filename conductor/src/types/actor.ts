import { z } from "zod";
import { AgentId } from "../ids.js";

export const Actor = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Agent"), id: AgentId }),
	z.strictObject({ tag: z.literal("Operator") }),
]);
export type Actor = z.infer<typeof Actor>;

/** `Operator`, or the Agent's id: how messages and listings name an Actor. */
export const actorText = (actor: Actor): string =>
	actor.tag === "Operator" ? "Operator" : actor.id;
