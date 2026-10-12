import { z } from "zod";
import { AgentId } from "../ids.js";

/**
 * Who appends an Event. `Conductor` authors only the tier Revisions that
 * Merit and Gates require (ADR-0011); no command line can act as it.
 */
export const Actor = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Agent"), id: AgentId }),
	z.strictObject({ tag: z.literal("Operator") }),
	z.strictObject({ tag: z.literal("Conductor") }),
]);
export type Actor = z.infer<typeof Actor>;

/** `Operator`, `Conductor`, or the Agent's id: how messages and listings name an Actor. */
export const actorText = (actor: Actor): string =>
	actor.tag === "Agent" ? actor.id : actor.tag;
