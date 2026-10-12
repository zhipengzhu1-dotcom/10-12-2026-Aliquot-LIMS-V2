import type { Event } from "./events.js";

// Domain guards import from here, not from guards.ts: guards.ts imports every
// domain's guards, so importing it back from a domain would be a cycle.

/** What a guard sees: every Event already in the Ledger, in seq order. */
export type GuardContext = {
	readonly events: readonly Event[];
};

/**
 * Runs before an Event is written. Throws `AppendRefused` to stop the append;
 * the message names the reason and the current state. Guards build whatever
 * Projection they need from `ctx.events` and never read the clock.
 */
export type AppendGuard = (ctx: GuardContext, event: Event) => void;

/** The Ledger refused an append. Nothing was written. */
export class AppendRefused extends Error {
	override readonly name = "AppendRefused";
}
