import { z } from "zod";
import { AgentId } from "../ids.js";

/** An Agent or the Operator: who reviews, requests, escalates, and talks. */
export const Actor = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Agent"), id: AgentId }),
	z.strictObject({ tag: z.literal("Operator") }),
]);
export type Actor = z.infer<typeof Actor>;

/**
 * Who appends an Event: an Actor, or the `Conductor`, which authors only the
 * tier Revisions that Merit and Gates require (ADR-0011) and the records of
 * its own acts, such as Turns (ADR-0013). No payload field but `revised_by`
 * can name the Conductor, and no command line can act as it.
 */
export const EventActor = z.discriminatedUnion("tag", [
	...Actor.options,
	z.strictObject({ tag: z.literal("Conductor") }),
]);
export type EventActor = z.infer<typeof EventActor>;

/** `Operator`, `Conductor`, or the Agent's id: how messages and listings name an actor. */
export const actorText = (actor: EventActor): string =>
	actor.tag === "Agent" ? actor.id : actor.tag;
