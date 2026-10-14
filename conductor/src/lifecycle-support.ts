import type { Seq } from "./ids.js";
import type { EventActor } from "./types/actor.js";

/**
 * Who appends an Event, and the cause it names when that cause lies outside
 * the verb's domain. Without one, the verb names the cause the Projections
 * give. Whether the Conductor may append it is the guards' to say.
 */
export type Origin = {
	readonly actor: EventActor;
	readonly causation_id?: Seq | undefined;
};

/** What a lifecycle verb returns: the entity as its Event left it, and the Event's seq. */
export type Recorded<Name extends string, T> = {
	readonly [K in Name]: T;
} & { readonly seq: Seq };

/**
 * What a verb's Event left in a Projection, read back after the append. It is
 * missing only when a Projection failed to apply an Event the Ledger accepted.
 */
export const readBack = <T>(value: T | undefined, what: string): T => {
	if (value === undefined) throw new Error(`${what} vanished`);
	return value;
};
