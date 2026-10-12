import type { Event } from "./events.js";

/**
 * One step of a Projection. Must be pure: no clock, no randomness, no I/O,
 * and no mutation of `state`. A function that needs "now" takes it as a
 * parameter outside the reducer.
 */
export type Reducer<T> = (state: T, event: Event) => T;

/** State computed from the Ledger, never stored as truth. */
export type Projection<T> = {
	readonly init: T;
	readonly reduce: Reducer<T>;
};

/** Fold Events, in the order given, into a Projection's state. */
export const fold = <T>(
	events: Iterable<Event>,
	reducer: Reducer<T>,
	init: T,
): T => {
	let state = init;
	for (const event of events) state = reducer(state, event);
	return state;
};
