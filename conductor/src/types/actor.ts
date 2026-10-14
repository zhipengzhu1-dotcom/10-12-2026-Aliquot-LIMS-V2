import { z } from "zod";
import { AgentId } from "../ids.js";

/** A person's email, lowercased: the person the Operator is (ADR-0019). */
export const Email = z
	.string()
	.regex(/^[^\s@A-Z]+@[^\s@A-Z]+$/, "must be an email, lowercased")
	.brand<"Email">();
export type Email = z.infer<typeof Email>;

/** `text` as an Email, ignoring case and surrounding space, or undefined. */
export const emailOf = (text: string): Email | undefined => {
	const parsed = Email.safeParse(text.trim().toLowerCase());
	return parsed.success ? parsed.data : undefined;
};

/**
 * The Operator, named by the person's email. An Event written before #74
 * names no email and reads as the unnamed Operator (ADR-0019), and a payload
 * that only refers to the Operator, such as a reviewer to be, may name none.
 */
export const Operator = z.strictObject({
	tag: z.literal("Operator"),
	email: Email.optional(),
});
export type Operator = z.infer<typeof Operator>;

/** The Operator as the person who acts: what every new Event by the Operator names. */
export type Person = { readonly tag: "Operator"; readonly email: Email };

export const person = (email: Email): Person => ({ tag: "Operator", email });

/** An Agent or the Operator: who reviews, requests, escalates, and talks. */
export const Actor = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Agent"), id: AgentId }),
	Operator,
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

/**
 * `Operator`, `Conductor`, or the Agent's id: the role an actor plays, as
 * rules and refusals name it. Every person acting as the Operator plays one role.
 */
export const actorText = (actor: EventActor): string =>
	actor.tag === "Agent" ? actor.id : actor.tag;

/**
 * Whether two actors play one role: the same Agent, the Conductor, or the
 * Operator whoever the person, so a Review by any person acting as the
 * Operator is the Review a Task waiting on the Operator needs.
 */
export const sameRole = (a: EventActor, b: EventActor): boolean =>
	actorText(a) === actorText(b);

/** How an Event written before #74 names its Operator. */
export const UNNAMED_OPERATOR = "Operator (unnamed)";

/** Who did an act: the Agent's id, `Conductor`, or the Operator's email. */
export const actorName = (actor: EventActor): string =>
	actor.tag === "Operator"
		? (actor.email ?? UNNAMED_OPERATOR)
		: actorText(actor);
