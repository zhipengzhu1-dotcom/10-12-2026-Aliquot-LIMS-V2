import type { Event, EventKind, NewEvent } from "./events.js";
import type { Projections } from "./projections.js";
import { Refusal } from "./reduce.js";

// Domain guards import from here, not from guards.ts: guards.ts imports every
// domain's guards, so importing it back from a domain would be a cycle.

/**
 * Runs before an Event is written, given the Projections as they stand
 * before it. Returns why the Ledger must refuse the Event, naming the ids
 * involved, or undefined to let it through. The Ledger words the refusal as
 * `<Kind> refused: <reason>`. A guard never throws and never reads the clock.
 */
export type AppendGuard = (
	projections: Projections,
	event: Event,
) => string | undefined;

/**
 * The Events an append requires after its cause, given the Projections with
 * the cause applied. The Ledger writes them in the same transaction, through
 * the same guards, and writes none of them, nor the cause, if any is refused.
 */
export type FollowOn = (projections: Projections, cause: Event) => NewEvent[];

/**
 * The Events a Ledger is missing, given its Projections. The Ledger writes
 * them when it opens for writing, before any caller appends, in their own
 * transaction and through the same guards.
 */
export type CatchUp = (projections: Projections) => NewEvent[];

/** The Ledger refused an append. Nothing was written. */
export class AppendRefused extends Error {
	override readonly name = "AppendRefused";
}

/** The one wording of every refusal: `<Kind> refused: <reason>`. */
export const refusalText = (kind: string, reason: string) =>
	`${kind} refused: ${reason}`;

/**
 * The value, or the refusal of `kind` thrown before anything is appended, for
 * a lifecycle verb that needs the value to build its Event.
 */
export const orRefuse = <T>(kind: EventKind, value: T | Refusal): T => {
	if (value instanceof Refusal) {
		throw new AppendRefused(refusalText(kind, value.reason));
	}
	return value;
};
