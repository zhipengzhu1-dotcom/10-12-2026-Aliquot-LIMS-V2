const ENTITIES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Text safe to put in markup: a Message body is anyone's words. */
export const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);

/** An actor as the API sends it: an Agent's id, or the Operator's email when the Event names one. */
export type ActorJson = {
	readonly tag: string;
	readonly id?: string;
	readonly email?: string;
};

/** How an Event written before #74 names its Operator (ADR-0019). */
export const UNNAMED_OPERATOR = "Operator (unnamed)";

/** Who did an act: the Agent's id, `Conductor`, or the Operator's email. */
export const actorName = (actor: ActorJson): string =>
	actor.tag === "Operator"
		? (actor.email ?? UNNAMED_OPERATOR)
		: (actor.id ?? actor.tag);
