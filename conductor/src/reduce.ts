import type { Event } from "./events.js";
import type { Projections } from "./projections.js";

/** Why an Event cannot be applied. Returned, never thrown. */
export class Refusal {
	constructor(readonly reason: string) {}
}

/**
 * One step of a Projection. Must be pure: no clock, no randomness, no I/O,
 * and no mutation of `state`. `ledger` holds every Projection as it stood
 * before `event`, so one Projection may read another. An Event the
 * Projection cannot apply gets a Refusal, never a silent skip: the Ledger
 * refuses to append it, and reports a Ledger that holds it as corrupt.
 */
export type Reducer<T> = (
	state: T,
	event: Event,
	ledger: Projections,
) => T | Refusal;

/** State computed from the Ledger, never stored as truth. */
export type Projection<T> = {
	readonly init: T;
	readonly reduce: Reducer<T>;
};
